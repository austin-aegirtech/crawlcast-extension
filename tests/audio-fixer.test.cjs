const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.join(__dirname, '..');
const fixer = path.join(root, 'tools', 'fix-audio.cjs');
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

test('standalone audio fixer normalizes a quiet video and preserves the source', { skip: !hasFfmpeg }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crawlcast-audio-fixer-'));
  try {
    const source = path.join(dir, 'quiet.mp4');
    const fixture = spawnSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-filter:a', 'volume=0.01', '-t', '2',
      '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', source
    ], { encoding: 'utf8' });
    assert.equal(fixture.status, 0, fixture.stderr);

    const result = spawnSync(process.execPath, [fixer, source], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 fixed/);
    assert.equal(fs.existsSync(source), true);
    assert.equal(fs.existsSync(path.join(dir, 'quiet.normalized.mp4')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('download pipeline always invokes native remux for automatic loudness analysis', () => {
  const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  assert.match(background, /analyzingAudio:\s*true/);
  assert.match(background, /startRemux\(\);\s*\n}/);
  assert.match(background, /action:\s*'remux'/);
});

test('standalone audio fixer safely replaces a quiet video in place', { skip: !hasFfmpeg }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crawlcast-audio-fixer-in-place-'));
  try {
    const source = path.join(dir, 'quiet.mp4');
    const fixture = spawnSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-filter:a', 'volume=0.01', '-t', '2',
      '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', source
    ], { encoding: 'utf8' });
    assert.equal(fixture.status, 0, fixture.stderr);
    const before = fs.statSync(source).size;

    const result = spawnSync(process.execPath, [fixer, source, '--in-place'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(source), true);
    assert.notEqual(fs.statSync(source).size, before);
    assert.equal(fs.existsSync(`${source}.crawlcast-audio-fix.backup`), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
