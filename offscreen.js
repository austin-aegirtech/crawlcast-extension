/**
 * Offscreen document glue.
 * Receives download requests from the background service worker,
 * runs VideoDownloader, relays progress to the popup, and hands the
 * finished Blob URL back to the background (offscreen documents can
 * only use chrome.runtime — not chrome.downloads).
 */

// ---------------------------------------------------------------------------
// Forward this document's console into the background's diagnostics buffer, so
// the popup can show the whole pipeline in one place. Intercepting console
// captures downloader.js output too, without touching every call site.
// ---------------------------------------------------------------------------
(() => {
  // Per-segment fetch lines would flood a 4000-segment download
  const NOISY = /Fetching segment/;

  ['log', 'warn', 'error'].forEach((level) => {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      const message = args.map((a) => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.message;
        try { return JSON.stringify(a); } catch { return String(a); }
      }).join(' ');

      if (NOISY.test(message)) return;

      chrome.runtime.sendMessage({
        action: 'log', level, source: 'offscreen', message
      }).catch(() => {}); // worker asleep — the console still has it
    };
  });
})();

chrome.runtime.onMessage.addListener((request) => {
  if (request.target !== 'offscreen') return;

  if (request.action === 'downloadStream') {
    startDownload(request.url, request.filename);
  }

  if (request.action === 'pauseDownload') {
    const downloader = runningDownloads.get(request.url);
    if (downloader?.pause()) {
      console.log('[Downloader] Paused:', request.url);
    }
  }

  if (request.action === 'resumeDownload') {
    const downloader = runningDownloads.get(request.url);
    if (downloader?.resume()) {
      console.log('[Downloader] Resumed:', request.url);
    }
  }

  // Abort an in-flight download and drop its buffered chunks
  if (request.action === 'cancelDownload') {
    const downloader = runningDownloads.get(request.url);
    if (downloader) {
      downloader.cancel();
      runningDownloads.delete(request.url);
    }
    chrome.runtime.sendMessage({
      action: 'downloadError',
      url: request.url,
      error: 'Cancelled'
    }).catch(() => {});
  }

  // Background says the chrome.downloads job is done — free the blob memory
  if (request.action === 'releaseBlob') {
    URL.revokeObjectURL(request.blobUrl);
  }

  // Generate a thumbnail for a detected stream (lazy, requested via popup)
  if (request.action === 'generateThumbnail') {
    generateThumbnail(request.url)
      .then((frames) => {
        chrome.runtime.sendMessage({
          action: 'thumbnailReady',
          url: request.url,
          thumbnail: frames[0],
          frames: frames
        }).catch(() => {});
      })
      .catch((err) => {
        console.warn('[Thumbnail] Failed for', request.url, err);
        chrome.runtime.sendMessage({ action: 'thumbnailReady', url: request.url, thumbnail: null })
          .catch(() => {});
      });
  }
});

/**
 * Build a small preview of a stream: fetch the playlist (lowest-bandwidth
 * variant — cheapest), then sample up to 8 segments EVENLY SPREAD across
 * the whole video and capture one mid-frame from each. Hovering the
 * thumbnail then scrubs through the entire video, not just its first
 * few seconds.
 * @returns {Promise<string[]>} JPEG data URLs (frame 0 = static thumbnail)
 */
async function generateThumbnail(url) {
  const parser = new M3U8Parser();

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  let playlist = parser.parse(await resp.text(), url);

  // The download always takes the HIGHEST bandwidth variant, so size must be
  // estimated from that one — even though frames are sampled from the lowest.
  let downloadVariant = null;
  if (playlist.isMaster) {
    const byBandwidth = [...playlist.variants].sort((a, b) => a.bandwidth - b.bandwidth);
    const variant = byBandwidth[0];
    downloadVariant = byBandwidth[byBandwidth.length - 1];
    if (!variant) throw new Error('Master playlist has no variants');
    const varResp = await fetch(variant.url);
    if (!varResp.ok) throw new Error(`HTTP ${varResp.status}`);
    playlist = parser.parse(await varResp.text(), variant.url);
  }

  const segments = playlist.segments;
  if (segments.length === 0) throw new Error('Playlist has no segments');

  // Publish size/duration as soon as they're known — useful long before the
  // thumbnail renders, and it survives a thumbnail failure.
  const durationSeconds = segments.reduce((sum, s) => sum + (s.duration || 0), 0);
  const meta = {
    durationSeconds,
    segments: segments.length,
    resolution: downloadVariant ? downloadVariant.resolution : null,
    bandwidth: downloadVariant ? downloadVariant.bandwidth : null,
    bytes: downloadVariant && durationSeconds
      ? Math.round((downloadVariant.bandwidth / 8) * durationSeconds)
      : null,
    estimated: true
  };
  if (meta.bytes) sendMeta(url, meta);

  // Up to 8 segment indices evenly spread from start to end of the video
  const frameCount = Math.min(8, segments.length);
  const indices = [...new Set(
    Array.from({ length: frameCount }, (_, i) =>
      Math.round(i * (segments.length - 1) / Math.max(1, frameCount - 1)))
  )];

  const frames = [];
  let sampledBytes = 0;
  let sampledCount = 0;
  for (const idx of indices) {
    try {
      const result = await captureSegmentFrame(segments[idx].url);
      frames.push(result.frame);
      sampledBytes += result.byteLength;
      sampledCount++;
    } catch (err) {
      console.warn('[Thumbnail] Segment', idx, 'frame failed:', err);
    }
  }

  // No master playlist means no bandwidth attribute — extrapolate instead
  // from the segments we just downloaded anyway.
  if (!meta.bytes && sampledCount > 0) {
    meta.bytes = Math.round((sampledBytes / sampledCount) * segments.length);
    sendMeta(url, meta);
  }

  if (frames.length === 0) throw new Error('No frames captured');
  return frames;
}

