const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const premiumSource = fs.readFileSync(path.join(__dirname, '..', 'premium.js'), 'utf8');

function createService({ config = {}, fetchImpl, store = {} } = {}) {
  const storage = { ...store };
  const context = {
    AbortController,
    URL,
    clearTimeout,
    console,
    crypto: { randomUUID: () => 'installation-test-id' },
    fetch: fetchImpl || (async () => { throw new Error('unexpected fetch'); }),
    setTimeout,
    CRAWLCAST_PREMIUM_CONFIG: {
      apiBaseUrl: '',
      cacheTtlMs: 15 * 60 * 1000,
      requestTimeoutMs: 1000,
      ...config
    },
    chrome: {
      runtime: { getManifest: () => ({ version: '0.2.0' }) },
      storage: {
        local: {
          async get(keys) {
            return Object.fromEntries(keys.filter((key) => key in storage).map((key) => [key, storage[key]]));
          },
          async set(values) {
            Object.assign(storage, values);
          }
        }
      }
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(premiumSource, context, { filename: 'premium.js' });
  return { service: context.CrawlcastPremium, storage };
}

test('unconfigured provider remains free and does not fake checkout', async () => {
  const { service, storage } = createService();
  const state = await service.initialize();
  assert.equal(state.providerConfigured, false);
  assert.equal(state.isPremium, false);
  assert.equal(state.features.unlimitedDownloads, false);
  assert.equal(storage.premiumInstallationId, 'installation-test-id');
  await assert.rejects(service.createCheckoutUrl(), /not configured/i);
});

test('active server entitlement unlocks unlimited downloads and is cached', async () => {
  const validUntil = Date.now() + 60 * 60 * 1000;
  const { service, storage } = createService({
    config: { apiBaseUrl: 'https://premium.example.test' },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        tier: 'premium',
        status: 'active',
        features: ['unlimited_downloads'],
        validUntil
      })
    })
  });

  await service.initialize();
  const state = await service.refresh({ force: true });
  assert.equal(state.isPremium, true);
  assert.equal(state.features.unlimitedDownloads, true);
  assert.equal(storage.premiumEntitlement.validUntil, validUntil);
});

test('a valid cached entitlement survives a worker restart', async () => {
  const checkedAt = Date.now() - 1000;
  const validUntil = Date.now() + 60 * 60 * 1000;
  const { service } = createService({
    config: { apiBaseUrl: 'https://premium.example.test' },
    store: {
      premiumInstallationId: 'existing-installation',
      premiumEntitlement: {
        tier: 'premium',
        status: 'active',
        isPremium: true,
        features: { unlimitedDownloads: true },
        checkedAt,
        refreshAfter: Date.now() + 60_000,
        validUntil
      }
    }
  });

  const state = await service.initialize();
  assert.equal(state.isPremium, true);
  assert.equal(state.features.unlimitedDownloads, true);
  assert.equal(state.checkedAt, checkedAt);
});

test('expired entitlement fails closed', async () => {
  const { service } = createService({
    config: { apiBaseUrl: 'https://premium.example.test' },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        tier: 'premium',
        status: 'active',
        features: ['unlimited_downloads'],
        validUntil: Date.now() - 1000
      })
    })
  });

  await service.initialize();
  const state = await service.refresh({ force: true });
  assert.equal(state.status, 'expired');
  assert.equal(state.isPremium, false);
  assert.equal(state.features.unlimitedDownloads, false);
});

test('checkout accepts only a safe URL from the backend', async () => {
  const responses = [
    { checkoutUrl: 'https://checkout.example.test/session/123' },
    { checkoutUrl: 'javascript:alert(1)' }
  ];
  const { service } = createService({
    config: { apiBaseUrl: 'https://premium.example.test' },
    fetchImpl: async () => ({ ok: true, json: async () => responses.shift() })
  });

  assert.equal(await service.createCheckoutUrl(), 'https://checkout.example.test/session/123');
  await assert.rejects(service.createCheckoutUrl(), /unsafe checkoutUrl/i);
});
