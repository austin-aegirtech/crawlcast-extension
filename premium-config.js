// Public Premium integration settings. Never put payment-provider secrets in
// an extension: every packaged value can be inspected by the user.
globalThis.CRAWLCAST_PREMIUM_CONFIG = Object.freeze({
  // Development only. Set this to false before creating a production build.
  // When enabled, the header tier control can simulate Free and Premium.
  enablePremiumTestMode: true,
  apiBaseUrl: '',
  checkoutPath: '/v1/premium/checkout',
  entitlementPath: '/v1/premium/entitlement',
  portalPath: '/v1/premium/portal',
  cacheTtlMs: 15 * 60 * 1000,
  requestTimeoutMs: 10 * 1000
});