function sendMeta(url, meta) {
  chrome.runtime.sendMessage({ action: 'streamMeta', url, meta }).catch(() => {});
}

/**
 * Fetch one segment, transmux it standalone, and snapshot its middle frame
 * @returns {Promise<{frame: string, byteLength: number}>}
 */
async function captureSegmentFrame(segUrl) {
  const resp = await fetch(segUrl);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const buf = await resp.arrayBuffer();

  // TS → fMP4 if needed (sync byte 0x47 at packet boundaries).
  // A fresh transmuxer per segment makes each blob self-contained,
  // which is required since these segments aren't contiguous.
  const view = new Uint8Array(buf);
  const isTS = view[0] === 0x47 && view[188] === 0x47;
  const mp4Bytes = isTS ? await transmuxOnce(buf) : view;

  const blobUrl = URL.createObjectURL(new Blob([mp4Bytes], { type: 'video/mp4' }));
  try {
    const frames = await captureFrames(blobUrl, 1); // 1 frame = segment midpoint
    return { frame: frames[0], byteLength: buf.byteLength };
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

/** One-shot TS → fMP4 transmux (fresh transmuxer, includes init segment) */
function transmuxOnce(tsBuffer) {
  return new Promise((resolve) => {
    const transmuxer = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: false, remux: true });
    const chunks = [];
    transmuxer.on('data', (segment) => {
      if (segment.initSegment) chunks.push(segment.initSegment);
      chunks.push(segment.data);
    });
    transmuxer.on('done', () => {
      const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
      resolve(out);
    });
    transmuxer.push(new Uint8Array(tsBuffer));
    transmuxer.flush();
  });
}

/**
 * Load a video blob and snapshot `frameCount` frames spread across it.
 * Frame 0 doubles as the static thumbnail; the full set animates on hover.
 */
function captureFrames(src, frameCount = 8) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';

    const frames = [];
    let canvas, ctx, w, h, duration;
    let index = 0;

    const timeout = setTimeout(() => { cleanup(); reject(new Error('Thumbnail timed out')); }, 15000);
    const cleanup = () => {
      clearTimeout(timeout);
      video.removeAttribute('src');
      video.load();
    };

    const seekNext = () => {
      if (index >= frameCount) {
        cleanup();
        resolve(frames);
        return;
      }
      // Sample mid-points of equal slices — avoids black first/last frames
      video.currentTime = duration * (index + 0.5) / frameCount;
      index++;
    };

    video.addEventListener('error', () => { cleanup(); reject(new Error('Video failed to decode')); }, { once: true });

    video.addEventListener('loadeddata', () => {
      if (!video.videoWidth) { cleanup(); reject(new Error('No video track')); return; }
      duration = (isFinite(video.duration) && video.duration > 0) ? video.duration : 2;
      w = 320;
      h = Math.round(w * video.videoHeight / video.videoWidth);
      canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      ctx = canvas.getContext('2d');
      seekNext();
    }, { once: true });

    video.addEventListener('seeked', () => {
      ctx.drawImage(video, 0, 0, w, h);
      frames.push(canvas.toDataURL('image/jpeg', 0.6));
      seekNext();
    });

    video.src = src;
  });
}

// Live VideoDownloader instances, so cancel requests can reach them
const runningDownloads = new Map();

function startDownload(url, filename) {
  const downloader = new VideoDownloader({
    onProgress: (progress) => {
      chrome.runtime.sendMessage({
        action: 'downloadProgress',
        url: url,
        progress: progress
      }).catch(() => {}); // Ignore if popup closed
    },

    onComplete: (result) => {
      runningDownloads.delete(url);
      // Blob URL stays valid while this document is alive;
      // background downloads it via chrome.downloads
      const blobUrl = URL.createObjectURL(result.blob);

      // Streams with a separate audio rendition produce two files that
      // ffmpeg merges afterwards. Saved alongside the video so the native
      // host can find both by path.
      let audioBlobUrl = null;
      let audioFilename = null;
      if (result.audioBlob) {
        audioBlobUrl = URL.createObjectURL(result.audioBlob);
        audioFilename = result.filename.replace(/\.mp4$/i, '') + '.audio.m4a';
      }

      chrome.runtime.sendMessage({
        action: 'saveBlob',
        blobUrl: blobUrl,
        filename: result.filename,
        streamUrl: url,
        audioBlobUrl,
        audioFilename,
        needsAudioMerge: !!result.needsAudioMerge,
        audioTrackName: result.audioTrackName,
        audioMissing: !!result.audioMissing
      }).catch(() => {});
    },

    onError: (error) => {
      runningDownloads.delete(url);
      chrome.runtime.sendMessage({
        action: 'downloadError',
        url: url,
        error: error.message,
        tooLarge: !!error.tooLarge // popup offers the bridge handoff
      }).catch(() => {});
    }
  });

  runningDownloads.set(url, downloader);
  downloader.download(url, filename);
}
