// Track active downloads and their UI state
const activeDownloadsUI = new Map();

// Hover-animation frames per stream url (populated from getStreams / thumbnailReady)
const thumbFrames = new Map();

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  initAppHandlers();
  loadStreams();
});

let appHandlersInitialized = false;
function initAppHandlers() {
  if (appHandlersInitialized) return;
  appHandlersInitialized = true;

  document.getElementById('refreshBtn').addEventListener('click', loadStreams);
  document.getElementById('clearBtn').addEventListener('click', clearStreams);

  document.getElementById('logsBtn').addEventListener('click', toggleLogs);
  document.getElementById('logRefresh').addEventListener('click', loadLogs);
  document.getElementById('logCopy').addEventListener('click', copyLogs);
  document.getElementById('logClear').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ action: 'clearLogs' });
    loadLogs();
  });

  document.getElementById('externalBtn').addEventListener('click', startExternalDownload);
  document.getElementById('externalUrl').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') startExternalDownload();
  });
  
  // Listen for background messages
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'downloadProgress') {
      updateDownloadProgress(message.url, message.progress);
      // Keep the log panel current while it's open, without polling
      if (logsOpen) loadLogs();
    }
    if (message.action === 'downloadComplete') {
      onDownloadComplete(message.url, message.result);
    }
    if (message.action === 'downloadError') {
      onDownloadError(message.url, message.error, message.tooLarge);
    }
    if (message.action === 'externalProgress') {
      updateExternalProgress(message.percent, message.line);
    }
    if (message.action === 'externalComplete') {
      finishExternal(true, `✅ Saved: ${message.filename}`);
    }
    if (message.action === 'externalError') {
      finishExternal(false, `❌ ${message.error}`);
    }
    if (message.action === 'audioWarning') {
      setStatus(message.url, 'status-warn', '🔇 ' + message.message);
    }
    if (message.action === 'remuxStarted') {
      setStatus(message.url, 'status-success', message.merging
        ? '🔊 Merging audio track and repairing MP4 index…'
        : '🔧 Repairing MP4 index (making it seekable)…');
    }
    if (message.action === 'remuxComplete') {
      setStatus(message.url, 'status-success', message.merged
        ? '✅ Saved with audio merged — seeks properly now'
        : '✅ Saved and repaired — seeks properly now');
    }
    if (message.action === 'remuxSkipped') {
      // Not an error: the file downloaded fine, it just wasn't defragmented
      setStatus(message.url, 'status-warn',
        '⚠️ Saved, but not repaired (ffmpeg/native host unavailable). ' +
        'Playback may start slowly and seeking may be limited.');
    }
    if (message.action === 'streamMeta') {
      // Size arrives before the thumbnail — patch it in without a re-render
      const el = document.getElementById(`size-${hashCode(message.url)}`);
      if (el) el.innerHTML = renderSize(message.meta);
    }
    if (message.action === 'thumbnailReady' && message.thumbnail) {
      // Swap the placeholder for the freshly generated thumbnail in place
      if (message.frames && message.frames.length > 1) {
        thumbFrames.set(message.url, message.frames);
      }
      const placeholder = document.getElementById(`thumb-${hashCode(message.url)}`);
      if (placeholder) {
        const img = document.createElement('img');
        img.className = 'stream-thumb';
        img.src = message.thumbnail;
        img.dataset.url = message.url;
        placeholder.replaceWith(img);
        attachThumbHover(img);
      }
    }
  });
}

async function loadStreams() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const response = await chrome.runtime.sendMessage({
    action: 'getStreams',
    tabId: tab.id
  });

  renderStreams(response.streams || [], tab.id);

  // Lazily request thumbnails for streams that don't have one cached yet
  const missing = (response.streams || [])
    .filter(s => (!s.thumbnail && !s.thumbnailTried) || (!s.meta && !s.metaTried))
    .map(s => s.url);
  if (missing.length > 0) {
    chrome.runtime.sendMessage({
      action: 'generateThumbnails',
      tabId: tab.id,
      urls: missing
    }).catch(() => {});
  }
}

