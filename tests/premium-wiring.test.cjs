const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('background loads Premium before evaluating download access', () => {
  const source = read('background.js');
  assert.match(source, /^importScripts\('premium-config\.js', 'premium\.js'\);/);
  assert.match(source, /premium\.features\.unlimitedDownloads/);
  assert.match(source, /await CrawlcastPremium\.refresh\(\);[\s\S]*const state = getAccessState\(\);/);
  assert.match(source, /const consumedFreeSlot = !state\.rateLimitExempt;/);
});

test('Premium actions cross the background boundary instead of calling billing from the popup', () => {
  const background = read('background.js');
  const popup = read('popup.js');
  for (const action of [
    'getPremiumState',
    'refreshPremiumState',
    'startPremiumCheckout',
    'openPremiumPortal'
  ]) {
    assert.match(background, new RegExp(`request\\.action === '${action}'`));
    assert.match(popup, new RegExp(action));
  }
  assert.doesNotMatch(popup, /fetch\s*\(/);
});

test('legacy mock authentication is removed', () => {
  assert.equal(fs.existsSync(path.join(root, 'auth.js')), false);
});

test('legacy mode bypass is removed and Premium testing is explicitly gated', () => {
  const background = read('background.js');
  const popup = read('popup.js');
  const html = read('popup.html');
  const config = read('premium-config.js');
  const premium = read('premium.js');

  assert.doesNotMatch(background, /request\.action === 'setMode'/);
  assert.doesNotMatch(background, /crawlcastMode\s*===\s*'god'/);
  assert.match(background, /request\.action === 'setPremiumTestMode'/);
  assert.doesNotMatch(popup, /toggleMode|modeToggle|God Mode|User Mode/);
  assert.doesNotMatch(html, /modeToggle|God Mode|User Mode/);
  assert.match(html, /id="tierLabel">Free</);
  assert.match(background, /tier: rateLimitExempt \? 'premium' : 'free'/);
  assert.match(config, /enablePremiumTestMode: true/);
  assert.match(premium, /enablePremiumTestMode: false/);
  assert.match(premium, /Premium test mode is disabled in this build/);
});

test('Premium access hides the upsell and card backlighting is contextual', () => {
  const popup = read('popup.js');
  const styles = read('styles/popup.css');

  assert.match(popup, /card\.hidden = isActive;/);
  assert.match(
    popup,
    /document\.getElementById\('premiumCard'\)\.hidden = premiumState\.isPremium === true;/
  );
  assert.match(styles, /\.premium-card:hover,[\s\S]*0 0 24px var\(--brand-glow\)/);
  assert.match(styles, /\.stream-item:hover,[\s\S]*0 0 24px var\(--brand-glow\)/);
  assert.match(popup, /stream-item \$\{isDownloading \? 'active' : ''\}/);
  assert.match(styles, /\.premium-card \{[\s\S]*box-shadow: 0 8px 24px rgba\(0, 0, 0, 0\.16\);/);
  assert.match(styles, /\.stream-item \{[\s\S]*box-shadow: 0 4px 13px rgba\(0, 0, 0, 0\.12\);/);
});

test('tab navigation completion restores the detected-media badge', () => {
  const background = read('background.js');
  assert.match(
    background,
    /chrome\.tabs\.onUpdated\.addListener\([\s\S]*changeInfo\.status !== 'complete'[\s\S]*updateBadge\(tabId\)/
  );
  assert.match(
    background,
    /getStreams'[\s\S]*updateBadge\(request\.tabId\)\.finally\(\(\) => sendResponse\(\{ streams \}\)\)/
  );
});
