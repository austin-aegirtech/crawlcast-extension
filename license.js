/**
 * Premium license status + Stripe checkout, talking to the standalone
 * crawlcast-license-server (separate repo — see its README for setup).
 *
 * Loaded into the background service worker via importScripts, alongside
 * telemetry.js (whose getInstallId() this reuses directly — same anonymous
 * per-install UUID that already backs telemetry, no need for a second ID).
 *
 * Status is cached in chrome.storage.local so most checks (e.g. gating a
 * download) don't hit the network — only refreshed if stale or explicitly
 * forced (e.g. right after returning from a checkout attempt).
 */

// Point this at wherever crawlcast-license-server is actually deployed.
// Defaults to local dev — same pattern telemetry.js uses for its endpoint.
const LICENSE_SERVER_URL = 'http://127.0.0.1:8788';

const LICENSE_STATUS_STORAGE_KEY = 'licenseStatus';
const LICENSE_STATUS_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

/**
 * Cached license check — used by rateLimit.js on every download attempt,
 * so this deliberately avoids a network call unless the cache is stale or
 * has never been populated.
 * @returns {Promise<boolean>}
 */
async function isLicensed() {
  const status = await getCachedLicenseStatus();
  const age = Date.now() - (status.checkedAt || 0);

  if (age > LICENSE_STATUS_MAX_AGE_MS) {
    // Stale — refresh, but don't block the download on it. A payment that
    // completed in the last hour will show up as licensed on the NEXT
    // check; this one still uses the last known value.
    refreshLicenseStatus().catch(() => {});
  }

  return !!status.licensed;
}

async function getCachedLicenseStatus() {
  const data = await chrome.storage.local.get(LICENSE_STATUS_STORAGE_KEY);
  return data[LICENSE_STATUS_STORAGE_KEY] || { licensed: false, checkedAt: 0 };
}

/**
 * Actually hit the server. Called on a stale cache, and explicitly by the
 * popup (e.g. right after the user closes the checkout tab, or just opens
 * the popup) so a fresh purchase is picked up promptly rather than waiting
 * up to an hour.
 * @returns {Promise<{licensed: boolean, purchasedAt?: number}>}
 */
async function refreshLicenseStatus() {
  const installId = await getInstallId(); // from telemetry.js, shared scope

  try {
    const resp = await fetch(`${LICENSE_SERVER_URL}/license/status?installId=${encodeURIComponent(installId)}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const status = await resp.json();

    await chrome.storage.local.set({
      [LICENSE_STATUS_STORAGE_KEY]: { ...status, checkedAt: Date.now() }
    });
    return status;
  } catch (e) {
    console.warn('[License] Status check failed:', e.message);
    // Network hiccup or server down — keep whatever was cached rather than
    // silently downgrading someone who already paid.
    return getCachedLicenseStatus();
  }
}

/**
 * Kick off the Stripe checkout flow: ask the license server for a session
 * URL, open it in a new tab. Payment confirmation happens out-of-band (the
 * server's webhook), not anything this function waits for.
 */
async function startCheckout() {
  const installId = await getInstallId();

  try {
    const resp = await fetch(`${LICENSE_SERVER_URL}/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installId })
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const { url } = await resp.json();
    if (!url) throw new Error('No checkout URL returned');

    chrome.tabs.create({ url });
    trackEvent('checkout_started', {});
  } catch (e) {
    console.error('[License] Checkout failed to start:', e.message);
    throw e; // let the caller (popup) show an error
  }
}
