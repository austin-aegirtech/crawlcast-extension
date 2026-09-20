const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('video cards offer M4A and MP3 audio-only downloads', () => {
  const popup = read('popup.js');
  assert.match(popup, /class="audio-format-select"/);
  assert.match(popup, /<option value="m4a">M4A<\/option>/);
  assert.match(popup, /<option value="mp3">MP3<\/option>/);
  assert.match(popup, /function startAudioDownload\(url, tabId\)/);
  assert.match(popup, /action: 'startDownload'[\s\S]*audioFormat/);
});

test('both direct MP4 and HLS paths retain audio extraction settings', () => {
  const background = read('background.js');
  const offscreen = read('offscreen.js');
  assert.match(background, /startDirectDownload\([\s\S]*audioOutputFilename/);
  assert.match(background, /action: 'downloadStream'[\s\S]*audioFormat,[\s\S]*audioOutputFilename/);
  assert.match(background, /extractAudioDownloadedFile\(/);
  assert.match(offscreen, /request\.audioFormat/);
  assert.match(offscreen, /audioOnlyBlob = audioFormat && result\.audioBlob/);
});

test('native host exposes M4A and MP3 extraction', () => {
  const host = read('native-host/crawlcast_host.py');
  assert.match(host, /def run_extract_audio\(path, output_name, audio_format\):/);
  assert.match(host, /audio_format not in \("m4a", "mp3"\)/);
  assert.match(host, /"-c:a", "copy"/);
  assert.match(host, /"-c:a", "libmp3lame", "-b:a", "320k"/);
  assert.match(host, /action == "extractAudio"/);
});
