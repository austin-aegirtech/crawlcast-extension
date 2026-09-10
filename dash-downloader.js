/**
 * DASH Video Downloader — proof of concept.
 *
 * Structurally mirrors VideoDownloader (downloader.js): same concurrency
 * window, same retry-with-backoff segment fetch, same "collect chunks then
 * Blob" assembly. Reused directly rather than reimplemented, so the two
 * pipelines behave identically under network failure.
 *
 * Differs from VideoDownloader where DASH itself differs from HLS:
 *   - Segments are almost always already fragmented MP4 (CMAF), so no
 *     mux.js transmux step is needed — this just concatenates init + media
 *     segments. (isTransportStream() is still checked per-segment as a
 *     defensive fallback, reusing the same sync-byte check as the HLS path,
 *     in case a segment does turn out to be MPEG-TS.)
 *   - Separate audio/video Representations are the default case (an
 *     AdaptationSet per content type), not an edge case.
 *   - SegmentBase representations have no segment list in the manifest at
 *     all — the list has to be built by fetching the sidx box first.
 *
 * NOT handled in this POC (see dash-parser.js header for the full list):
 *   multi-Period stitching beyond period[0], live/dynamic manifests, DRM.
 */

class DashDownloader {
  constructor(options = {}) {
    this.onProgress = options.onProgress || (() => {});
    this.onComplete = options.onComplete || (() => {});
    this.onError = options.onError || (() => {});

    this.parser = new DashParser();
    this.abortController = new AbortController();
    this.stats = { totalSegments: 0, downloaded: 0, failed: 0, bytesDownloaded: 0 };

    this.concurrency = 4;
    this.segmentTimeoutMs = options.segmentTimeoutMs || 30000;
    this.memoryLimitBytes = options.memoryLimitBytes || 1.5e9;
  }

