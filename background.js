// Download pipeline runs in offscreen.html (service workers have no DOM);
// this worker only detects streams and brokers messages.
importScripts('telemetry.js', 'auth.js');

// ---------------------------------------------------------------------------
// Auth gate (private test period)
//
// Himitsu is gated behind login while it's limited to a small test group.
// Session state mirrors the streams pattern below it: an in-memory copy plus
// a restore promise, backed by chrome.storage.session so it survives worker
// suspension but clears when the browser fully closes — testers sign in
// again each browser session, per the agreed design.
//
// The popup performs the actual login (see auth.js / popup.js) and then
// sends 'authChanged' so this worker's in-memory copy updates immediately,
// rather than waiting for the next restart to re-read storage.
// ---------------------------------------------------------------------------
let authSession = null;
const authRestored = getAuthSession().then((session) => { authSession = session; });

function isAuthenticated() {
  return !!authSession;
}

// Store detected streams
const detectedStreams = new Map();
const activeDownloads = new Map();

// Blob URLs waiting for their chrome.downloads job to finish (downloadId -> blobUrl).
// Once finished we tell the offscreen doc to revoke them — otherwise every
// downloaded video stays in memory for the life of the offscreen document.
const pendingBlobUrls = new Map();

chrome.downloads.onChanged.addListener((delta) => {
  const state = delta.state && delta.state.current;
  if (state !== 'complete' && state !== 'interrupted') return;

  const entry = pendingBlobUrls.get(delta.id);
  releaseBlobUrl(delta.id);

  // Repair the saved file once it's fully written to disk
  if (state === 'complete' && entry) {
    remuxDownloadedFile(delta.id, entry.streamUrl).catch((e) =>
      console.log('[Remux] Skipped:', e.message));
  }
});

function releaseBlobUrl(downloadId) {
  const entry = pendingBlobUrls.get(downloadId);
  if (!entry) return;
  pendingBlobUrls.delete(downloadId);
  chrome.runtime.sendMessage({ target: 'offscreen', action: 'releaseBlob', blobUrl: entry.blobUrl })
    .catch(() => {});
  maybeCloseOffscreen();
}

// ---------------------------------------------------------------------------
// Post-download remux
//
// The in-browser pipeline emits FRAGMENTED MP4 — empty sample tables, no
// sidx/mfra index — so players scan the whole file before playback and
// transcoders often refuse it. If the native host and ffmpeg are available,
// repair the saved file in place with `-c copy` (lossless, no re-encode).
// Entirely optional: without the host, the file is simply left as-is.
// ---------------------------------------------------------------------------

async function remuxDownloadedFile(downloadId, streamUrl) {
  const [item] = await chrome.downloads.search({ id: downloadId });
  if (!item || !item.filename) return;

  // If this stream had a separate audio rendition, merge instead of remux —
  // ffmpeg combines both tracks and writes a proper index in one pass.
  const audio = pendingAudioMerge.get(streamUrl);
  pendingAudioMerge.delete(streamUrl);

  let port;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
  } catch (e) {
    console.log('[Remux] Native host unavailable — file left fragmented.');
    if (audio) {
      broadcast({
        action: 'audioWarning',
        url: streamUrl,
        message: 'Audio was saved as a separate file. Install the native host, ' +
                 'or merge manually: ffmpeg -i video.mp4 -i video.audio.m4a ' +
                 '-c copy output.mp4'
      });
    }
    return;
  }

  broadcast({
    action: 'remuxStarted',
    url: streamUrl,
    merging: !!(audio && audio.audioPath)
  });

  port.onMessage.addListener((msg) => {
    if (msg.type === 'remuxed') {
      trackEvent('remux_complete', { bytes: msg.bytes || 0, merged: !!msg.merged });
      broadcast({
        action: 'remuxComplete', url: streamUrl, path: msg.path, merged: !!msg.merged
      });
      port.disconnect();
    } else if (msg.type === 'remuxSkipped' || msg.type === 'error') {
      console.log('[Remux] Skipped:', msg.message);
      trackEvent('remux_skipped', {});
      broadcast({ action: 'remuxSkipped', url: streamUrl, message: msg.message });
      port.disconnect();
    }
  });

  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    if (err) {
      console.log('[Remux] Host disconnected:', err.message);
      broadcast({ action: 'remuxSkipped', url: streamUrl, message: 'Native host not installed' });
    }
  });

  port.postMessage(buildRemuxMessage(item.filename, audio));
}

