// Track active downloads and their UI state
const activeDownloadsUI = new Map();
const completedDownloadsUI = new Set();

// Hover-animation frames per stream url (populated from getStreams / thumbnailReady)
const thumbFrames = new Map();

// Current page title is used for card labels and download filenames.
let currentPageTitle = '';

// Free-tier mode state comes from background.js so closing the popup never
// resets or bypasses the rolling download limit.
let currentMode = 'user';
let userModeNextAllowedAt = 0;
let rateLimitCountdownTimer = null;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  initAppHandlers();
  loadModeState();
  loadStreams();
});

// Wired once on load.
let appHandlersInitialized = false;
function initAppHandlers() {
  if (appHandlersInitialized) return;
  appHandlersInitialized = true;

  document.getElementById('clearBtn').addEventListener('click', clearStreams);
  document.getElementById('premiumBtn').addEventListener('click', showPremiumComingSoon);
  document.getElementById('premiumClose').addEventListener('click', closePremium);
  document.getElementById('modeToggle').addEventListener('click', toggleMode);

  document.getElementById('logsBtn').addEventListener('click', toggleLogs);
  document.getElementById('logClose').addEventListener('click', () => setLogsOpen(false));
  document.getElementById('logRefresh').addEventListener('click', loadLogs);
  document.getElementById('logCopy').addEventListener('click', copyLogs);
  document.getElementById('logClear').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ action: 'clearLogs' });
    loadLogs();
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
    if (message.action === 'audioWarning') {
      setStatus(message.url, 'status-warn', '🔇 ' + message.message);
    }
    if (message.action === 'remuxStarted') {
      setDownloadStage(message.url, 'Repairing MP4 file…', 100);
      setStatus(message.url, 'status-success', message.merging
        ? '🔊 Merging audio track and repairing MP4 file…'
        : '🔧 Repairing MP4 file…');
    }
    if (message.action === 'remuxComplete') {
      markDownloadComplete(message.url);
      setStatus(message.url, 'status-success', message.merged
        ? '✅ Complete — audio merged and MP4 repaired'
        : '✅ Complete — MP4 saved and repaired');
    }
    if (message.action === 'remuxSkipped') {
      // Not an error: the file downloaded fine, it just wasn't defragmented
      markRepairSkipped(message.url);
      setStatus(message.url, 'status-warn',
        '⚠️ Saved, but not repaired (ffmpeg/native host unavailable). ' +
        'Playback may start slowly and seeking may be limited.');
    }
    if (message.action === 'streamMeta') {
      // Metadata arrives independently of the thumbnail — patch it in without a re-render.
      const el = document.getElementById(`size-${hashCode(message.url)}`);
      if (el) el.innerHTML = renderSize(message.meta);
      updateDurationBadge(message.url, message.meta);
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

async function loadModeState() {
  const response = await chrome.runtime.sendMessage({ action: 'getModeState' }).catch(() => null);
  if (response?.success) applyModeState(response);
}

async function toggleMode() {
  const button = document.getElementById('modeToggle');
  const nextMode = currentMode === 'user' ? 'god' : 'user';
  button.disabled = true;

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'setMode',
      mode: nextMode
    });
    if (response?.success) applyModeState(response);
  } finally {
    button.disabled = false;
  }
}

function applyModeState(state) {
  currentMode = state.mode === 'god' ? 'god' : 'user';
  userModeNextAllowedAt = Number(state.nextAllowedAt) || 0;

  const button = document.getElementById('modeToggle');
  const label = document.getElementById('modeLabel');
  const isGodMode = currentMode === 'god';

  button.classList.toggle('god', isGodMode);
  button.setAttribute('aria-pressed', String(isGodMode));
  label.textContent = isGodMode ? 'God Mode' : 'User Mode';

  if (isGodMode) {
    button.title = 'God Mode — unlimited downloads';
  } else {
    updateUserModeTitle();
  }

  syncRateLimitUI();
}

function isUserModeRateLimited() {
  return currentMode === 'user' && userModeNextAllowedAt > Date.now();
}