function renderStreams(streams, tabId) {
  console.log('streams :::', streams);
  const listEl = document.getElementById('streamList');
  const countEl = document.getElementById('streamCount');
  
  countEl.textContent = streams.length;
  
  if (streams.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="2" y="2" width="20" height="20" rx="5"/>
          <circle cx="12" cy="12" r="4"/>
          <path d="M12 8v8M8 12h8"/>
        </svg>
        <div>No M3U8 streams detected</div>
        <div style="margin-top: 8px; font-size: 12px; opacity: 0.7;">
          Play a video on this page to detect streams
        </div>
      </div>
    `;
    return;
  }
  
  listEl.innerHTML = streams.map((stream, index) => {
    const isDownloading = activeDownloadsUI.has(stream.url) || stream.downloading;
    const isDownloaded = !isDownloading && !!stream.downloaded;
    
    if (stream.frames && stream.frames.length > 1) {
      thumbFrames.set(stream.url, stream.frames);
    }

    const thumb = stream.thumbnail
      ? `<img class="stream-thumb" src="${stream.thumbnail}" data-url="${escapeHtml(stream.url)}" alt="">`
      : `<div class="stream-thumb stream-thumb-placeholder" id="thumb-${hashCode(stream.url)}">🎬</div>`;

    return `
      <div class="stream-item" data-url="${escapeHtml(stream.url)}">
        <div class="stream-row">
          ${thumb}
          <div class="stream-body">
            <div class="stream-header">
              <div class="stream-url">${escapeHtml(truncateUrl(stream.url, 70))}</div>
              ${stream.type === 'xmlhttprequest' ? '<span class="quality-badge">XHR</span>' : ''}
            </div>

            <div class="stream-meta">
              <span>⏱️ ${formatTime(stream.timestamp)}</span>
              <span>🌐 ${new URL(stream.url).hostname}</span>
            </div>

            <div class="stream-size" id="size-${hashCode(stream.url)}">
              ${renderSize(stream.meta)}
            </div>
          </div>
        </div>

        <div class="download-section">
          <div class="btn-row">
            <button
              class="btn-primary download-btn${isDownloaded ? ' btn-downloaded' : ''}"
              data-url="${escapeHtml(stream.url)}"
              data-tab="${tabId}"
              ${(isDownloading || isDownloaded) ? 'disabled' : ''}
            >
              ${isDownloading ? '⏳ Downloading...' : isDownloaded ? '✅ Downloaded' : '⬇️ Download as MP4'}
            </button>
            ${isDownloading ? `<button class="btn-danger cancel-btn" data-url="${escapeHtml(stream.url)}">✕ Cancel</button>` : ''}
          </div>

          <div class="progress-container ${isDownloading ? 'active' : ''}" id="progress-${hashCode(stream.url)}">
            <div class="progress-bar">
              <div class="progress-fill" style="width: 0%"></div>
            </div>
            <div class="progress-text">
              <span class="progress-status">Initializing...</span>
              <span class="progress-percent">0%</span>
            </div>
          </div>
          
          <div class="status-message" id="status-${hashCode(stream.url)}" style="display: none;"></div>
        </div>
      </div>
    `;
  }).join('');
  
  // Attach handlers
  document.querySelectorAll('.download-btn').forEach(btn => {
    btn.addEventListener('click', () => startDownload(btn.dataset.url, btn.dataset.tab));
  });

  document.querySelectorAll('.cancel-btn').forEach(btn => {
    btn.addEventListener('click', () => cancelDownload(btn.dataset.url));
  });

  document.querySelectorAll('img.stream-thumb').forEach(attachThumbHover);
}

/**
 * Cycle through captured preview frames while the cursor is over the
 * thumbnail; snap back to the first frame on leave.
 */
function attachThumbHover(img) {
  const frames = thumbFrames.get(img.dataset.url);
  if (!frames || frames.length < 2) return;

  let timer = null;
  let idx = 0;

  const FRAME_INTERVAL_MS = 600; // hover animation speed — one frame every 0.6s

  img.addEventListener('mouseenter', () => {
    idx = 0;
    timer = setInterval(() => {
      idx = (idx + 1) % frames.length;
      img.src = frames[idx];
    }, FRAME_INTERVAL_MS);
  });

  img.addEventListener('mouseleave', () => {
    clearInterval(timer);
    timer = null;
    img.src = frames[0];
  });
}

async function startDownload(url, tabId) {
  const filename = `video_${Date.now()}.mp4`;
  
  // Update UI state
  activeDownloadsUI.set(url, { startTime: Date.now() });
  
  // Re-render to show progress UI
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const response = await chrome.runtime.sendMessage({ 
    action: 'getStreams', 
    tabId: tab.id 
  });
  renderStreams(response.streams || [], tab.id);
  
  // Start download in background
  await chrome.runtime.sendMessage({
    action: 'startDownload',
    url: url,
    filename: filename,
    tabId: parseInt(tabId)
  });
}

function updateDownloadProgress(url, progress) {
  const hash = hashCode(url);
  const container = document.getElementById(`progress-${hash}`);
  const fill = container?.querySelector('.progress-fill');
  const status = container?.querySelector('.progress-status');
  const percent = container?.querySelector('.progress-percent');

  if (container && fill) {
    container.classList.add('active');
    fill.style.width = `${progress.percent}%`;

    if (status) {
      if (progress.phase === 'finalizing') {
        // Assembling a multi-GB Blob can take a while — say so rather than
        // sitting at 100% looking frozen
        status.textContent = `Finalizing ${progress.mbDownloaded} MB — this can take a moment…`;
      } else {
        const failed = progress.failed > 0 ? `, ${progress.failed} failed` : '';
        status.textContent =
          `Downloading: ${progress.downloaded}/${progress.total} segments (${progress.mbDownloaded} MB${failed})`;
      }
    }
    if (percent) percent.textContent = `${progress.percent}%`;
  }
}

function cancelDownload(url) {
  activeDownloadsUI.delete(url);
  chrome.runtime.sendMessage({ action: 'cancelDownload', url }).catch(() => {});
  loadStreams();
}

/** Set a stream card's status line */
function setStatus(url, className, text) {
  const el = document.getElementById(`status-${hashCode(url)}`);
  if (!el) return;
  el.style.display = 'block';
  el.className = `status-message ${className}`;
  el.textContent = text;
}

function onDownloadComplete(url, result) {
  activeDownloadsUI.delete(url);
  
  const hash = hashCode(url);
  const statusEl = document.getElementById(`status-${hash}`);
  
  if (statusEl) {
    statusEl.style.display = 'block';
    statusEl.className = 'status-message status-success';
    statusEl.textContent = `✅ Download complete: ${result.filename}`;
  }
  
  // Lock the button rather than re-enabling it — the file is already saved,
  // so offering "Download as MP4" again invites a confusing duplicate.
  // background.js persists this on the stream record too, so it stays
  // locked even if the popup is closed and reopened.
  const btn = document.querySelector(`button[data-url="${CSS.escape(url)}"]`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = '✅ Downloaded';
    btn.classList.add('btn-downloaded');
  }
}

function onDownloadError(url, error, tooLarge) {
  activeDownloadsUI.delete(url);

  const hash = hashCode(url);
  const statusEl = document.getElementById(`status-${hash}`);

  if (statusEl) {
    statusEl.style.display = 'block';
    statusEl.className = 'status-message status-error';
    statusEl.textContent = `❌ ${error}`;

    // Too big for memory — offer one-click handoff to the external downloader
    if (tooLarge) {
      const handoff = document.createElement('button');
      handoff.className = 'btn-secondary handoff-btn';
      handoff.textContent = '↪ Send to external downloader';
      handoff.addEventListener('click', () => {
        document.getElementById('externalUrl').value = url;
        startExternalDownload();
      });
      statusEl.appendChild(handoff);
    }
  }

  // Re-render so the Cancel button disappears and Download re-enables
  loadStreams();
}

// ------------------------------------------------------------ diagnostics

let logsOpen = false;
let logCache = [];

function toggleLogs() {
  logsOpen = !logsOpen;
  document.getElementById('logPanel').classList.toggle('open', logsOpen);
  document.getElementById('logsBtn').textContent = logsOpen ? '📋 Hide logs' : '📋 Logs';
  if (logsOpen) loadLogs();
}

async function loadLogs() {
  const res = await chrome.runtime.sendMessage({ action: 'getLogs' }).catch(() => null);
  logCache = (res && res.logs) || [];
  renderLogs();
}

function renderLogs() {
  const body = document.getElementById('logBody');
  document.getElementById('logCount').textContent =
    `${logCache.length} entr${logCache.length === 1 ? 'y' : 'ies'}`;

  if (!logCache.length) {
    body.innerHTML = '<div class="log-empty">No log entries yet — start a download.</div>';
    return;
  }

  body.innerHTML = logCache.map(e => `
    <div class="log-row ${e.level}">
      <span class="log-time">${new Date(e.ts).toLocaleTimeString()}</span>
      <span class="log-src ${e.source}">${e.source}</span>
      <span class="log-msg">${escapeHtml(e.message)}</span>
    </div>`).join('');

  body.scrollTop = body.scrollHeight; // newest at the bottom
}

function copyLogs() {
  const text = logCache.map(e =>
    `${new Date(e.ts).toISOString()} [${e.level.toUpperCase()}] ${e.source}: ${e.message}`
  ).join('\n');

  navigator.clipboard.writeText(text || '(no entries)');
  const btn = document.getElementById('logCopy');
  btn.textContent = 'Copied ✓';
  setTimeout(() => (btn.textContent = 'Copy all'), 1500);
}

// --------------------------------------------------------- external bridge

function startExternalDownload() {
  const input = document.getElementById('externalUrl');
  const url = input.value.trim();
  if (!url) return;

  const btn = document.getElementById('externalBtn');
  btn.disabled = true;
  btn.textContent = '⏳';

  const container = document.getElementById('externalProgress');
  container.classList.add('active');
  container.querySelector('.progress-fill').style.width = '0%';
  container.querySelector('.progress-status').textContent = 'Starting…';
  container.querySelector('.progress-percent').textContent = '0%';
  document.getElementById('externalStatus').style.display = 'none';

  chrome.runtime.sendMessage({ action: 'startExternalDownload', url }).catch(() => {});
}

function updateExternalProgress(percent, line) {
  const container = document.getElementById('externalProgress');
  container.classList.add('active');
  container.querySelector('.progress-fill').style.width = `${percent}%`;
  container.querySelector('.progress-percent').textContent = `${percent.toFixed(1)}%`;
  container.querySelector('.progress-status').textContent = 'Downloading…';
}

function finishExternal(ok, text) {
  const btn = document.getElementById('externalBtn');
  btn.disabled = false;
  btn.textContent = 'Fetch';

  document.getElementById('externalProgress').classList.remove('active');

  const status = document.getElementById('externalStatus');
  status.style.display = 'block';
  status.className = 'status-message ' + (ok ? 'status-success' : 'status-error');
  status.textContent = text;
}

async function clearStreams() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.runtime.sendMessage({ 
    action: 'clearStreams', 
    tabId: tab.id 
  });
  loadStreams();
}

// In-browser downloads buffer everything in memory; above this the popup
// steers you to the external downloader. Keep in sync with
// VideoDownloader.memoryLimitBytes in downloader.js.
const MEMORY_LIMIT_BYTES = 1.5e9;

/** Size / duration / quality line for a stream card */
function renderSize(meta) {
  if (!meta) return '<span class="size-pending">Analyzing…</span>';

  const parts = [];
  if (meta.bytes) {
    const tooBig = meta.bytes > MEMORY_LIMIT_BYTES;
    parts.push(
      `<span class="size-value ${tooBig ? 'size-warn' : ''}">📦 ~${formatBytes(meta.bytes)}</span>`
    );
  }
  if (meta.durationSeconds) parts.push(`<span>🎞️ ${formatDuration(meta.durationSeconds)}</span>`);
  if (meta.resolution) parts.push(`<span>🖥️ ${escapeHtml(meta.resolution)}</span>`);
  parts.push(`<span>${meta.segments} segments</span>`);

  let html = parts.join('');
  if (meta.bytes && meta.bytes > MEMORY_LIMIT_BYTES) {
    html += '<div class="size-hint">⚠️ Too large for in-browser download — use the external downloader</div>';
  }
  return html;
}

function formatBytes(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(0) + ' MB';
  return (bytes / 1e3).toFixed(0) + ' KB';
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`;
}

// Utility functions
function truncateUrl(url, maxLen) {
  return url.length > maxLen ? url.substring(0, maxLen) + '...' : url;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatTime(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}