// Thumbnail generation jobs in flight (stream urls)
const thumbnailJobs = new Set();

// A download with no progress for this long is considered wedged and
// can be force-cleared from the popup.
const STALE_DOWNLOAD_MS = 2 * 60 * 1000;

// Streams whose audio arrived as a separate rendition; the video and audio
// files are merged by ffmpeg once both are on disk.
// streamUrl -> { audioPath, audioDownloadId, trackName }
const pendingAudioMerge = new Map();

// ---------------------------------------------------------------------------
// Diagnostics log
//
// The pipeline spans three contexts with three separate consoles, which makes
// tracing a download painful. Everything funnels into one ring buffer here,
// viewable from the popup.
// ---------------------------------------------------------------------------

const MAX_LOGS = 400;
let logBuffer = [];
let logPersistTimer = null;

const logsRestored = chrome.storage.session.get('logs').then((d) => {
  if (Array.isArray(d.logs)) logBuffer = d.logs;
});

function addLog(level, source, message) {
  logBuffer.push({ ts: Date.now(), level, source, message: String(message).slice(0, 600) });
  if (logBuffer.length > MAX_LOGS) logBuffer.splice(0, logBuffer.length - MAX_LOGS);

  // Debounced — a busy download would otherwise write storage constantly
  if (!logPersistTimer) {
    logPersistTimer = setTimeout(() => {
      logPersistTimer = null;
      chrome.storage.session.set({ logs: logBuffer });
    }, 1000);
  }
}

// Mirror this worker's own console into the buffer
['log', 'warn', 'error'].forEach((level) => {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    original(...args);
    addLog(level, 'background', args.map(stringifyArg).join(' '));
  };
});

function stringifyArg(a) {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.message;
  try { return JSON.stringify(a); } catch { return String(a); }
}

// Close the offscreen document when nothing needs it, freeing all
// download memory. It's recreated on demand by ensureOffscreenDocument().
async function maybeCloseOffscreen() {
  if (activeDownloads.size > 0 || pendingBlobUrls.size > 0 || thumbnailJobs.size > 0) return;
  try {
    await chrome.offscreen.closeDocument();
  } catch (e) {
    // No document open — fine
  }
}

// MV3 suspends the service worker after ~30s idle, wiping in-memory state.
// Persist streams in chrome.storage.session so they survive worker restarts.
const streamsRestored = chrome.storage.session.get('detectedStreams').then((data) => {
  for (const [url, info] of (data.detectedStreams || [])) {
    if (!detectedStreams.has(url)) detectedStreams.set(url, info);
  }
  persistStreams();
});

function persistStreams() {
  chrome.storage.session.set({ detectedStreams: Array.from(detectedStreams.entries()) });
}

// Pattern to match m3u8 URLs
const M3U8_PATTERN = /\.m3u8($|\?)/i;

// Listen for network requests
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    // if (!authSession) return; // gated until the test-group login succeeds

    const url = details.url;
    
    if (detectedStreams.has(url)) return;
    if (!M3U8_PATTERN.test(url)) return;

    const streamInfo = {
      url: url,
      timestamp: Date.now(),
      tabId: details.tabId,
      type: details.type,
      initiator: details.initiator || 'unknown',
      title: null // Will be populated from page
    };
    
    detectedStreams.set(url, streamInfo);

    // Limit storage size
    if (detectedStreams.size > 50) {
      const oldestKey = detectedStreams.keys().next().value;
      detectedStreams.delete(oldestKey);
    }

    persistStreams();
    updateBadge(details.tabId);
    trackEvent('stream_detected', { host: new URL(url).hostname });
    console.log('[M3U8 Detector] Found:', url);
  },
  { urls: ["<all_urls>"] },
  ["requestBody"]
);

