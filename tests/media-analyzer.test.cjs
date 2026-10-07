const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.join(__dirname, '..');
const analyzer = path.join(root, 'tools', 'analyze-media.cjs');
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const hasFfprobe = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;

test('media analyzer reports probe, loudness, subtitles, and MP4 structure', {
  skip: !hasFfmpeg || !hasFfprobe
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crawlcast-analyzer-'));
  try {
    const source = path.join(dir, 'sample.mp4');
    const fixture = spawnSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-filter:a', 'volume=0.01', '-t', '1',
      '-c:v', 'mpeg4', '-c:a', 'aac', '-movflags', '+faststart', '-shortest', source
    ], { encoding: 'utf8' });
    assert.equal(fixture.status, 0, fixture.stderr || 'fixture generation failed');

    const result = spawnSync('node', [analyzer, source, '--json'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024
    });
    assert.equal(result.status, 0, result.stderr || 'analyzer failed');
    const output = JSON.parse(result.stdout);
    assert.equal(output.reports.length, 1);
    assert.equal(output.reports[0].streams.some((stream) => stream.codec_type === 'video'), true);
    assert.equal(output.reports[0].streams.some((stream) => stream.codec_type === 'audio'), true);
    assert.equal(output.reports[0].loudness[0].wouldNormalize, true);
    assert.equal(output.reports[0].mp4.fastStart, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
