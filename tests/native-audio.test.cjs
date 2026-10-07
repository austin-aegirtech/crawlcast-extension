const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.join(__dirname, '..');
const host = path.join(root, 'native-host', 'crawlcast_host.py');
const hostSource = fs.readFileSync(host, 'utf8');
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const hasFfprobe = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;

function nativeMessage(message) {
  const json = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  const result = spawnSync('python3', [host], { input: Buffer.concat([header, json]) });
  assert.equal(result.status, 0, result.stderr?.toString() || 'native host failed');
  assert.ok(result.stdout.length >= 4, 'native host returned no message');
  const length = result.stdout.readUInt32LE(0);
  return JSON.parse(result.stdout.subarray(4, 4 + length).toString('utf8'));
}

function codecName(file) {
  const result = spawnSync('ffprobe', [
    '-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name',
    '-of', 'default=noprint_wrappers=1:nokey=1', file
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || 'ffprobe failed');
  return result.stdout.trim();
}

function subtitleCodecName(file) {
  const result = spawnSync('ffprobe', [
    '-v', 'error', '-select_streams', 's:0',
    '-show_entries', 'stream=codec_name',
    '-of', 'default=noprint_wrappers=1:nokey=1', file
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || 'ffprobe failed');
  return result.stdout.trim();
}

for (const format of ['m4a', 'mp3']) {
  test(`native host extracts ${format.toUpperCase()} audio`, { skip: !hasFfmpeg || !hasFfprobe }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `crawlcast-${format}-`));
    try {
      const source = path.join(dir, 'source.mp4');
      const fixture = spawnSync('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-t', '1', '-c:a', 'aac', '-b:a', '128k', source
      ], { encoding: 'utf8' });
      assert.equal(fixture.status, 0, fixture.stderr || 'fixture generation failed');

      const outputName = format === 'mp3'
        ? 'Joyner Lucas - 24 hours to live “Official Music Video” (Not Now, I’m Busy) - YouTube.mp3'
        : `sample.${format}`;
      const response = nativeMessage({
        action: 'extractAudio',
        path: source,
        outputName,
        format
      });

      assert.equal(response.type, 'audioExtracted', response.message);
      assert.equal(response.format, format);
      assert.equal(fs.existsSync(source), false);
      assert.equal(fs.existsSync(response.path), true);
      assert.equal(codecName(response.path), format === 'mp3' ? 'mp3' : 'aac');
      if (format === 'mp3') {
        assert.equal(
          path.basename(response.path),
          "Joyner Lucas - 24 hours to live Official Music Video (Not Now, I'm Busy) - YouTube.mp3"
        );
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('native host decodes FFmpeg and FFprobe output without Windows charmap failures', () => {
  assert.ok((hostSource.match(/encoding="utf-8"/g) || []).length >= 4);
  assert.ok((hostSource.match(/errors="replace"/g) || []).length >= 4);
  assert.doesNotMatch(hostSource, /universal_newlines=True/);
});

test('native host automatically boosts quiet video audio', { skip: !hasFfmpeg || !hasFfprobe }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crawlcast-normalize-'));
  try {
    const source = path.join(dir, 'quiet.mp4');
    const fixture = spawnSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-filter:a', 'volume=0.01', '-t', '2',
      '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', source
    ], { encoding: 'utf8' });
    assert.equal(fixture.status, 0, fixture.stderr || 'fixture generation failed');

    const response = nativeMessage({ action: 'remux', path: source });
    assert.equal(response.type, 'remuxed', response.message);
    assert.equal(response.normalized, true);
    assert.ok(response.inputLoudness < -16.5);
    assert.equal(response.targetLoudness, -16);
    assert.equal(fs.existsSync(response.path), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('native host leaves already-loud video audio unchanged', { skip: !hasFfmpeg || !hasFfprobe }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crawlcast-loudness-pass-'));
  try {
    const source = path.join(dir, 'loud.mp4');
    const fixture = spawnSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-filter:a', 'volume=8', '-t', '2',
      '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', source
    ], { encoding: 'utf8' });
    assert.equal(fixture.status, 0, fixture.stderr || 'fixture generation failed');

    const response = nativeMessage({ action: 'remux', path: source });
    assert.equal(response.type, 'remuxed', response.message);
    assert.equal(response.normalized, false);
    assert.ok(response.inputLoudness >= -16.5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('native host embeds WebVTT subtitles into MP4', { skip: !hasFfmpeg || !hasFfprobe }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crawlcast-subtitles-'));
  try {
    const source = path.join(dir, 'source.mp4');
    const subtitle = path.join(dir, 'English.vtt');
    const fixture = spawnSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '2', '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', source
    ], { encoding: 'utf8' });
    assert.equal(fixture.status, 0, fixture.stderr || 'fixture generation failed');
    fs.writeFileSync(subtitle, 'WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nCrawlcast subtitle test\n');

    const response = nativeMessage({
      action: 'remux',
      path: source,
      subtitlePath: subtitle,
      subtitleName: 'English',
      subtitleLanguage: 'eng'
    });

    assert.equal(response.type, 'remuxed', response.message);
    assert.equal(response.subtitled, true);
    assert.equal(fs.existsSync(response.path), true);
    assert.equal(subtitleCodecName(response.path), 'mov_text');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