// Update badge
async function updateBadge(tabId) {
  const count = Array.from(detectedStreams.values())
    .filter(s => s.tabId === tabId).length;
  
  if (count > 0) {
    chrome.action.setBadgeText({ text: count.toString(), tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
  }
}

// Message handlers
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

  // Popup just logged in or out — update our in-memory copy immediately,
  // rather than waiting for the next worker restart to re-read storage.
  if (request.action === 'authChanged') {
    authSession = request.session || null;
    return false;
  }

  // Log entry forwarded from the offscreen document
  if (request.action === 'log') {
    addLog(request.level || 'log', request.source || 'offscreen', request.message);
    return false;
  }

  if (request.action === 'getLogs') {
    logsRestored.then(() => sendResponse({ logs: logBuffer }));
    return true;
  }

  if (request.action === 'clearLogs') {
    logBuffer = [];
    chrome.storage.session.set({ logs: [] });
    sendResponse({ ok: true });
    return false;
  }


  // Get streams for popup
  if (request.action === 'getStreams') {
    if (!isAuthenticated()) { sendResponse({ streams: [], authRequired: true }); return; }
    streamsRestored.then(() => {
      const streams = Array.from(detectedStreams.values())
        .filter(s => s.tabId === request.tabId)
        .sort((a, b) => b.timestamp - a.timestamp)
        // Attach live download state — the popup loses its own copy
        // whenever it closes, so it must come from here
        .map(s => ({ ...s, downloading: activeDownloads.has(s.url) }));
      sendResponse({ streams });
    });
  }

  // Clear streams
  if (request.action === 'clearStreams') {
    if (!isAuthenticated()) { sendResponse({ success: false, authRequired: true }); return; }
    console.log('clear streams');
    streamsRestored.then(() => {
      for (const [url, stream] of detectedStreams) {
        if (stream.tabId !== request.tabId) continue;

        // Keep streams that are actively downloading — clearing them would
        // strand the in-progress UI. But a download with no progress for
        // STALE_DOWNLOAD_MS is wedged (crashed offscreen doc, dead network),
        // so let Clear release it rather than locking the card forever.
        const info = activeDownloads.get(url);
        if (info) {
          const lastActivity = info.lastProgressAt || info.startTime;
          if (Date.now() - lastActivity < STALE_DOWNLOAD_MS) continue;
          activeDownloads.delete(url);
          broadcast({ action: 'downloadError', url, error: 'Download stalled — cleared' });
        }
        detectedStreams.delete(url);
      }
      persistStreams();
      maybeCloseOffscreen();

      // Badge reflects what's left (may be non-zero if downloads were kept)
      const remaining = Array.from(detectedStreams.values())
        .filter(s => s.tabId === request.tabId).length;
      chrome.action.setBadgeText({
        text: remaining > 0 ? remaining.toString() : '',
        tabId: request.tabId
      });
      sendResponse({ success: true });
    });
  }

  // Start download
  if (request.action === 'startDownload') {
    if (!isAuthenticated()) { sendResponse({ success: false, authRequired: true }); return true; }
    startDownload(request.url, request.filename, sender.tab?.id || request.tabId);
    sendResponse({ success: true, downloadId: request.url });
  }

  // Start download via the external downloader bridge
  if (request.action === 'startExternalDownload') {
    if (!isAuthenticated()) { sendResponse({ success: false, authRequired: true }); return true; }
    startExternalDownload(request.url);
    sendResponse({ success: true });
  }

  // Offscreen finished: save the blob via the downloads API
  // (offscreen documents can't call chrome.downloads themselves)
  if (request.action === 'saveBlob') {
    // Separate audio rendition: save the audio file first so both paths
    // exist on disk when the merge runs
    if (request.needsAudioMerge && request.audioBlobUrl) {
      chrome.downloads.download({
        url: request.audioBlobUrl,
        filename: request.audioFilename
      }).then(async (audioId) => {
        const [item] = await chrome.downloads.search({ id: audioId });
        pendingAudioMerge.set(request.streamUrl, {
          audioPath: item ? item.filename : null,
          audioDownloadId: audioId,
          trackName: request.audioTrackName
        });
        chrome.runtime.sendMessage({
          target: 'offscreen', action: 'releaseBlob', blobUrl: request.audioBlobUrl
        }).catch(() => {});
      }).catch((e) => console.error('[Audio] save failed:', e));
    }

    if (request.audioMissing) {
      broadcast({
        action: 'audioWarning',
        url: request.streamUrl,
        message: 'This stream carries a separate audio track that could not be ' +
                 'downloaded — the saved file will be silent.'
      });
    }

    chrome.downloads.download({
      url: request.blobUrl,
      filename: request.filename
    }).then(async (downloadId) => {
      const info = activeDownloads.get(request.streamUrl);
      activeDownloads.delete(request.streamUrl);
      pendingBlobUrls.set(downloadId, {
        blobUrl: request.blobUrl,
        streamUrl: request.streamUrl
      });

      const stats = request.stats || {};
      trackEvent('download_complete', {
        bytes: stats.bytesDownloaded || 0,
        segments: stats.downloaded || 0,
        failedSegments: stats.failed || 0,
        ms: info ? Date.now() - info.startTime : 0
      });

      chrome.runtime.sendMessage({
        action: 'downloadComplete',
        url: request.streamUrl,
        result: { filename: request.filename }
      }).catch(() => {});

      // Small files can finish before we registered them — check state now
      const [item] = await chrome.downloads.search({ id: downloadId });
      if (item && (item.state === 'complete' || item.state === 'interrupted')) {
        releaseBlobUrl(downloadId);
      }
    }).catch((err) => {
      activeDownloads.delete(request.streamUrl);
      chrome.runtime.sendMessage({
        action: 'downloadError',
        url: request.streamUrl,
        error: err.message
      }).catch(() => {});
      chrome.runtime.sendMessage({
        target: 'offscreen', action: 'releaseBlob', blobUrl: request.blobUrl
      }).catch(() => {});
      maybeCloseOffscreen();
    });
    sendResponse({ success: true });
  }

  // Progress heartbeat from the offscreen doc — used to tell a slow
  // download apart from a wedged one
  if (request.action === 'downloadProgress') {
    const info = activeDownloads.get(request.url);
    if (info) {
      info.lastProgressAt = Date.now();
      info.progress = request.progress;
    }
  }

  // Offscreen pipeline failed before producing a blob — drop tracking
  // (the popup receives the same broadcast directly)
  if (request.action === 'downloadError') {
    activeDownloads.delete(request.url);
    trackEvent('download_error', { message: String(request.error).slice(0, 200) });
    maybeCloseOffscreen();
  }

  // Popup asks for thumbnails of streams that don't have one yet
  if (request.action === 'generateThumbnails') {
    if (!isAuthenticated()) { sendResponse({ started: 0, authRequired: true }); return; }
    streamsRestored.then(async () => {
      const targets = (request.urls || []).filter((url) => {
        const s = detectedStreams.get(url);
        if (!s || thumbnailJobs.has(url)) return false;
        // The same job produces both the preview and the size metadata,
        // so run it if either is still missing and hasn't already failed
        return (!s.thumbnail && !s.thumbnailTried) || (!s.meta && !s.metaTried);
      });
      if (targets.length === 0) {
        sendResponse({ started: 0 });
        return;
      }
      targets.forEach((url) => thumbnailJobs.add(url));
      await ensureOffscreenDocument();
      for (const url of targets) {
        chrome.runtime.sendMessage({ target: 'offscreen', action: 'generateThumbnail', url })
          .catch(() => { thumbnailJobs.delete(url); });
      }
      sendResponse({ started: targets.length });
    });
  }

  // Size / duration metadata from the analysis job
  if (request.action === 'streamMeta') {
    streamsRestored.then(() => {
      const stream = detectedStreams.get(request.url);
      if (stream) {
        stream.meta = request.meta;
        persistStreams();
      }
    });
  }

  // Offscreen produced (or failed to produce) a thumbnail — cache it
  if (request.action === 'thumbnailReady') {
    thumbnailJobs.delete(request.url);
    streamsRestored.then(() => {
      const stream = detectedStreams.get(request.url);
      if (stream) {
        stream.thumbnailTried = true; // don't retry failures on every popup open
        stream.metaTried = true;
        if (request.thumbnail) stream.thumbnail = request.thumbnail;
        if (request.frames) stream.frames = request.frames; // hover animation frames
        persistStreams();
      }
      trackEvent('thumbnail_generated', { ok: !!request.thumbnail });
      maybeCloseOffscreen();
    });
  }

  // Cancel download
  // Cancel a download. The VideoDownloader lives in the offscreen document,
  // so forward the request there; also release our own tracking immediately
  // so a wedged offscreen doc can never lock the UI permanently.
  if (request.action === 'cancelDownload') {
    if (!isAuthenticated()) { sendResponse({ success: false, authRequired: true }); return true; }
    activeDownloads.delete(request.url);
    chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'cancelDownload',
      url: request.url
    }).catch(() => {});
    broadcast({ action: 'downloadError', url: request.url, error: 'Cancelled' });
    maybeCloseOffscreen();
    sendResponse({ success: true });
  }

  return true;
});

