// Download pipeline runs in offscreen.html (service workers have no DOM);
// this worker only detects streams and brokers messages.
// Store detected streams
const detectedStreams = new Map();
const activeDownloads = new Map();

// Blob URLs waiting for their chrome.downloads job to finish (downloadId -> blobUrl).
// Once finished we tell the offscreen doc to revoke them — otherwise every
// downloaded video stays in memory for the life of the offscreen document.
const pendingBlobUrls = new Map();

// Direct MP4 downloads are owned by chrome.downloads instead of the HLS
// offscreen pipeline. Keep the browser download id mapped back to the
// detected stream so progress, cancellation, and post-download repair can
// use the same popup UI as HLS downloads.
const directDownloads = new Map();

function persistDirectDownloads() {
  chrome.storage.session.set({ directDownloads: Array.from(directDownloads.entries()) });
}

const directDownloadsRestored = chrome.storage.session.get('directDownloads').then(async (data) => {
  for (const [downloadId, entry] of (data.directDownloads || [])) {
    const numericId = Number(downloadId);
    if (!Number.isInteger(numericId) || !entry?.streamUrl) continue;

    directDownloads.set(numericId, entry);
    activeDownloads.set(entry.streamUrl, {
      kind: 'direct',
      progress: {
        kind: 'direct',
        phase: 'downloading',
        percent: entry.totalBytes > 0
          ? Math.min(99, Math.round(((entry.bytesReceived || 0) / entry.totalBytes) * 100))
          : 0,
        bytesReceived: entry.bytesReceived || 0,
        totalBytes: entry.totalBytes || 0,
        mbDownloaded: ((entry.bytesReceived || 0) / 1e6).toFixed(1)
      },
      startTime: entry.startTime || Date.now(),
      lastProgressAt: Date.now(),
      downloadId: numericId
    });

    const [item] = await chrome.downloads.search({ id: numericId });
    if (!item || item.state === 'interrupted') {
      directDownloads.delete(numericId);
      activeDownloads.delete(entry.streamUrl);
      continue;
    }

    entry.bytesReceived = item.bytesReceived || entry.bytesReceived || 0;
    entry.totalBytes = item.totalBytes || entry.totalBytes || 0;

    if (item.state === 'complete') {
      completeDirectDownload(numericId, entry);
    }
  }
  persistDirectDownloads();
});

// Free-tier mode state. User Mode allows one accepted download start per
// rolling 60-minute window; God Mode bypasses the limit. Keep this in
// storage.local so the limit survives popup closes and browser restarts.
const USER_MODE_DOWNLOAD_LIMIT_MS = 60 * 60 * 1000;
let crawlcastMode = 'user';
let userModeLastDownloadAt = 0;

const modeStateRestored = chrome.storage.local
  .get(['crawlcastMode', 'userModeLastDownloadAt'])
  .then((data) => {
    crawlcastMode = data.crawlcastMode === 'god' ? 'god' : 'user';
    userModeLastDownloadAt = Number(data.userModeLastDownloadAt) || 0;
  });

function getModeState() {
  const now = Date.now();
  const nextAllowedAt = userModeLastDownloadAt + USER_MODE_DOWNLOAD_LIMIT_MS;
  const remainingMs = crawlcastMode === 'user'
    ? Math.max(0, nextAllowedAt - now)
    : 0;

  return {
    mode: crawlcastMode,
    lastDownloadAt: userModeLastDownloadAt,
    nextAllowedAt: remainingMs > 0 ? nextAllowedAt : 0,
    remainingMs,
    canDownload: crawlcastMode === 'god' || remainingMs === 0
  };
}

chrome.downloads.onChanged.addListener((delta) => {
  const direct = directDownloads.get(delta.id);
  if (direct) {
    handleDirectDownloadDelta(delta, direct);
    return;
  }

  const state = delta.state && delta.state.current;
  const entry = pendingBlobUrls.get(delta.id);

  if (entry && (state === 'complete' || state === 'interrupted')) {
    releaseBlobUrl(delta.id);

    // Repair the saved HLS file once it's fully written to disk.
    if (state === 'complete') {
      remuxDownloadedFile(delta.id, entry.streamUrl).catch((e) =>
        console.log('[Remux] Skipped:', e.message));
    }
    return;
  }

  // A direct browser download can outlive the MV3 service worker. If the
  // worker restarted, wait for its session mapping to restore before deciding
  // that this download is unrelated to Crawlcast.
  directDownloadsRestored.then(() => {
    const restored = directDownloads.get(delta.id);
    if (restored) handleDirectDownloadDelta(delta, restored);
  });
});

