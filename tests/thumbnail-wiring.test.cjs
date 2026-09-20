const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('fMP4 thumbnail samples include the EXT-X-MAP init segment', () => {
  const source = read('offscreen.js');
  assert.match(source, /playlist\.initSegmentUrl[\s\S]*initSegmentBytes/);
  assert.match(source, /captureSegmentFrame\(segments\[idx\]\.url, initSegmentBytes\)/);
  assert.match(source, /initSegmentBytes \? concatBytes\(initSegmentBytes, view\) : view/);
});

test('failed thumbnails can retry but stop after three attempts', () => {
  const background = read('background.js');
  const popup = read('popup.js');
  assert.match(background, /thumbnailAttempts < 3/);
  assert.match(background, /stream\.thumbnailAttempts >= 3/);
  assert.match(popup, /thumbnailAttempts\) \|\| 0\) < 3/);
});

test('direct MP4 cards load a video preview and cache duration metadata', () => {
  const background = read('background.js');
  const popup = read('popup.js');
  assert.match(popup, /<video class="stream-thumb direct-mp4-preview"/);
  assert.match(popup, /function attachDirectMp4Preview\(video\)/);
  assert.match(popup, /action: 'cacheDirectMp4Meta'/);
  assert.match(background, /request\.action === 'cacheDirectMp4Meta'/);
  assert.match(background, /durationSeconds/);
});

test('direct MP4 previews scrub across the video while hovered', () => {
  const popup = read('popup.js');
  assert.match(popup, /previewFractions = \[0\.05, 0\.2, 0\.35, 0\.5, 0\.65, 0\.8, 0\.95\]/);
  assert.match(popup, /addEventListener\('mouseenter'[\s\S]*seekNextHoverFrame\(\)/);
  assert.match(popup, /addEventListener\('mouseleave'[\s\S]*video\.currentTime = restingTime/);
  assert.match(popup, /setTimeout\(seekNextHoverFrame, 700\)/);
});

test('direct MP4 response headers retain the complete file size', () => {
  const background = read('background.js');
  assert.match(background, /function getResponseTotalBytes\(details\)/);
  assert.match(background, /content-range/);
  assert.match(background, /stream\.meta = \{[\s\S]*bytes,[\s\S]*direct: true,[\s\S]*estimated: false/);
});
