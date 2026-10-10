const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

test('Windows companion bundles the native host and registers Chrome and Edge', () => {
  const installer = fs.readFileSync(
    path.join(root, 'companion', 'windows', 'CrawlcastCompanion.iss'),
    'utf8'
  );
  const builder = fs.readFileSync(
    path.join(root, 'companion', 'windows', 'build-companion.ps1'),
    'utf8'
  );
  const host = fs.readFileSync(path.join(root, 'native-host', 'crawlcast_host.py'), 'utf8');

  assert.match(installer, /Google\\Chrome\\NativeMessagingHosts\\com\.crawlcast\.downloader/);
  assert.match(installer, /Microsoft\\Edge\\NativeMessagingHosts\\com\.crawlcast\.downloader/);
  assert.match(builder, /PyInstaller/);
  assert.match(builder, /ffmpeg\.exe/);
  assert.match(builder, /ffprobe\.exe/);
  assert.match(host, /bundled_tool\("ffmpeg"\)/);
});