function handleDirectDownloadDelta(delta, entry) {
  if (delta.bytesReceived && Number.isFinite(delta.bytesReceived.current)) {
    entry.bytesReceived = delta.bytesReceived.current;
  }
  if (delta.totalBytes && Number.isFinite(delta.totalBytes.current)) {
    entry.totalBytes = delta.totalBytes.current;
  }
  persistDirectDownloads();

  const active = activeDownloads.get(entry.streamUrl);
  if (active) {
    active.lastProgressAt = Date.now();
    active.progress = {
      kind: 'direct',
      phase: 'downloading',
      bytesReceived: entry.bytesReceived || 0,
      totalBytes: entry.totalBytes || 0,
      mbDownloaded: ((entry.bytesReceived || 0) / 1e6).toFixed(1),
      percent: entry.totalBytes > 0
        ? Math.min(99, Math.round((entry.bytesReceived / entry.totalBytes) * 100))
        : 0
    };
    broadcast({ action: 'downloadProgress', url: entry.streamUrl, progress: active.progress });
  }

  const state = delta.state && delta.state.current;
  if (state === 'complete') {
    completeDirectDownload(delta.id, entry);
  } else if (state === 'interrupted') {
    directDownloads.delete(delta.id);
    activeDownloads.delete(entry.streamUrl);
    persistDirectDownloads();
    broadcast({
      action: 'downloadError',
      url: entry.streamUrl,
      error: delta.error?.current || 'MP4 download interrupted'
    });
    maybeCloseOffscreen();
  }
}