  /**
   * @param {string} mpdUrl
   * @param {string} filename
   */
  async download(mpdUrl, filename = 'video.mp4') {
    try {
      console.log('[DashDownloader] Starting download from:', mpdUrl);

      const response = await fetch(mpdUrl, { signal: this.abortController.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      const manifest = this.parser.parse(await response.text(), mpdUrl);

      if (manifest.periods.length > 1) {
        console.warn(
          `[DashDownloader] Manifest has ${manifest.periods.length} Periods — ` +
          `this POC only downloads the first. Multi-Period stitching is not implemented.`
        );
      }
      const period = manifest.periods[0];

      const videoPick = this.parser.selectBestVideo(period);
      if (!videoPick) throw new Error('No video AdaptationSet found in manifest');
      const audioPick = this.parser.selectBestAudio(period);

      console.log('[DashDownloader] Selected video:', videoPick.rep.width, 'x', videoPick.rep.height,
                  `@ ${Math.round(videoPick.rep.bandwidth / 1000)}kbps`,
                  audioPick ? '+ separate audio' : '(no separate audio track found)');

      const videoResolved = await this.resolveWithIndex(videoPick.rep, period);
      const audioResolved = audioPick ? await this.resolveWithIndex(audioPick.rep, period) : null;

      // Same size guard as the HLS pipeline — everything is buffered in memory.
      const estimate = this.estimateSize(videoResolved.segments, videoPick.rep.bandwidth, period.duration);
      if (estimate.bytes > this.memoryLimitBytes) {
        const err = new Error(
          `Video is too large for in-browser download (~${(estimate.bytes / 1e9).toFixed(1)} GB ` +
          `over ${videoResolved.segments.length} segments).`
        );
        err.tooLarge = true;
        err.estimate = estimate;
        throw err;
      }

      const videoBlob = await this.downloadRepresentation(videoResolved, 'video');
      let audioBlob = null;
      if (audioResolved) {
        try {
          audioBlob = await this.downloadRepresentation(audioResolved, 'audio');
        } catch (e) {
          console.error('[DashDownloader] Audio track failed:', e);
          // Non-fatal, same policy as the HLS pipeline: a silent video beats no video
        }
      }

      this.onComplete({
        filename,
        stats: this.stats,
        blob: videoBlob,
        audioBlob,
        needsAudioMerge: !!audioBlob,
        audioTrackName: audioPick ? (audioPick.as.lang || 'audio') : null,
        audioMissing: !!audioResolved && !audioBlob
      });

    } catch (error) {
      console.error('[DashDownloader] Error:', error);
      this.onError(error);
    }
  }

  /**
   * resolveSegments() from the parser, but for SegmentBase representations
   * (mode: 'base', empty segments array) fetches and parses the sidx box
   * to build the real segment list first.
   */
  async resolveWithIndex(representation, period) {
    const resolved = this.parser.resolveSegments(representation, period);
    if (resolved.mode !== 'base') return resolved;

    const segments = await this.fetchAndParseSidx(resolved);
    return { ...resolved, segments };
  }

  /**
   * SegmentBase addressing: a single media file, with a byte-range 'sidx'
   * (Segment Index) box telling us where each segment starts and how long
   * it is. Fetch just that range, parse the box, turn it into a normal
   * segment list of byte ranges into the same file.
   */
  async fetchAndParseSidx(resolved) {
    if (!resolved.indexRange) {
      throw new Error('SegmentBase representation has no indexRange — cannot locate the sidx box');
    }

    const resp = await fetch(resolved.indexUrl, {
      headers: { Range: `bytes=${resolved.indexRange}` },
      signal: this.abortController.signal
    });
    if (!resp.ok && resp.status !== 206) {
      throw new Error(`HTTP ${resp.status} fetching sidx range ${resolved.indexRange}`);
    }
    const buf = await resp.arrayBuffer();
    return this.parseSidxBox(buf, resolved.baseUrl, resolved.indexRange);
  }

  /**
   * Parse an ISO-BMFF 'sidx' box into a list of {url, range, duration}
   * segments, each a byte range into the same file the sidx came from.
   * Box layout: ISO/IEC 14496-12 §8.16.3.
   */
  parseSidxBox(buf, baseUrl, indexRangeHeader) {
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);

    // Walk top-level boxes looking for 'sidx' — usually the first/only box
    // in the fetched range, but not guaranteed (some encoders prepend 'styp').
    let offset = 0;
    let sidxOffset = -1;
    while (offset + 8 <= buf.byteLength) {
      const size = view.getUint32(offset);
      const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
      if (type === 'sidx') { sidxOffset = offset; break; }
      if (size < 8) break;
      offset += size;
    }
    if (sidxOffset === -1) {
      throw new Error('No sidx box found in the fetched index range — SegmentBase index may use a non-standard layout');
    }

    let p = sidxOffset + 8; // skip size+type
    const version = bytes[p]; p += 4; // version(1) + flags(3)
    p += 4; // reference_ID
    const timescale = view.getUint32(p); p += 4;

    let earliestPresentationTime, firstOffset;
    if (version === 0) {
      earliestPresentationTime = view.getUint32(p); p += 4;
      firstOffset = view.getUint32(p); p += 4;
    } else {
      earliestPresentationTime = Number(view.getBigUint64(p)); p += 8;
      firstOffset = Number(view.getBigUint64(p)); p += 8;
    }
    p += 2; // reserved
    const referenceCount = view.getUint16(p); p += 2;

    // Segment data starts right after the sidx box, at the start of the
    // range we originally requested (indexRange is "sidxStart-sidxEnd";
    // media segments follow immediately after sidxEnd in SegmentBase).
    const [, rangeEndStr] = indexRangeHeader.split('-');
    let cursor = parseInt(rangeEndStr, 10) + 1 + firstOffset;

    const segments = [];
    for (let i = 0; i < referenceCount; i++) {
      const refWord = view.getUint32(p); p += 4;
      const referencedSize = refWord & 0x7fffffff; // top bit is reference_type, ignored (assume media, not sidx-of-sidx)
      const subsegmentDuration = view.getUint32(p); p += 4;
      p += 4; // SAP flags, ignored

      const rangeStart = cursor;
      const rangeEnd = cursor + referencedSize - 1;
      segments.push({
        url: baseUrl,
        range: `${rangeStart}-${rangeEnd}`,
        duration: subsegmentDuration / timescale
      });
      cursor = rangeEnd + 1;
    }

    return segments;
  }

  /**
   * Download one Representation's segments (video or audio) into a single Blob.
   */
  async downloadRepresentation(resolved, phase) {
    const chunks = [];
    if (resolved.initSegment) {
      const initBuf = await this.fetchWithRange(resolved.initSegment.url, resolved.initSegment.range);
      chunks.push(new Uint8Array(initBuf));
    }

    this.stats.totalSegments = resolved.segments.length;
    const pending = new Map();

    for (let i = 0; i < resolved.segments.length; i++) {
      if (this.abortController.signal.aborted) break;

      const windowEnd = Math.min(i + this.concurrency, resolved.segments.length);
      for (let j = i; j < windowEnd; j++) {
        if (!pending.has(j)) {
          pending.set(j, this.fetchSegmentWithRetry(resolved.segments[j], j));
        }
      }

      const buf = await pending.get(i);
      pending.delete(i);
      if (buf === null) continue;

      // DASH segments are typically fMP4 already. isTransportStream() reuses
      // the same 0x47 sync-byte check the HLS pipeline uses, purely as a
      // defensive fallback — no transmuxer is wired up here since MPEG-TS
      // inside a DASH SegmentBase/Template would be unusual.
      const view = new Uint8Array(buf);
      if (view[0] === 0x47 && view[188] === 0x47) {
        console.warn(`[DashDownloader] Segment ${i} looks like MPEG-TS — this POC does not ` +
                     `transmux DASH segments, output may not play correctly.`);
      }

      chunks.push(view);
      this.stats.downloaded++;
      this.stats.bytesDownloaded += buf.byteLength;
      this.reportProgress(phase);
    }

    return new Blob(chunks, { type: phase === 'audio' ? 'audio/mp4' : 'video/mp4' });
  }

  /** Fetch, optionally with a byte-range header (used for init segments with a `range` and for SegmentBase segments) */
  async fetchWithRange(url, range) {
    const headers = { 'Accept': '*/*' };
    if (range) headers.Range = `bytes=${range}`;
    const resp = await fetch(url, { headers, signal: this.abortController.signal });
    if (!resp.ok && resp.status !== 206) throw new Error(`HTTP ${resp.status} fetching ${url}`);
    return resp.arrayBuffer();
  }

  /** Same retry/backoff shape as VideoDownloader.fetchSegmentWithRetry, adapted for optional byte ranges */
  async fetchSegmentWithRetry(segment, index) {
    const maxRetries = 20;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const timeoutController = new AbortController();
      const timer = setTimeout(() => timeoutController.abort(), this.segmentTimeoutMs);
      const signal = (typeof AbortSignal !== 'undefined' && AbortSignal.any)
        ? AbortSignal.any([this.abortController.signal, timeoutController.signal])
        : timeoutController.signal;

      try {
        const headers = { 'Accept': '*/*', 'Accept-Encoding': 'identity' };
        if (segment.range) headers.Range = `bytes=${segment.range}`;

        const response = await fetch(segment.url, { signal, headers });
        if (!response.ok && response.status !== 206) throw new Error(`HTTP ${response.status}`);

        return await response.arrayBuffer();
      } catch (error) {
        if (this.abortController.signal.aborted) return null;
        const timedOut = timeoutController.signal.aborted;
        console.warn(`[DashDownloader] Segment ${index} failed (attempt ${attempt})`,
                     timedOut ? `— timed out after ${this.segmentTimeoutMs}ms` : error);

        if (attempt >= maxRetries) {
          this.stats.failed++;
          return null;
        }
        await this.delay(1000 * attempt);
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  }

  estimateSize(segments, bandwidth, periodDuration) {
    const seconds = segments.reduce((sum, s) => sum + (s.duration || 0), 0) || periodDuration || 0;
    const bytes = bandwidth && seconds ? (bandwidth / 8) * seconds : segments.length * 400 * 1024;
    return { bytes, seconds, segments: segments.length };
  }

  reportProgress(phase) {
    const processed = this.stats.downloaded + this.stats.failed;
    let percent = Math.floor((processed / this.stats.totalSegments) * 100);
    if (percent >= 100 && processed < this.stats.totalSegments) percent = 99;

    this.onProgress({
      percent,
      phase,
      downloaded: this.stats.downloaded,
      total: this.stats.totalSegments,
      failed: this.stats.failed,
      mbDownloaded: (this.stats.bytesDownloaded / 1024 / 1024).toFixed(2)
    });
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  cancel() {
    this.abortController.abort();
  }
}
