// Provider-neutral Premium boundary. Payment and customer data stay on the
// server; the extension only asks for checkout URLs and entitlement state.
(() => {
  const config = Object.freeze({
    enablePremiumTestMode: false,
    apiBaseUrl: '',
    checkoutPath: '/v1/premium/checkout',
    entitlementPath: '/v1/premium/entitlement',
    portalPath: '/v1/premium/portal',
    cacheTtlMs: 15 * 60 * 1000,
    requestTimeoutMs: 10 * 1000,
    ...(globalThis.CRAWLCAST_PREMIUM_CONFIG || {})
  });

  const STORAGE = Object.freeze({
    installationId: 'premiumInstallationId',
    entitlement: 'premiumEntitlement',
    testPremiumEnabled: 'premiumTestEnabled'
  });
  const ACTIVE_STATUSES = new Set(['active', 'trialing']);
  const KNOWN_STATUSES = new Set([
    'unconfigured',
    'free',
    'active',
    'trialing',
    'past_due',
    'canceled',
    'expired'
  ]);

  let installationId = '';
  let snapshot = createFreeState();
  let initialized = false;
  let initialization = null;
  let refreshInFlight = null;
  let testPremiumEnabled = false;

  function isConfigured() {
    try {
      const url = new URL(config.apiBaseUrl);
      return url.protocol === 'https:' || url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    } catch {
      return false;
    }
  }

  function createFreeState(overrides = {}) {
    return {
      tier: 'free',
      status: isConfigured() ? 'free' : 'unconfigured',
      isPremium: false,
      providerConfigured: isConfigured(),
      features: {
        unlimitedDownloads: false
      },
      checkedAt: 0,
      refreshAfter: 0,
      validUntil: 0,
      error: null,
      ...overrides
    };
  }

  function createTestPremiumState() {
    return createFreeState({
      tier: 'premium',
      status: 'active',
      isPremium: true,
      features: {
        unlimitedDownloads: true
      },
      error: null
    });
  }

  function publicState(state = snapshot) {
    return {
      tier: state.tier,
      status: state.status,
      isPremium: state.isPremium,
      providerConfigured: state.providerConfigured,
      features: { ...state.features },
      checkedAt: state.checkedAt,
      refreshAfter: state.refreshAfter,
      validUntil: state.validUntil,
      error: state.error || null,
      testModeAvailable: config.enablePremiumTestMode === true,
      testModeEnabled: config.enablePremiumTestMode === true && testPremiumEnabled
    };
  }

  function parseTime(value) {
    if (!value) return 0;
    const parsed = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function normalizeEntitlement(payload, now = Date.now()) {
    const requestedTier = payload?.tier === 'premium' ? 'premium' : 'free';
    const requestedStatus = KNOWN_STATUSES.has(payload?.status) ? payload.status : 'free';
    const validUntil = parseTime(payload?.validUntil);
    const timeValid = requestedTier !== 'premium' || validUntil > now;
    const active = isConfigured() && requestedTier === 'premium' && ACTIVE_STATUSES.has(requestedStatus) && timeValid;
    const advertisedFeatures = Array.isArray(payload?.features) ? payload.features : [];
    const unlimitedDownloads = advertisedFeatures.includes('unlimited_downloads') ||
      payload?.features?.unlimitedDownloads === true;

    return createFreeState({
      tier: active ? 'premium' : 'free',
      status: !timeValid && requestedTier === 'premium' ? 'expired' : requestedStatus,
      isPremium: active,
      providerConfigured: isConfigured(),
      features: {
        unlimitedDownloads: active && unlimitedDownloads
      },
      checkedAt: now,
      refreshAfter: now + Math.max(60_000, Number(config.cacheTtlMs) || 0),
      validUntil,
      error: null
    });
  }

  async function initialize() {
    if (initialized) return publicState();
    if (initialization) return initialization;

    initialization = (async () => {
      const stored = await chrome.storage.local.get([
        STORAGE.installationId,
        STORAGE.entitlement,
        STORAGE.testPremiumEnabled
      ]);
      testPremiumEnabled = config.enablePremiumTestMode === true &&
        stored[STORAGE.testPremiumEnabled] === true;
      installationId = typeof stored[STORAGE.installationId] === 'string'
        ? stored[STORAGE.installationId]
        : '';
      if (!installationId) {
        installationId = crypto.randomUUID();
        await chrome.storage.local.set({ [STORAGE.installationId]: installationId });
      }

      const cached = stored[STORAGE.entitlement];
      if (cached && typeof cached === 'object') {
        snapshot = normalizeEntitlement(cached, Date.now());
        snapshot.checkedAt = Number(cached.checkedAt) || 0;
        snapshot.refreshAfter = Number(cached.refreshAfter) || 0;
      } else {
        snapshot = createFreeState();
      }
      if (testPremiumEnabled) snapshot = createTestPremiumState();
      initialized = true;
      return publicState();
    })();

    return initialization;
  }

  function endpoint(path) {
    if (!isConfigured()) {
      const error = new Error('Premium checkout is not configured yet.');
      error.code = 'PREMIUM_NOT_CONFIGURED';
      throw error;
    }
    const base = config.apiBaseUrl.endsWith('/') ? config.apiBaseUrl : `${config.apiBaseUrl}/`;
    return new URL(String(path || '').replace(/^\//, ''), base).href;
  }

  async function request(path) {
    await initialize();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1000, Number(config.requestTimeoutMs) || 0));
    try {
      const response = await fetch(endpoint(path), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          installationId,
          extensionVersion: chrome.runtime.getManifest().version
        }),
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`Premium service returned HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async function refresh({ force = false } = {}) {
    await initialize();
    if (testPremiumEnabled) {
      snapshot = createTestPremiumState();
      return publicState();
    }
    if (!isConfigured()) {
      snapshot = createFreeState();
      return publicState();
    }
    if (!force && snapshot.refreshAfter > Date.now()) return publicState();
    if (refreshInFlight) return refreshInFlight;

    refreshInFlight = (async () => {
      try {
        const payload = await request(config.entitlementPath);
        snapshot = normalizeEntitlement(payload);
        await chrome.storage.local.set({ [STORAGE.entitlement]: snapshot });
      } catch (error) {
        // Keep a previously active, unexpired entitlement usable during a
        // temporary outage. The error remains visible so the UI can report it.
        const stillValid = snapshot.isPremium && (!snapshot.validUntil || snapshot.validUntil > Date.now());
        if (!stillValid) snapshot = createFreeState();
        snapshot.error = error?.message || String(error);
        snapshot.refreshAfter = Date.now() + 60_000;
      } finally {
        refreshInFlight = null;
      }
      return publicState();
    })();

    return refreshInFlight;
  }

  async function createActionUrl(path, property) {
    const payload = await request(path);
    const value = payload?.[property];
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`Premium service did not return a valid ${property}.`);
    }
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      throw new Error(`Premium service returned an unsafe ${property}.`);
    }
    return url.href;
  }

  async function createCheckoutUrl() {
    return createActionUrl(config.checkoutPath, 'checkoutUrl');
  }

  async function createPortalUrl() {
    return createActionUrl(config.portalPath, 'portalUrl');
  }

  function hasFeature(feature) {
    return snapshot.features?.[feature] === true;
  }

  async function setTestPremiumEnabled(enabled) {
    await initialize();
    if (config.enablePremiumTestMode !== true) {
      throw new Error('Premium test mode is disabled in this build.');
    }

    testPremiumEnabled = enabled === true;
    await chrome.storage.local.set({
      [STORAGE.testPremiumEnabled]: testPremiumEnabled
    });

    if (testPremiumEnabled) {
      snapshot = createTestPremiumState();
      return publicState();
    }

    snapshot = createFreeState();
    return refresh({ force: true });
  }

  globalThis.CrawlcastPremium = Object.freeze({
    initialize,
    getState: () => publicState(),
    refresh,
    setTestPremiumEnabled,
    createCheckoutUrl,
    createPortalUrl,
    hasFeature
  });
})();