function updateUserModeTitle() {
  const button = document.getElementById('modeToggle');
  if (!button || currentMode !== 'user') return;

  const remainingMs = Math.max(0, userModeNextAllowedAt - Date.now());
  button.title = remainingMs > 0
    ? `User Mode — next download available in ${formatRemainingTime(remainingMs)}`
    : 'User Mode — 1 download per hour';
}

function syncRateLimitUI() {
  if (rateLimitCountdownTimer) {
    clearInterval(rateLimitCountdownTimer);
    rateLimitCountdownTimer = null;
  }

  updateRateLimitCountdown();

  if (!isUserModeRateLimited()) return;

  rateLimitCountdownTimer = setInterval(() => {
    updateRateLimitCountdown();
  }, 1000);
}

function updateRateLimitCountdown() {
  const indicator = document.getElementById('premiumLimitCountdown');
  const value = document.getElementById('premiumCountdownValue');
  if (!indicator || !value) return;

  const remainingMs = Math.max(0, userModeNextAllowedAt - Date.now());
  const limited = currentMode === 'user' && remainingMs > 0;

  indicator.hidden = !limited;

  document.querySelectorAll('.download-btn').forEach((button) => {
    const isIdle = button.dataset.state === 'idle';
    if (limited) {
      if (isIdle) button.disabled = true;
    } else if (isIdle) {
      button.disabled = false;
    }
  });

  if (!limited) {
    if (rateLimitCountdownTimer) {
      clearInterval(rateLimitCountdownTimer);
      rateLimitCountdownTimer = null;
    }
    if (currentMode === 'user' && userModeNextAllowedAt > 0) {
      userModeNextAllowedAt = 0;
    }
    updateUserModeTitle();
    return;
  }

  value.textContent = formatCountdown(remainingMs);
  updateUserModeTitle();
}

async function loadStreams() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentPageTitle = tab.title || '';

  const response = await chrome.runtime.sendMessage({
    action: 'getStreams',
    tabId: tab.id
  });

  renderStreams(response.streams || [], tab.id, currentPageTitle);

  // Lazily request thumbnails for streams that don't have one cached yet
  const missing = (response.streams || [])
    .filter(s => getStreamFormat(s) !== 'mp4')
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

