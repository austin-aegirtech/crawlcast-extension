/**
 * Video Downloader
 * Downloads segments, transmuxes TS→MP4, collects into an MP4 Blob.
 * Runs in the offscreen document (offscreen.html), which loads
 * lib/mux.min.js and m3u8-parser.js via <script> tags.
 */

class VideoDownloader {
  constructor(options = {}) {
    this.onProgress = options.onProgress || (() => {});
    this.onComplete = options.onComplete || (() => {});
    this.onError = options.onError || (() => {});
    
    this.parser = new M3U8Parser();
    this.abortController = new AbortController();
    this.stats = {
      totalSegments: 0,
      downloaded: 0,
      failed: 0,
      bytesDownloaded: 0
    };
    
    // Fetch concurrency: how many segment downloads run in parallel.
    // Safe because only *fetching* is parallel — segments are pushed
    // through the shared transmuxer and written strictly in order.
    this.concurrency = 4;

    // Per-attempt segment fetch timeout (ms). Guards against servers that
    // accept the connection then never send data.
    console.log('OPTIONS :::', JSON.stringify(options));
    this.segmentTimeoutMs = options.segmentTimeoutMs || 30000;

    // Refuse in-browser downloads above this estimated size. Chunks plus the
    // final Blob roughly double the footprint, and a renderer that exceeds
    // its heap is killed silently — no error, no file, a stuck UI.
    this.memoryLimitBytes = options.memoryLimitBytes || 1.5e9; // ~1.5 GB
  }

  /**
   * Start download process
   */
  async download(m3u8Url, filename = 'video.mp4') {
    try {
      console.log('[Downloader] Starting download from:', m3u8Url);
      
      // Step 1: Fetch and parse master playlist
      const playlist = await this.fetchPlaylist(m3u8Url);
      
      // Step 2: If master playlist, get best quality media playlist
      let mediaPlaylist = playlist;
      let bandwidth = null;
      let audioRendition = null;
      if (playlist.isMaster) {
        const bestVariant = this.parser.selectBestVariant(playlist.variants);
        bandwidth = bestVariant.bandwidth;
        console.log('[Downloader] Selected quality:', bestVariant.resolution,
                    `@ ${Math.round(bestVariant.bandwidth / 1000)}kbps`);

        // When the variant points at an AUDIO group, its segments are
        // video-only. Downloading just those yields a silent file — the
        // audio rendition has to be fetched and merged separately.
        audioRendition = this.parser.selectAudioRendition(playlist, bestVariant);

        // Log the decision either way — a silent download is almost always
        // explained by one of these branches
        const audioTracks = playlist.media.filter(m => m.type === 'AUDIO');
        if (audioRendition) {
          console.log('[Audio] Separate track selected:',
                      audioRendition.name || audioRendition.language || 'default',
                      audioRendition.channels ? `(${audioRendition.channels}ch)` : '',
                      audioRendition.url);
        } else if (bestVariant.audioGroup && audioTracks.length) {
          console.warn(`[Audio] Variant references AUDIO group "${bestVariant.audioGroup}" ` +
                       `but no matching rendition has a URI ` +
                       `(${audioTracks.length} audio tag(s) found) — audio may be muxed.`);
        } else if (bestVariant.audioGroup) {
          console.warn(`[Audio] Variant references AUDIO group "${bestVariant.audioGroup}" ` +
                       `but master declares no EXT-X-MEDIA audio tags. Download will be silent.`);
        } else {
          console.log(`[Audio] No AUDIO group on the selected variant — ` +
                      `expecting audio muxed into the video segments. ` +
                      `(master declares ${playlist.media.length} EXT-X-MEDIA tag(s))`);
        }

        mediaPlaylist = await this.fetchPlaylist(bestVariant.url);
      } else {
        console.warn('[Audio] This is a MEDIA playlist, not a master. Separate audio ' +
                     'renditions are only declared in the master playlist, so none can ' +
                     'be detected. If the result is silent, download the master instead.');
      }

      // Step 2b: Guard against downloads too large to hold in memory.
      // Everything is buffered as chunks and then copied into a Blob, so
      // peak usage is roughly 2x the video size in one renderer process.
      const estimate = this.estimateSize(mediaPlaylist, bandwidth);
      if (estimate.bytes > this.memoryLimitBytes) {
        const err = new Error(
          `Video is too large for in-browser download ` +
          `(~${(estimate.bytes / 1e9).toFixed(1)} GB over ${mediaPlaylist.segments.length} segments). ` +
          `Use the External downloader, which streams straight to disk.`
        );
        err.tooLarge = true;
        err.estimate = estimate;
        throw err;
      }

      // Step 3: Initialize MP4 transmuxer
      const transmuxer = this.initializeTransmuxer();

      // Step 4: Collect transmuxed MP4 fragments in memory
      // (StreamSaver needs a DOM+iframe and can't run here; the final Blob
      //  is handed to chrome.downloads via the background service worker)
      const chunks = [];
      const writer = {
        write: async (data) => { chunks.push(data); },
        close: async () => {}
      };

      // Step 5: Download and process segments
      await this.downloadSegments(mediaPlaylist.segments, transmuxer, writer);

      // Step 6: Finalize — assembling a multi-GB Blob takes real time,
      // so tell the UI rather than sitting at 100% looking frozen
      this.reportProgress('finalizing');
      await writer.close();

      // Patch the total duration into the init segment (mvhd/tkhd/mdhd) —
      // mux.js writes "unknown" durations, which breaks the seek bar in players
      const totalDuration = mediaPlaylist.segments.reduce(
        (sum, s) => sum + (s.duration || 0), 0);
      if (chunks.length > 0 && totalDuration > 0) {
        this.patchInitSegmentDuration(chunks[0], totalDuration);
      }

      const blob = new Blob(chunks, { type: 'video/mp4' });
      chunks.length = 0; // release fragment buffers — the Blob holds its own copy

      // Step 7: separate audio track, if this stream has one
      let audioBlob = null;
      if (audioRendition) {
        try {
          audioBlob = await this.downloadAudioTrack(audioRendition);
        } catch (e) {
          console.error('[Downloader] Audio track failed:', e);
          // Deliberately non-fatal: a silent video the user is warned about
          // beats losing the whole download
        }
      }

      this.onComplete({
        filename,
        stats: this.stats,
        blob,
        audioBlob,
        // Tells the pipeline the two streams still need merging
        needsAudioMerge: !!audioBlob,
        audioTrackName: audioRendition
          ? (audioRendition.name || audioRendition.language || 'audio')
          : null,
        audioMissing: !!audioRendition && !audioBlob
      });
      
    } catch (error) {
      console.error('[Downloader] Error:', error);
      this.onError(error);
    }
  }