// ---------------------------------------------------------------------------
// External downloader bridge
//
// For URLs the in-browser HLS pipeline can't handle, hand the URL to a
// downloader program the user has installed themselves, over native
// messaging. This extension contains no site-specific extraction logic —
// it only opens the pipe and relays progress.
// ---------------------------------------------------------------------------

const NATIVE_HOST = 'com.miteruno.downloader';

function startExternalDownload(url) {
  let port;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
  } catch (e) {
    broadcast({ action: 'externalError', url, error: 'Native host not reachable: ' + e.message });
    return;
  }

  activeDownloads.set(url, { external: true, startTime: Date.now() });

  port.onMessage.addListener((msg) => {
    if (msg.type === 'progress') {
      broadcast({ action: 'externalProgress', url, percent: msg.percent, line: msg.line });
    } else if (msg.type === 'done') {
      activeDownloads.delete(url);
      trackEvent('external_download_complete', {});
      broadcast({ action: 'externalComplete', url, filename: msg.filename });
      port.disconnect();
    } else if (msg.type === 'error') {
      activeDownloads.delete(url);
      trackEvent('external_download_error', { message: String(msg.message).slice(0, 200) });
      broadcast({ action: 'externalError', url, error: msg.message });
      port.disconnect();
    }
  });

  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    if (activeDownloads.has(url)) {
      activeDownloads.delete(url);
      broadcast({
        action: 'externalError',
        url,
        error: err ? err.message : 'Native host disconnected. Is it installed?'
      });
    }
  });

  trackEvent('external_download_start', {});
  port.postMessage({ url });
}

