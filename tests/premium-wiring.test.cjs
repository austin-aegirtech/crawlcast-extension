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
  assert.match(source, /await CrawlcastPremium\.refresh\(\);[\s\S]*const state = getModeState\(\);/);
  assert.match(source, /const consumedUserSlot = !state\.rateLimitExempt;/);
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
