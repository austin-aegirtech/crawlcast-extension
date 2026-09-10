/**
 * Free-tier download rate limit.
 *
 * Loaded into the background service worker via importScripts, same as
 * telemetry.js/auth.js/license.js.
 *
 * Free tier: FREE_DOWNLOADS_PER_HOUR download attempts per fixed clock hour
 * (resets on the hour, not a rolling window). A real Premium license
 * (see license.js) bypasses the limit entirely.
 *
 * Counting happens on download START, not completion — a cancelled or
 * failed download still counts. Simpler to reason about and harder to
 * game by cancelling right before a download finishes.
 */

const FREE_DOWNLOADS_PER_HOUR = 1;
const RATE_LIMIT_STORAGE_KEY = 'downloadRateLimit';

function currentHourBucket() {
  return Math.floor(Date.now() / 3600000);
}

/** Current bucket's state, resetting it in memory (not storage) if the hour has rolled over. */
async function getRateLimitState() {
  const data = await chrome.storage.local.get(RATE_LIMIT_STORAGE_KEY);
  const stored = data[RATE_LIMIT_STORAGE_KEY];
  const bucket = currentHourBucket();
  if (!stored || stored.bucket !== bucket) {
    return { bucket, count: 0 };
  }
  return stored;
}

/**
 * Whether a download is allowed to start right now.
 * @returns {Promise<{allowed: boolean, remaining: number, limit: number, resetInMs: number}>}
 */
async function canStartDownload() {
  if (await isLicensed()) {
    return { allowed: true, remaining: Infinity, limit: Infinity, resetInMs: 0 };
  }

  const state = await getRateLimitState();
  const resetInMs = (state.bucket + 1) * 3600000 - Date.now();

  if (state.count >= FREE_DOWNLOADS_PER_HOUR) {
    return { allowed: false, remaining: 0, limit: FREE_DOWNLOADS_PER_HOUR, resetInMs };
  }

  return {
    allowed: true,
    remaining: FREE_DOWNLOADS_PER_HOUR - state.count,
    limit: FREE_DOWNLOADS_PER_HOUR,
    resetInMs,
  };
}

/** Call once a download is actually about to start (after canStartDownload allowed it). */
async function recordDownloadStart() {
  if (await isLicensed()) return;

  const state = await getRateLimitState();
  state.count += 1;
  await chrome.storage.local.set({ [RATE_LIMIT_STORAGE_KEY]: state });
}