function completeDirectDownload(downloadId, entry) {
  if (!directDownloads.has(downloadId)) return;
  directDownloads.delete(downloadId);
  activeDownloads.delete(entry.streamUrl);
  persistDirectDownloads();

  broadcast({
    action: 'downloadComplete',
    url: entry.streamUrl,
    result: { filename: entry.filename }
  });

  remuxDownloadedFile(downloadId, entry.streamUrl).catch((e) =>
    console.log('[Remux] Skipped:', e.message));
  maybeCloseOffscreen();
}

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
      broadcast({
        action: 'remuxComplete', url: streamUrl, path: msg.path, merged: !!msg.merged
      });
      port.disconnect();
    } else if (msg.type === 'remuxSkipped' || msg.type === 'error') {
      console.log('[Remux] Skipped:', msg.message);
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
  const hasOffscreenDownload = Array.from(activeDownloads.values())
    .some((info) => info.kind !== 'direct');
  if (hasOffscreenDownload || pendingBlobUrls.size > 0 || thumbnailJobs.size > 0) return;
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

// Direct media formats Crawlcast can download. HLS keeps its existing
// playlist pipeline; MP4 uses chrome.downloads directly.
const M3U8_PATTERN = /\.m3u8(?:$|[?#])/i;
const MP4_PATTERN = /\.mp4(?:$|[?#])/i;

function getStreamFormat(streamOrUrl) {
  if (streamOrUrl && typeof streamOrUrl === 'object' && streamOrUrl.format) {
    return streamOrUrl.format;
  }
  const url = typeof streamOrUrl === 'string' ? streamOrUrl : streamOrUrl?.url || '';
  if (MP4_PATTERN.test(url)) return 'mp4';
  if (M3U8_PATTERN.test(url)) return 'm3u8';
  return null;
}

// Listen for network requests
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const url = details.url;
    const format = getStreamFormat(url);

    if (detectedStreams.has(url)) return;
    if (!format) return;

    const streamInfo = {
      url: url,
      timestamp: Date.now(),
      tabId: details.tabId,
      type: details.type,
      initiator: details.initiator || 'unknown',
      format,
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
    console.log(`[${format.toUpperCase()} Detector] Found:`, url);
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

  if (request.action === 'getModeState') {
    modeStateRestored.then(() => {
      sendResponse({ success: true, ...getModeState() });
    });
    return true;
  }

  if (request.action === 'setMode') {
    modeStateRestored.then(async () => {
      if (request.mode !== 'user' && request.mode !== 'god') {
        sendResponse({ success: false, error: 'Invalid mode' });
        return;
      }

      crawlcastMode = request.mode;
      await chrome.storage.local.set({ crawlcastMode });
      sendResponse({ success: true, ...getModeState() });
    });
    return true;
  }


  // Get streams for popup
  if (request.action === 'getStreams') {
    Promise.all([streamsRestored, directDownloadsRestored]).then(() => {
      const streams = Array.from(detectedStreams.values())
        .filter(s => s.tabId === request.tabId)
        .sort((a, b) => b.timestamp - a.timestamp)
        // Attach live download state — the popup loses its own copy
        // whenever it closes, so it must come from here
        .map(s => ({ ...s, downloading: activeDownloads.has(s.url) }));
      sendResponse({ streams });
    });
  }

  // Persist a user-edited title on the detected stream so it survives
  // popup closes for as long as the stream remains in session storage.
  if (request.action === 'setStreamTitle') {
    streamsRestored.then(() => {
      const stream = detectedStreams.get(request.url);
      if (!stream) {
        sendResponse({ success: false, error: 'Stream not found' });
        return;
      }

      const title = typeof request.title === 'string' ? request.title.trim() : '';
      stream.title = title || null;
      persistStreams();
      sendResponse({ success: true, title: stream.title });
    });
    return true;
  }

  // Clear streams
  if (request.action === 'clearStreams') {
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
    modeStateRestored.then(async () => {
      const now = Date.now();
      const state = getModeState();

      if (crawlcastMode === 'user' && !state.canDownload) {
        sendResponse({
          success: false,
          reason: 'rate_limit',
          ...state
        });
        return;
      }

      // Consume the User Mode slot as soon as the background accepts the
      // download. This prevents a second popup click/reopen from bypassing
      // the rolling-hour limit while the first download is still running.
      const consumedUserSlot = crawlcastMode === 'user';
      if (consumedUserSlot) {
        userModeLastDownloadAt = now;
        await chrome.storage.local.set({ userModeLastDownloadAt });
      }

      try {
        await startDownload(request.url, request.filename, sender.tab?.id || request.tabId);
        sendResponse({
          success: true,
          downloadId: request.url,
          ...getModeState()
        });
      } catch (err) {
        // If Crawlcast could not even start its download pipeline, give the
        // User Mode slot back. Later network/download failures still count.
        if (consumedUserSlot && userModeLastDownloadAt === now) {
          userModeLastDownloadAt = 0;
          await chrome.storage.local.set({ userModeLastDownloadAt: 0 });
        }
        sendResponse({ success: false, error: err?.message || String(err), ...getModeState() });
      }
    });
    return true;
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
      activeDownloads.delete(request.streamUrl);
      pendingBlobUrls.set(downloadId, {
        blobUrl: request.blobUrl,
        streamUrl: request.streamUrl
      });

      chrome.runtime.sendMessage({
        action: 'downloadComplete',
        url: request.streamUrl,
        result: { filename: request.filename }
      }).catch(() => {});

      // Small files can finish before we registered them — check state now.
      // If completion was missed by onChanged, run the same remux path here
      // before releasing the Blob URL.
      const [item] = await chrome.downloads.search({ id: downloadId });
      if (item && (item.state === 'complete' || item.state === 'interrupted')) {
        const entry = pendingBlobUrls.get(downloadId);
        releaseBlobUrl(downloadId);

        if (item.state === 'complete' && entry) {
          remuxDownloadedFile(downloadId, entry.streamUrl).catch((e) =>
            console.log('[Remux] Skipped:', e.message));
        }
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
    maybeCloseOffscreen();
  }

  // Popup asks for thumbnails of streams that don't have one yet
  if (request.action === 'generateThumbnails') {
    streamsRestored.then(async () => {
      const targets = (request.urls || []).filter((url) => {
        const s = detectedStreams.get(url);
        if (!s || thumbnailJobs.has(url)) return false;
        // Direct MP4s do not need the HLS parser/thumbnail pipeline. They
        // download straight through chrome.downloads and use a placeholder.
        if (getStreamFormat(s) === 'mp4') return false;
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
      maybeCloseOffscreen();
    });
  }

  // Cancel download
  // Cancel a download. The VideoDownloader lives in the offscreen document,
  // so forward the request there; also release our own tracking immediately
  // so a wedged offscreen doc can never lock the UI permanently.
  if (request.action === 'cancelDownload') {
    const active = activeDownloads.get(request.url);
    activeDownloads.delete(request.url);

    if (active?.kind === 'direct' && Number.isInteger(active.downloadId)) {
      directDownloads.delete(active.downloadId);
      persistDirectDownloads();
      chrome.downloads.cancel(active.downloadId).catch(() => {});
    } else {
      chrome.runtime.sendMessage({
        target: 'offscreen',
        action: 'cancelDownload',
        url: request.url
      }).catch(() => {});
    }

    broadcast({ action: 'downloadError', url: request.url, error: 'Cancelled' });
    maybeCloseOffscreen();
    sendResponse({ success: true });
  }

  return true;
});

// ---------------------------------------------------------------------------
// Native remux host
// ---------------------------------------------------------------------------

const NATIVE_HOST = 'com.crawlcast.downloader';

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
 * Start a detected video using the pipeline appropriate to its format.
 * HLS remains in the offscreen downloader; direct MP4s are handed to the
 * browser downloads API and repaired after the file is fully written.
 */
async function startDownload(url, filename, tabId) {
  const stream = detectedStreams.get(url);
  const format = getStreamFormat(stream || url);

  if (format === 'mp4') {
    return startDirectMp4Download(url, filename || 'video.mp4');
  }

  // Register before the await so maybeCloseOffscreen() can't close
  // the document out from under a download that's about to start
  activeDownloads.set(url, {
    kind: 'hls',
    progress: { percent: 0, downloaded: 0, total: 0 },
    startTime: Date.now()
  });

  await ensureOffscreenDocument();
  chrome.runtime.sendMessage({
    target: 'offscreen',
    action: 'downloadStream',
    url: url,
    filename: filename || 'video.mp4'
  }).catch((err) => console.error('[Offscreen] send failed:', err));
}

async function startDirectMp4Download(url, filename) {
  activeDownloads.set(url, {
    kind: 'direct',
    progress: {
      kind: 'direct',
      phase: 'downloading',
      percent: 0,
      bytesReceived: 0,
      totalBytes: 0,
      mbDownloaded: '0.0'
    },
    startTime: Date.now(),
    lastProgressAt: Date.now(),
    downloadId: null
  });

  try {
    const downloadId = await chrome.downloads.download({ url, filename });
    const entry = {
      streamUrl: url,
      filename,
      bytesReceived: 0,
      totalBytes: 0,
      startTime: Date.now()
    };
    directDownloads.set(downloadId, entry);
    persistDirectDownloads();

    const active = activeDownloads.get(url);
    if (active) active.downloadId = downloadId;

    // Pick up initial size/state immediately. Very small files may finish
    // before their first onChanged event reaches this service worker.
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (item) {
      entry.bytesReceived = item.bytesReceived || 0;
      entry.totalBytes = item.totalBytes || 0;

      if (item.state === 'complete') {
        completeDirectDownload(downloadId, entry);
      } else if (item.state === 'interrupted') {
        directDownloads.delete(downloadId);
        activeDownloads.delete(url);
        persistDirectDownloads();
        throw new Error(item.error || 'MP4 download interrupted');
      } else {
        handleDirectDownloadDelta({
          id: downloadId,
          bytesReceived: { current: entry.bytesReceived },
          totalBytes: { current: entry.totalBytes }
        }, entry);
      }
    }

    return downloadId;
  } catch (error) {
    activeDownloads.delete(url);
    throw error;
  }
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