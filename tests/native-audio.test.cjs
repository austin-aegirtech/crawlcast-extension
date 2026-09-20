const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.join(__dirname, '..');
const host = path.join(root, 'native-host', 'crawlcast_host.py');
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

      const outputName = `sample.${format}`;
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
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