  /**
   * Fetch and parse m3u8 playlist
   */
  async fetchPlaylist(url) {
    console.log('fetchPlaylist :::');
    const response = await fetch(url, {
      signal: this.abortController.signal
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const content = await response.text();
    return this.parser.parse(content, url);
  }

  /**
   * Initialize mux.js transmuxer
   * Converts MPEG-TS segments to MP4 fragments
   */
  initializeTransmuxer() {
    const transmuxer = new muxjs.mp4.Transmuxer({
      keepOriginalTimestamps: false, // rebase timestamps to 0 so the timeline starts at t=0
      remux: true // Remux to MP4 container
    });

    // Handle transmuxed data
    const initSegments = [];
    let hasSentInit = false;

    transmuxer.on('data', (segment) => {
      // Collect init segment (moov box) - only needed once
      if (!hasSentInit && segment.initSegment) {
        initSegments.push(segment.initSegment);
        hasSentInit = true;
      }
      
      // Return transmuxed MP4 data
      return {
        init: initSegments,
        data: segment.data
      };
    });

    return transmuxer;
  }

  /**
   * Download segments: parallel fetching, strictly ordered processing.
   * A sliding window of up to `concurrency` fetches runs ahead, while
   * transmuxing/writing consumes results in playlist order (required —
   * the shared transmuxer corrupts output if segments arrive out of order).
   */
  async downloadSegments(segments, transmuxer, writer) {
    this.stats.totalSegments = segments.length;

    const pending = new Map(); // index -> Promise<ArrayBuffer|null>

    for (let i = 0; i < segments.length; i++) {
      if (this.abortController.signal.aborted) break;

      // Keep the fetch window full
      const windowEnd = Math.min(i + this.concurrency, segments.length);
      for (let j = i; j < windowEnd; j++) {
        if (!pending.has(j)) {
          pending.set(j, this.fetchSegmentWithRetry(segments[j], j));
        }
      }

      // Consume in order
      const arrayBuffer = await pending.get(i);
      pending.delete(i);
      if (arrayBuffer === null) continue; // failed after retries — skip segment

      // Check if it's TS format (typical for HLS)
      const isTS = this.isTransportStream(arrayBuffer);

      let mp4Data;
      if (isTS) {
        // Transmux TS to MP4
        mp4Data = await this.transmuxSegment(arrayBuffer, transmuxer, i === 0);
      } else {
        // Already MP4 or other format, pass through
        mp4Data = new Uint8Array(arrayBuffer);
      }

      await writer.write(mp4Data);

      this.stats.downloaded++;
      this.reportProgress();
    }
  }

  /**
   * Download a separate audio rendition and transmux it to fMP4.
   *
   * Uses its own transmuxer instance — audio and video are independent
   * elementary streams and must not share transmuxer state. The two are
   * merged into one file later by ffmpeg via the native host.
   *
   * @returns {Promise<Blob>} audio-only MP4
   */
  async downloadAudioTrack(rendition) {
    console.log('[Downloader] Fetching audio playlist:', rendition.url);
    const audioPlaylist = await this.fetchPlaylist(rendition.url);

    if (!audioPlaylist.segments.length) {
      throw new Error('Audio playlist contains no segments');
    }

    const transmuxer = this.initializeTransmuxer();
    const chunks = [];
    const writer = {
      write: async (data) => { chunks.push(data); },
      close: async () => {}
    };

    // Track audio progress separately so the UI can show a distinct phase
    const total = audioPlaylist.segments.length;
    let done = 0;

    for (let i = 0; i < audioPlaylist.segments.length; i++) {
      if (this.abortController.signal.aborted) break;

      const buf = await this.fetchSegmentWithRetry(audioPlaylist.segments[i], i);
      if (buf === null) continue; // skip, same policy as video

      const view = new Uint8Array(buf);
      const isTS = view[0] === 0x47 && view[188] === 0x47;
      // Raw ADTS AAC starts with a 0xFFFx syncword — common for HLS audio
      // renditions and handled differently from TS
      const isAdts = view[0] === 0xFF && (view[1] & 0xF0) === 0xF0;

      if (i === 0) {
        console.log(`[Audio] Segment format: ${isTS ? 'MPEG-TS' : isAdts ? 'raw ADTS AAC' : 'unknown/fMP4'}` +
                    ` (first bytes ${view[0].toString(16)} ${view[1].toString(16)})`);
      }

      const data = isTS
        ? await this.transmuxSegment(buf, transmuxer, i === 0)
        : new Uint8Array(buf);

      await writer.write(data);
      done++;

      if (done % 10 === 0 || done === total) {
        this.onProgress({
          percent: Math.floor((done / total) * 100),
          phase: 'audio',
          downloaded: done,
          total,
          failed: 0,
          mbDownloaded: (this.stats.bytesDownloaded / 1024 / 1024).toFixed(2)
        });
      }
    }

    await writer.close();

    const totalDuration = audioPlaylist.segments.reduce(
      (sum, s) => sum + (s.duration || 0), 0);
    if (chunks.length > 0 && totalDuration > 0) {
      this.patchInitSegmentDuration(chunks[0], totalDuration);
    }

    const blob = new Blob(chunks, { type: 'audio/mp4' });
    chunks.length = 0;
    console.log('[Downloader] Audio track complete:', blob.size, 'bytes');
    return blob;
  }

  /**
   * Estimate final size from playlist duration and the variant's bandwidth,
   * falling back to a conservative per-segment average when bandwidth is
   * unknown. Only needs to be accurate enough to catch multi-GB videos.
   */
  estimateSize(playlist, bandwidth) {
    const seconds = playlist.segments.reduce((sum, s) => sum + (s.duration || 0), 0);
    const bytes = bandwidth && seconds
      ? (bandwidth / 8) * seconds
      : playlist.segments.length * 400 * 1024; // ~400 KB/segment fallback
    return { bytes, seconds, segments: playlist.segments.length };
  }

  /**
   * Fetch a single segment with retries and exponential backoff.
   * @returns {Promise<ArrayBuffer|null>} null if all attempts failed
   */
  async fetchSegmentWithRetry(segment, index) {
    const maxRetries = 20;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      // Per-attempt timeout. Without this a server that accepts the
      // connection but never responds hangs the await forever — the retry
      // logic never fires and the whole download stalls silently.
      const timeoutController = new AbortController();
      const timer = setTimeout(() => timeoutController.abort(), this.segmentTimeoutMs);

      // Abort if EITHER the user cancels or this attempt times out
      const signal = (typeof AbortSignal !== 'undefined' && AbortSignal.any)
        ? AbortSignal.any([this.abortController.signal, timeoutController.signal])
        : timeoutController.signal;

      try {
        console.log(`[Downloader] Fetching segment ${index + 1}/${this.stats.totalSegments}`);

        const response = await fetch(segment.url, {
          signal,
          headers: {
            'Accept': '*/*',
            'Accept-Encoding': 'identity',
            'Referer': self.location?.href || ''
          }
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const arrayBuffer = await response.arrayBuffer();
        this.stats.bytesDownloaded += arrayBuffer.byteLength;
        return arrayBuffer;

      } catch (error) {
        if (this.abortController.signal.aborted) return null; // user cancelled
        const timedOut = timeoutController.signal.aborted;
        console.warn(
          `[Downloader] Segment ${index} failed (attempt ${attempt})`,
          timedOut ? `— timed out after ${this.segmentTimeoutMs}ms` : error
        );

        if (attempt >= maxRetries) {
          this.stats.failed++;
          console.error(`[Downloader] Failed to download segment ${index} after ${maxRetries} attempts`);
          return null;
        }
        // Exponential backoff
        await this.delay(1000 * attempt);
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  }

  /**
   * Write the real movie duration into the init segment in-place.
   * mux.js emits fragmented MP4 with duration = "unknown" in mvhd/tkhd/mdhd;
   * without it, players can't render a seek bar and snap back to 0 on seek.
   * Walks top-level boxes (ftyp, moov, then moof/mdat which are skipped)
   * and patches the version-0 duration fields using each box's own timescale.
   * @param {Uint8Array} bytes - first output chunk (starts with ftyp+moov)
   * @param {number} durationSeconds - sum of #EXTINF durations
   */
  patchInitSegmentDuration(bytes, durationSeconds) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let movieTimescale = 90000; // mux.js default; re-read from mvhd below

    const walk = (start, end) => {
      let offset = start;
      while (offset + 8 <= end) {
        const size = view.getUint32(offset);
        if (size < 8) break;
        const type = String.fromCharCode(
          bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
        const boxEnd = Math.min(offset + size, end);

        if (type === 'moov' || type === 'trak' || type === 'mdia') {
          walk(offset + 8, boxEnd); // container boxes: recurse
        } else if (type === 'mvhd' && bytes[offset + 8] === 0) {
          // v0 layout: [8]=version, [20]=timescale, [24]=duration
          movieTimescale = view.getUint32(offset + 20);
          view.setUint32(offset + 24, Math.floor(durationSeconds * movieTimescale));
        } else if (type === 'tkhd' && bytes[offset + 8] === 0) {
          // v0 layout: [28]=duration (in movie timescale)
          view.setUint32(offset + 28, Math.floor(durationSeconds * movieTimescale));
        } else if (type === 'mdhd' && bytes[offset + 8] === 0) {
          // v0 layout: [20]=timescale (track-local), [24]=duration
          const trackTimescale = view.getUint32(offset + 20);
          view.setUint32(offset + 24, Math.floor(durationSeconds * trackTimescale));
        }

        offset += size;
      }
    };

    walk(0, bytes.byteLength);
  }

  /**
   * Check if buffer is MPEG-TS format
   * TS files start with sync byte 0x47
   */
  isTransportStream(buffer) {
    const view = new Uint8Array(buffer);
    // Check first byte and packet size pattern
    return view[0] === 0x47 && view[188] === 0x47;
  }

  /**
   * Transmux single segment using mux.js
   */
  transmuxSegment(tsData, transmuxer, isFirstSegment) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      
      // Setup one-time data handler
      const onData = (segment) => {
        // Send init segment with first data segment
        if (isFirstSegment && segment.initSegment) {
          chunks.push(segment.initSegment);
        }
        chunks.push(segment.data);
      };

      const onDone = () => {
        transmuxer.off('data', onData);
        transmuxer.off('done', onDone);
        
        // Combine chunks
        const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        const combined = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          combined.set(chunk, offset);
          offset += chunk.byteLength;
        }
        resolve(combined);
      };

      transmuxer.on('data', onData);
      transmuxer.on('done', onDone);

      // Push data to transmuxer
      transmuxer.push(new Uint8Array(tsData));
      transmuxer.flush();
    });
  }

  /**
   * Report download progress
   */
  reportProgress(phase = 'downloading') {
    const processed = this.stats.downloaded + this.stats.failed;
    // Floor, and never show 100% until every segment is accounted for —
    // Math.round made 4127/4130 display as "100%" for the last 20 segments
    let percent = Math.floor((processed / this.stats.totalSegments) * 100);
    if (percent >= 100 && processed < this.stats.totalSegments) percent = 99;

    const mbDownloaded = (this.stats.bytesDownloaded / 1024 / 1024).toFixed(2);

    this.onProgress({
      percent,
      phase,
      downloaded: this.stats.downloaded,
      total: this.stats.totalSegments,
      failed: this.stats.failed,
      mbDownloaded
    });
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Cancel download
   */
  cancel() {
    this.abortController.abort();
  }
}