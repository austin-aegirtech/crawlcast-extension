const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('HLS master parser selects the default subtitle rendition', () => {
  const context = vm.createContext({ URL });
  vm.runInContext(`${read('m3u8-parser.js')}\nthis.M3U8Parser = M3U8Parser;`, context);
  const parser = new context.M3U8Parser();
  const playlist = parser.parse(`#EXTM3U
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="subs/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1920x1080,SUBTITLES="subs"
video/main.m3u8`, 'https://media.example/master.m3u8');

  const subtitle = parser.selectSubtitleRendition(playlist, playlist.variants[0]);
  assert.equal(playlist.variants[0].subtitlesGroup, 'subs');
  assert.equal(subtitle.name, 'English');
  assert.equal(subtitle.language, 'en');
  assert.equal(subtitle.url, 'https://media.example/subs/en.m3u8');
});

test('selected HLS subtitles cross the offscreen and native-host boundary', () => {
  const downloader = read('downloader.js');
  const offscreen = read('offscreen.js');
  const background = read('background.js');
  const popup = read('popup.js');
  const host = read('native-host/crawlcast_host.py');

  assert.match(downloader, /\[Subtitles\] Track selected:/);
  assert.match(downloader, /subtitleUrl: subtitleRendition\?\.url/);
  assert.match(offscreen, /subtitleUrl: audioFormat \? null : result\.subtitleUrl/);
  assert.match(background, /const pendingSubtitleMerge = new Map\(\);/);
  assert.match(background, /subtitleUrl: subtitle\.url/);
  assert.match(background, /function findRelatedHlsMaster\(stream\)/);
  assert.match(background, /Using related master playlist for audio\/subtitle discovery/);
  assert.match(background, /url: sourceUrl,[\s\S]*streamUrl: url/);
  assert.match(offscreen, /request\.streamUrl \|\| request\.url/);
  assert.match(offscreen, /hasSubtitles: subtitleTracks\.length > 0/);
  assert.match(background, /const analysisGroups = new Map\(\);/);
  assert.match(popup, /class="subtitle-badge"/);
  assert.match(popup, /function updateSubtitleBadge\(url, meta\)/);
  assert.match(host, /"-c:s", "mov_text"/);
  assert.match(host, /message\.get\("subtitleUrl"\)/);
});
