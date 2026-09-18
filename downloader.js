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
    this.concurrency = 2;

    // Segment retries share a cooldown so a temporary CDN/server failure
    // does not cause the rest of the fetch window to keep hammering it.
    this.retryPauseUntil = 0;
    this.maxSegmentAttempts = options.maxSegmentAttempts || 20;
    this.maxRetryDelayMs = options.maxRetryDelayMs || 15000;
    this.retryableHttpStatuses = new Set([429, 500, 502, 503, 504]);

    // Per-attempt segment fetch timeout (ms). Guards against servers that
    // accept the connection then never send data.
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
          `This exceeds the in-browser memory limit.`
        );
        err.tooLarge = true;
        err.estimate = estimate;
        throw err;
      }

      // Step 3: Initialize MP4 transmuxer
      const transmuxer = this.initializeTransmuxer();

      // Step 4: Collect transmuxed MP4 fragments in memory
      // The final Blob is handed to chrome.downloads via the background service worker.
      const chunks = [];
      const writer = {
        write: async (data) => { chunks.push(data); },
        close: async () => {}
      };

      // Step 5: Download and process segments
      await this.downloadSegments(mediaPlaylist.segments, transmuxer, writer, mediaPlaylist.initSegmentUrl);

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
  async downloadSegments(segments, transmuxer, writer, initSegmentUrl) {
    this.stats.totalSegments = segments.length;

    // fMP4/CMAF segments carry no moov box of their own — it's declared
    // separately via EXT-X-MAP. Without prepending it, the output file has
    // no track/codec info at all and crashes on playback. TS segments
    // don't need this; mux.js emits its own init segment for those.
    let initSegmentBytes = null;
    if (initSegmentUrl) {
      initSegmentBytes = await this.fetchInitSegment(initSegmentUrl);
    }

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

      // Consume in order. A segment that exhausts its retries is fatal:
      // silently skipping it can produce a corrupt movie that appears to
      // have downloaded successfully. Abort the remaining fetch window too.
      let arrayBuffer;
      try {
        arrayBuffer = await pending.get(i);
      } catch (error) {
        pending.delete(i);
        this.abortController.abort();
        throw error;
      }
      pending.delete(i);
      if (arrayBuffer === null) break; // user cancelled

      // Check if it's TS format (typical for HLS)
      const isTS = this.isTransportStream(arrayBuffer);

      let mp4Data;
      if (isTS) {
        // Transmux TS to MP4
        mp4Data = await this.transmuxSegment(arrayBuffer, transmuxer, i === 0);
      } else if (i === 0 && initSegmentBytes) {
        // First fMP4 fragment — prepend the init segment fetched above
        mp4Data = this.concatBytes(initSegmentBytes, new Uint8Array(arrayBuffer));
      } else {
        // Already MP4 or other format, pass through
        mp4Data = new Uint8Array(arrayBuffer);
      }

      await writer.write(mp4Data);

      this.stats.downloaded++;
      this.reportProgress();
    }
  }

  /** Fetch an EXT-X-MAP init segment (the moov box fMP4 fragments depend on). */
  async fetchInitSegment(url) {
    const response = await fetch(url, { signal: this.abortController.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} fetching init segment`);
    return new Uint8Array(await response.arrayBuffer());
  }

  concatBytes(a, b) {
    const combined = new Uint8Array(a.byteLength + b.byteLength);
    combined.set(a, 0);
    combined.set(b, a.byteLength);
    return combined;
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

    // Same fMP4/CMAF issue as the video path — see downloadSegments above
    let initSegmentBytes = null;
    if (audioPlaylist.initSegmentUrl) {
      initSegmentBytes = await this.fetchInitSegment(audioPlaylist.initSegmentUrl);
    }

    // Track audio progress separately so the UI can show a distinct phase
    const total = audioPlaylist.segments.length;
    let done = 0;

    for (let i = 0; i < audioPlaylist.segments.length; i++) {
      if (this.abortController.signal.aborted) break;

      const buf = await this.fetchSegmentWithRetry(audioPlaylist.segments[i], i);
      if (buf === null) break; // user cancelled

      const view = new Uint8Array(buf);
      const isTS = view[0] === 0x47 && view[188] === 0x47;
      // Raw ADTS AAC starts with a 0xFFFx syncword — common for HLS audio
      // renditions and handled differently from TS
      const isAdts = view[0] === 0xFF && (view[1] & 0xF0) === 0xF0;

      if (i === 0) {
        console.log(`[Audio] Segment format: ${isTS ? 'MPEG-TS' : isAdts ? 'raw ADTS AAC' : 'unknown/fMP4'}` +
                    ` (first bytes ${view[0].toString(16)} ${view[1].toString(16)})`);
      }

      let data;
      if (isTS) {
        data = await this.transmuxSegment(buf, transmuxer, i === 0);
      } else if (i === 0 && initSegmentBytes) {
        data = this.concatBytes(initSegmentBytes, view);
      } else {
        data = view;
      }

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
   * Return a Retry-After delay in milliseconds when the server provides one.
   * Supports both the integer-seconds and HTTP-date forms defined by HTTP.
   */
  getRetryAfterMs(response) {
    const value = response?.headers?.get?.('Retry-After');
    if (!value) return 0;

    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.round(seconds * 1000);
    }

    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
  }

  /** Exponential retry delay with jitter, capped at maxRetryDelayMs. */
  getRetryDelayMs(attempt, retryAfterMs = 0) {
    const exponential = 1000 * (2 ** (attempt - 1));
    const jittered = Math.round(exponential * (0.75 + Math.random() * 0.5));
    const capped = Math.min(jittered, this.maxRetryDelayMs);
    return Math.max(capped, retryAfterMs);
  }

  /** Extend the shared CDN/server cooldown without shortening an existing one. */
  extendRetryPause(delayMs) {
    this.retryPauseUntil = Math.max(this.retryPauseUntil, Date.now() + delayMs);
  }

  /** Wait until the current shared cooldown expires (or the user cancels). */
  async waitForRetryPause() {
    while (!this.abortController.signal.aborted) {
      const remaining = this.retryPauseUntil - Date.now();
      if (remaining <= 0) return;
      await this.delay(remaining);
    }
  }

  /**
   * Fetch a single segment with retries and exponential backoff.
   * Temporary CDN/server errors (429/5xx) respect Retry-After and pause the
   * shared fetch window. Permanent HTTP errors fail immediately.
   * @returns {Promise<ArrayBuffer|null>} null only when the user cancels
   */
  async fetchSegmentWithRetry(segment, index) {
    const segmentNumber = index + 1;

    for (let attempt = 1; attempt <= this.maxSegmentAttempts; attempt++) {
      await this.waitForRetryPause();
      if (this.abortController.signal.aborted) return null;

      // Per-attempt timeout. Without this a server that accepts the
      // connection but never responds hangs the await forever.
      const timeoutController = new AbortController();
      const timer = setTimeout(() => timeoutController.abort(), this.segmentTimeoutMs);

      // Abort if EITHER the user cancels or this attempt times out.
      const signal = (typeof AbortSignal !== 'undefined' && AbortSignal.any)
        ? AbortSignal.any([this.abortController.signal, timeoutController.signal])
        : timeoutController.signal;

      try {
        if (attempt === 1) {
          console.log(`[Downloader] Fetching segment ${segmentNumber}/${this.stats.totalSegments}`);
        }

        const response = await fetch(segment.url, {
          signal,
          headers: {
            'Accept': '*/*',
            'Accept-Encoding': 'identity',
            'Referer': self.location?.href || ''
          }
        });

        if (!response.ok) {
          const error = new Error(`HTTP ${response.status}`);
          error.httpStatus = response.status;
          error.retryable = this.retryableHttpStatuses.has(response.status);
          error.retryAfterMs = this.getRetryAfterMs(response);
          throw error;
        }

        const arrayBuffer = await response.arrayBuffer();
        this.stats.bytesDownloaded += arrayBuffer.byteLength;
        return arrayBuffer;

      } catch (error) {
        if (this.abortController.signal.aborted) return null; // user cancelled

        const timedOut = timeoutController.signal.aborted;
        const retryable = timedOut || error.retryable !== false;
        const reason = timedOut
          ? `timeout after ${this.segmentTimeoutMs}ms`
          : (error.httpStatus ? `HTTP ${error.httpStatus}` : (error.message || 'network error'));

        // 4xx responses other than 429 are generally permanent. Retrying them
        // 20 times only slows the failure and increases load on the origin.
        if (!retryable) {
          this.stats.failed++;
          const terminal = new Error(
            `Segment ${segmentNumber}/${this.stats.totalSegments} failed permanently (${reason})`
          );
          terminal.cause = error;
          console.error(`[Downloader] ${terminal.message}`);
          throw terminal;
        }

        if (attempt >= this.maxSegmentAttempts) {
          this.stats.failed++;
          const terminal = new Error(
            `Segment ${segmentNumber}/${this.stats.totalSegments} failed after ` +
            `${this.maxSegmentAttempts} attempts (${reason})`
          );
          terminal.cause = error;
          console.error(`[Downloader] ${terminal.message}`);
          throw terminal;
        }

        const delayMs = this.getRetryDelayMs(attempt, error.retryAfterMs || 0);
        this.extendRetryPause(delayMs);
        console.log(
          `[Downloader] Segment ${segmentNumber}/${this.stats.totalSegments} temporarily unavailable ` +
          `(${reason}) — retrying in ${(delayMs / 1000).toFixed(1)}s`
        );
        await this.waitForRetryPause();
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
    return new Promise((resolve) => {
      if (this.abortController.signal.aborted) {
        resolve();
        return;
      }

      const timer = setTimeout(done, ms);
      const onAbort = () => done();

      function done() {
        clearTimeout(timer);
        thisSignal.removeEventListener('abort', onAbort);
        resolve();
      }

      const thisSignal = this.abortController.signal;
      thisSignal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Cancel download
   */
  cancel() {
    this.abortController.abort();
  }
}