/**
 * Lightweight telemetry for the self-hosted metrics dashboard.
 * Events are batched in memory and flushed to the collector endpoint.
 * Everything fails silently — metrics must never break the extension.
 *
 * Privacy: only an anonymous install UUID, extension version, event names
 * and numeric metrics are sent. Stream URLs are never transmitted
 * (stream_detected carries the page hostname only).
 */

// const TELEMETRY_ENDPOINT = 'https://ployan.me/crawlcast-metrics/collect';
const TELEMETRY_ENDPOINT = 'http://127.0.0.1:8787/collect';
const TELEMETRY_FLUSH_MS = 5000;   // debounce window before a batch is sent
const TELEMETRY_MAX_BATCH = 20;    // flush immediately at this queue size

let telemetryQueue = [];
let telemetryTimer = null;
let installIdPromise = null;

/** Anonymous per-install UUID, created once and kept in storage.local */
function getInstallId() {
  if (!installIdPromise) {
    installIdPromise = chrome.storage.local.get('installId').then(async (data) => {
      if (data.installId) return data.installId;
      const id = crypto.randomUUID();
      await chrome.storage.local.set({ installId: id });
      return id;
    });
  }
  return installIdPromise;
}

/** Queue an event; batches are flushed after a short debounce */
function trackEvent(event, props = {}) {
  telemetryQueue.push({ event, props, ts: Date.now() });

  if (telemetryQueue.length >= TELEMETRY_MAX_BATCH) {
    flushTelemetry();
  } else if (!telemetryTimer) {
    telemetryTimer = setTimeout(flushTelemetry, TELEMETRY_FLUSH_MS);
  }
}

async function flushTelemetry() {
  if (telemetryTimer) {
    clearTimeout(telemetryTimer);
    telemetryTimer = null;
  }
  if (telemetryQueue.length === 0) return;

  const events = telemetryQueue;
  telemetryQueue = [];

  try {
    const installId = await getInstallId();
    await fetch(TELEMETRY_ENDPOINT, {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        installId,
        version: chrome.runtime.getManifest().version,
        events
      })
    });
  } catch (e) {
    // Collector unreachable — drop the batch, never disturb the extension
  }
}

// First-install / update event
chrome.runtime.onInstalled.addListener((details) => {
  trackEvent('extension_installed', { reason: details.reason });
});