function renderStreams(streams, tabId, pageTitle = currentPageTitle) {
  const listEl = document.getElementById('streamList');
  const countEl = document.getElementById('streamCount');
  const toolbarStatus = document.getElementById('toolbarStatus');
  const sectionSummary = document.getElementById('streamSectionSummary');

  countEl.textContent = streams.length;
  toolbarStatus.textContent = streams.length === 0
    ? 'Ready — no streams detected'
    : `Ready — ${streams.length} stream${streams.length === 1 ? '' : 's'} detected`;
  sectionSummary.textContent = streams.length === 0
    ? 'Waiting for video…'
    : `${streams.length} available`;

  if (streams.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <rect x="2" y="2" width="20" height="20" rx="5"/>
          <circle cx="12" cy="12" r="4"/>
          <path d="M12 8v8M8 12h8"/>
        </svg>
        <strong>No video streams detected</strong>
        <span>Play a video on this page and Crawlcast will detect available streams.</span>
      </div>
    `;
    return;
  }

  listEl.innerHTML = streams.map((stream) => {
    const isComplete = completedDownloadsUI.has(stream.url);
    const isDownloading = !isComplete && (activeDownloadsUI.has(stream.url) || stream.downloading);
    const isRateLimited = isUserModeRateLimited();
    const hash = hashCode(stream.url);
    const displayTitle = getStreamTitle(stream, pageTitle);
    const duration = stream.meta?.durationSeconds
      ? formatDurationCompact(stream.meta.durationSeconds)
      : '';

    if (stream.frames && stream.frames.length > 1) {
      thumbFrames.set(stream.url, stream.frames);
    }

    const thumb = stream.thumbnail
      ? `<img class="stream-thumb" src="${stream.thumbnail}" data-url="${escapeHtml(stream.url)}" alt="">`
      : `<div class="stream-thumb stream-thumb-placeholder" id="thumb-${hash}">🎬</div>`;

    const requestType = formatRequestType(stream.type);
    const streamFormat = getStreamFormat(stream);
    const formatLabel = streamFormat === 'mp4' ? 'MP4' : 'M3U8';

    return `
      <article class="stream-item" data-url="${escapeHtml(stream.url)}">
        <div class="stream-row">
          <div class="stream-thumb-wrap">
            ${thumb}
            <div class="duration-badge ${duration ? 'visible' : ''}" id="duration-${hash}">
              <span class="duration-play">▶</span>
              <span class="duration-value">${duration}</span>
            </div>
          </div>

          <div class="stream-body">
            <div class="title-row">
              <div class="badges">
                <span class="format-badge">${formatLabel}</span>
                ${requestType ? `<span class="request-badge">${escapeHtml(requestType)}</span>` : ''}
              </div>
              <div
                class="stream-title ${isDownloading || isComplete ? 'title-locked' : ''}"
                id="title-${hash}"
                data-url="${escapeHtml(stream.url)}"
                data-fallback-title="${escapeHtml(pageTitle || '')}"
                title="${escapeHtml(displayTitle)}"
              >
                <span class="stream-title-text">${escapeHtml(displayTitle)}</span>
                ${isDownloading || isComplete ? '' : `
                  <button
                    class="title-edit-btn"
                    type="button"
                    data-url="${escapeHtml(stream.url)}"
                    aria-label="Edit title"
                    title="Edit title"
                  >✎</button>
                `}
              </div>
            </div>

            <div class="stream-meta">
              <span class="meta-chip">${escapeHtml(getHostname(stream.url))}</span>
              <span class="meta-chip">Detected ${formatTime(stream.timestamp)}</span>
            </div>

            <div class="stream-size" id="size-${hash}">
              ${renderSize(stream.meta, streamFormat)}
            </div>

            <a class="stream-url" href="${escapeHtml(stream.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(stream.url)}">
              ${escapeHtml(stream.url)}
            </a>

            <div class="card-actions">
              ${isDownloading ? `<button class="cancel-btn" id="cancel-${hash}" data-url="${escapeHtml(stream.url)}" type="button">Cancel</button>` : ''}
              <button
                class="download-btn"
                id="download-${hash}"
                data-url="${escapeHtml(stream.url)}"
                data-tab="${tabId}"
                data-state="${isComplete ? 'complete' : (isDownloading ? 'downloading' : 'idle')}"
                type="button"
                ${isDownloading || isComplete || isRateLimited ? 'disabled' : ''}
              >
                <span class="download-icon">${isComplete ? '✓' : '↓'}</span>
                <span>${isComplete ? 'Complete!' : (isDownloading ? 'Downloading…' : 'Download')}</span>
              </button>
            </div>
          </div>
        </div>

        <div class="progress-container ${isDownloading || isComplete ? 'active' : ''}" id="progress-${hash}">
          <progress class="progress-bar" max="100" value="${isComplete ? '100' : '0'}" aria-label="Download progress"></progress>
          <div class="progress-text">
            <span class="progress-status">${isComplete ? 'Complete' : 'Initializing...'}</span>
            <span class="progress-percent">${isComplete ? '100%' : '0%'}</span>
          </div>
        </div>

        <div class="status-message" id="status-${hash}" hidden></div>
      </article>
    `;
  }).join('');

  document.querySelectorAll('.download-btn').forEach(btn => {
    btn.addEventListener('click', () => startDownload(btn.dataset.url, btn.dataset.tab));
  });

  document.querySelectorAll('.cancel-btn').forEach(btn => {
    btn.addEventListener('click', () => cancelDownload(btn.dataset.url));
  });

  document.querySelectorAll('.stream-title:not(.title-locked)').forEach(titleEl => {
    titleEl.addEventListener('click', (event) => {
      if (event.target.closest('.title-edit-btn')) return;
      beginTitleEdit(titleEl.dataset.url);
    });
  });

  document.querySelectorAll('.title-edit-btn').forEach(btn => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      beginTitleEdit(btn.dataset.url);
    });
  });

  document.querySelectorAll('img.stream-thumb').forEach(attachThumbHover);
}

function beginTitleEdit(url) {
  const titleEl = document.getElementById(`title-${hashCode(url)}`);
  if (!titleEl || titleEl.classList.contains('title-locked') || titleEl.querySelector('.stream-title-input')) {
    return;
  }

  const textEl = titleEl.querySelector('.stream-title-text');
  const originalTitle = textEl?.textContent?.trim() || '';
  const fallbackTitle = titleEl.dataset.fallbackTitle || currentPageTitle || '';

  const input = document.createElement('input');
  input.className = 'stream-title-input';
  input.type = 'text';
  input.value = originalTitle;
  input.maxLength = 240;
  input.setAttribute('aria-label', 'Download title');

  titleEl.classList.add('editing');
  titleEl.replaceChildren(input);
  input.focus();
  input.select();

  let finished = false;

  const finish = async (save) => {
    if (finished) return;
    finished = true;

    const requestedTitle = save ? input.value.trim() : originalTitle;
    let displayTitle = requestedTitle || fallbackTitle.trim() || 'Detected HLS stream';

    if (save) {
      const response = await chrome.runtime.sendMessage({
        action: 'setStreamTitle',
        url,
        title: requestedTitle
      }).catch(() => null);

      if (!response?.success) {
        displayTitle = originalTitle || fallbackTitle.trim() || 'Detected HLS stream';
        setStatus(url, 'status-error', '❌ Could not save title');
      }
    }

    titleEl.classList.remove('editing');
    titleEl.title = displayTitle;

    const span = document.createElement('span');
    span.className = 'stream-title-text';
    span.textContent = displayTitle;

    const button = document.createElement('button');
    button.className = 'title-edit-btn';
    button.type = 'button';
    button.dataset.url = url;
    button.setAttribute('aria-label', 'Edit title');
    button.title = 'Edit title';
    button.textContent = '✎';
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      beginTitleEdit(url);
    });

    titleEl.replaceChildren(span, button);
  };

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      input.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finished = true;
      titleEl.classList.remove('editing');
      titleEl.title = originalTitle;

      const span = document.createElement('span');
      span.className = 'stream-title-text';
      span.textContent = originalTitle;

      const button = document.createElement('button');
      button.className = 'title-edit-btn';
      button.type = 'button';
      button.dataset.url = url;
      button.setAttribute('aria-label', 'Edit title');
      button.title = 'Edit title';
      button.textContent = '✎';
      button.addEventListener('click', (clickEvent) => {
        clickEvent.stopPropagation();
        beginTitleEdit(url);
      });

      titleEl.replaceChildren(span, button);
    }
  });

  input.addEventListener('blur', () => {
    finish(true);
  }, { once: true });
}

function getCardTitle(url) {
  const titleEl = document.getElementById(`title-${hashCode(url)}`);
  const input = titleEl?.querySelector('.stream-title-input');
  if (input) return input.value.trim();

  const text = titleEl?.querySelector('.stream-title-text')?.textContent?.trim();
  return text || currentPageTitle;
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
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentPageTitle = tab?.title || currentPageTitle;
  const filename = buildDownloadFilename(getCardTitle(url));

  // Ask the background worker first. User Mode is enforced there so popup
  // closes/reopens cannot reset or bypass the rolling-hour limit.
  const startResult = await chrome.runtime.sendMessage({
    action: 'startDownload',
    url: url,
    filename: filename,
    tabId: parseInt(tabId)
  });

  if (startResult?.mode) applyModeState(startResult);

  if (!startResult?.success) {
    if (startResult?.reason === 'rate_limit') {
      setStatus(
        url,
        'status-warn',
        `⏱️ User Mode allows 1 download per hour. Try again in ${formatRemainingTime(startResult.remainingMs)}.`
      );
      return;
    }

    setStatus(url, 'status-error', `❌ ${startResult?.error || 'Could not start download'}`);
    return;
  }

  completedDownloadsUI.delete(url);
  activeDownloadsUI.set(url, { startTime: Date.now() });

  // Re-render to show progress UI using the background worker's live state.
  const response = await chrome.runtime.sendMessage({
    action: 'getStreams',
    tabId: tab.id
  });
  renderStreams(response.streams || [], tab.id, currentPageTitle);
}

function updateDownloadProgress(url, progress) {
  const hash = hashCode(url);
  const container = document.getElementById(`progress-${hash}`);
  const progressBar = container?.querySelector('.progress-bar');
  const status = container?.querySelector('.progress-status');
  const percent = container?.querySelector('.progress-percent');

  if (container && progressBar) {
    container.classList.add('active');

    if (progress.kind === 'direct') {
      const received = Number(progress.bytesReceived) || 0;
      const total = Number(progress.totalBytes) || 0;

      if (total > 0) {
        progressBar.value = progress.percent;
        if (percent) percent.textContent = `${progress.percent}%`;
        if (status) status.textContent = `Downloading: ${formatBytes(received)} / ${formatBytes(total)}`;
      } else {
        // Native <progress> becomes indeterminate without a value attribute.
        progressBar.removeAttribute('value');
        if (percent) percent.textContent = '';
        if (status) status.textContent = `Downloading: ${formatBytes(received)}`;
      }
      return;
    }

    progressBar.value = progress.percent;

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
  el.hidden = false;
  el.className = `status-message ${className}`;
  el.textContent = text;
}

function onDownloadComplete(url, result) {
  // chrome.downloads has accepted the file, but Crawlcast may still need to
  // repair the MP4. Keep the card in its active state until remuxComplete.
  setDownloadStage(url, 'Saving MP4 file…', 100);
  setStatus(url, 'status-success', `💾 Saved ${result.filename} — finishing MP4 processing…`);
}

function setDownloadStage(url, label, percentValue) {
  const hash = hashCode(url);
  const container = document.getElementById(`progress-${hash}`);
  if (!container) return;

  container.classList.add('active');
  const status = container.querySelector('.progress-status');
  const percent = container.querySelector('.progress-percent');
  const progressBar = container.querySelector('.progress-bar');

  if (status) status.textContent = label;
  if (typeof percentValue === 'number') {
    if (progressBar) progressBar.value = percentValue;
    if (percent) percent.textContent = `${percentValue}%`;
  }
}

function markDownloadComplete(url) {
  activeDownloadsUI.delete(url);
  completedDownloadsUI.add(url);
  setDownloadStage(url, 'Complete', 100);

  const hash = hashCode(url);
  const cancel = document.getElementById(`cancel-${hash}`);
  if (cancel) cancel.remove();

  const btn = document.getElementById(`download-${hash}`);
  if (btn) {
    btn.dataset.state = 'complete';
    btn.disabled = true;
    btn.innerHTML = '<span class="download-icon">✓</span><span>Complete!</span>';
  }
}

function markRepairSkipped(url) {
  activeDownloadsUI.delete(url);
  completedDownloadsUI.delete(url);
  setDownloadStage(url, 'Saved — repair skipped', 100);

  const hash = hashCode(url);
  const cancel = document.getElementById(`cancel-${hash}`);
  if (cancel) cancel.remove();

  const btn = document.getElementById(`download-${hash}`);
  if (btn) {
    btn.dataset.state = 'idle';
    btn.disabled = isUserModeRateLimited();
    btn.innerHTML = '<span class="download-icon">↓</span><span>Download</span>';
  }
}

function onDownloadError(url, error, tooLarge) {
  activeDownloadsUI.delete(url);
  completedDownloadsUI.delete(url);

  const hash = hashCode(url);
  const statusEl = document.getElementById(`status-${hash}`);

  if (statusEl) {
    statusEl.hidden = false;
    statusEl.className = 'status-message status-error';
    statusEl.textContent = `❌ ${error}`;

  }

  // Re-render so the Cancel button disappears and Download re-enables
  loadStreams();
}

// ------------------------------------------------------------ diagnostics

let logsOpen = false;
let logCache = [];

function toggleLogs() {
  setLogsOpen(!logsOpen);
}

function setLogsOpen(open) {
  logsOpen = open;
  document.getElementById('logPanel').classList.toggle('open', logsOpen);
  document.getElementById('logsBtn').classList.toggle('active', logsOpen);
  document.getElementById('logsBtnLabel').textContent = logsOpen ? 'Hide logs' : 'Logs';
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


async function clearStreams() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.runtime.sendMessage({ 
    action: 'clearStreams', 
    tabId: tab.id 
  });
  loadStreams();
}

function closePremium() {
  document.getElementById('premiumCard').hidden = true;
}

function showPremiumComingSoon() {
  const status = document.getElementById('premiumStatus');
  const button = document.getElementById('premiumBtn');
  status.classList.add('visible');
  button.querySelector('span:last-child').textContent = 'Coming soon';
}

function updateDurationBadge(url, meta) {
  const badge = document.getElementById(`duration-${hashCode(url)}`);
  if (!badge) return;

  const value = badge.querySelector('.duration-value');
  if (meta?.durationSeconds) {
    value.textContent = formatDurationCompact(meta.durationSeconds);
    badge.classList.add('visible');
  } else {
    badge.classList.remove('visible');
  }
}

function getStreamTitle(stream, pageTitle) {
  const title = (stream?.title || pageTitle || '').trim();
  if (title) return title;
  return getStreamFormat(stream) === 'mp4' ? 'Detected MP4 video' : 'Detected HLS stream';
}

function getStreamFormat(stream) {
  if (stream?.format === 'mp4' || stream?.format === 'm3u8') return stream.format;
  const url = stream?.url || '';
  return /\.mp4(?:$|[?#])/i.test(url) ? 'mp4' : 'm3u8';
}

function formatRequestType(type) {
  if (!type) return '';
  if (type === 'xmlhttprequest') return 'XHR';
  return type;
}

function getHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'Unknown host';
  }
}

function buildDownloadFilename(title) {
  let base = (title || '').trim();

  // Avoid duplicate extensions when a page title already ends in a video extension.
  base = base.replace(/\.(mp4|m4v|mov|mkv|webm)$/i, '');

  // Windows-invalid filename characters plus ASCII control characters.
  base = base
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim();

  if (!base) return `video_${Date.now()}.mp4`;

  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) {
    base = `video_${base}`;
  }

  // Leave room for the extension and keep the filename comfortably below OS path limits.
  base = base.slice(0, 180).replace(/[. ]+$/g, '').trim();
  return base ? `${base}.mp4` : `video_${Date.now()}.mp4`;
}

// In-browser downloads buffer everything in memory. Keep in sync with
// VideoDownloader.memoryLimitBytes in downloader.js.
const MEMORY_LIMIT_BYTES = 1.5e9;

/** Size / duration / quality line for a stream card */
function renderSize(meta, format = 'm3u8') {
  if (!meta) {
    return format === 'mp4'
      ? '<span class="size-pending">Direct MP4</span>'
      : '<span class="size-pending">Analyzing…</span>';
  }

  const parts = [];
  if (meta.bytes) {
    const tooBig = meta.bytes > MEMORY_LIMIT_BYTES;
    parts.push(
      `<span class="size-value ${tooBig ? 'size-warn' : ''}">📦 ~${formatBytes(meta.bytes)}</span>`
    );
  }
  if (meta.durationSeconds) parts.push(`<span>🎞️ ${formatDuration(meta.durationSeconds)}</span>`);
  if (meta.resolution) parts.push(`<span>🖥️ ${escapeHtml(meta.resolution)}</span>`);
  if (meta.segments) parts.push(`<span>${meta.segments} segments</span>`);

  let html = parts.join('');
  if (meta.bytes && meta.bytes > MEMORY_LIMIT_BYTES) {
    html += '<div class="size-hint">⚠️ Too large for in-browser download</div>';
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

function formatDurationCompact(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function formatRemainingTime(ms) {
  const totalSeconds = Math.max(1, Math.ceil((Number(ms) || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes >= 1) {
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  }
  return `${seconds}s`;
}

function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.ceil((Number(ms) || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
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