/** Path the native host should be asked to operate on, plus the audio to merge */
function buildRemuxMessage(videoPath, audio) {
  return (audio && audio.audioPath)
    ? { action: 'remux', path: videoPath, audioPath: audio.audioPath }
    : { action: 'remux', path: videoPath };
}

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {}); // popup may be closed
}

/**
 * Start video download process — delegated to the offscreen document,
 * which has the DOM APIs (Blob, URL.createObjectURL) the pipeline needs.
 */
async function startDownload(url, filename, tabId) {
  // Register before the await so maybeCloseOffscreen() can't close
  // the document out from under a download that's about to start
  activeDownloads.set(url, {
    progress: { percent: 0, downloaded: 0, total: 0 },
    startTime: Date.now()
  });

  await ensureOffscreenDocument();
  trackEvent('download_start');

  chrome.runtime.sendMessage({
    target: 'offscreen',
    action: 'downloadStream',
    url: url,
    filename: filename || 'video.mp4'
  }).catch((err) => console.error('[Offscreen] send failed:', err));
}

async function ensureOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) return;
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Downloads HLS segments and transmuxes them into an MP4 blob'
    });
  } catch (e) {
    // Ignore "only one offscreen document" race
    if (!String(e).includes('single offscreen')) throw e;
  }
}

// Tab change handling
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const count = Array.from(detectedStreams.values())
    .filter(s => s.tabId === activeInfo.tabId).length;
  
  chrome.action.setBadgeText({ 
    text: count > 0 ? count.toString() : '', 
    tabId: activeInfo.tabId 
  });
});