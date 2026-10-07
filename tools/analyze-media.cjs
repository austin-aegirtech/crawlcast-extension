#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MEDIA_EXTENSIONS = new Set([
  '.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.ts', '.m2ts',
  '.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.opus'
]);
const TARGET_I = -16;
const TARGET_TP = -1.5;
const TARGET_LRA = 11;
const BOOST_THRESHOLD = 0.5;
const FFPROBE = process.env.CRAWLCAST_FFPROBE_BIN || 'ffprobe';
const FFMPEG = process.env.CRAWLCAST_FFMPEG_BIN || 'ffmpeg';

const args = process.argv.slice(2);
const jsonOutput = args.includes('--json');
const fast = args.includes('--fast');
const inputs = args.filter((arg) => !arg.startsWith('--'));

if (args.includes('--help') || inputs.length === 0) {
  console.log(`Usage: npm run analyze:media -- <file-or-folder> [more paths] [--json] [--fast]

Options:
  --json  Print machine-readable JSON.
  --fast  Skip full-file EBU R128 loudness analysis.

Examples:
  npm run analyze:media -- "C:\\Users\\austi\\Downloads\\video.mp4"
  npm run analyze:media -- /mnt/c/Users/austi/Videos
  npm run analyze:media -- ./videos --json`);
  process.exit(args.includes('--help') ? 0 : 1);
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.error) throw result.error;
  return result;
}

function collectFiles(inputPath) {
  const resolved = path.resolve(inputPath);
  const stat = fs.statSync(resolved);
  if (stat.isFile()) return MEDIA_EXTENSIONS.has(path.extname(resolved).toLowerCase()) ? [resolved] : [];
  if (!stat.isDirectory()) return [];

  const files = [];
  const pending = [resolved];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile() && MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(fullPath);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function probe(file) {
  const result = run(FFPROBE, [
    '-v', 'error', '-show_format', '-show_streams', '-show_chapters', '-show_programs',
    '-of', 'json', file
  ]);
  if (result.status !== 0) throw new Error((result.stderr || 'ffprobe failed').trim());
  return JSON.parse(result.stdout);
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function analyzeLoudness(file, streamIndex) {
  const result = run(FFMPEG, [
    '-nostdin', '-hide_banner', '-v', 'info', '-i', file,
    '-map', `0:${streamIndex}`, '-vn',
    '-af', `loudnorm=I=${TARGET_I}:TP=${TARGET_TP}:LRA=${TARGET_LRA}:print_format=json`,
    '-f', 'null', '-'
  ]);
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const matches = [...output.matchAll(/\{\s*"input_i"[\s\S]*?\}/g)];
  if (!matches.length) return { error: 'Loudness could not be measured' };
  const raw = JSON.parse(matches.at(-1)[0]);
  const measured = {
    integratedLufs: number(raw.input_i),
    truePeakDbtp: number(raw.input_tp),
    loudnessRangeLu: number(raw.input_lra),
    thresholdLufs: number(raw.input_thresh),
    targetOffsetLu: number(raw.target_offset)
  };
  measured.targetLufs = TARGET_I;
  measured.wouldNormalize = measured.integratedLufs !== null &&
    measured.integratedLufs < TARGET_I - BOOST_THRESHOLD;
  return measured;
}

function inspectMp4(file) {
  if (!['.mp4', '.m4v', '.mov'].includes(path.extname(file).toLowerCase())) return null;
  const fd = fs.openSync(file, 'r');
  const fileSize = fs.fstatSync(fd).size;
  const atoms = [];
  let offset = 0;
  try {
    while (offset + 8 <= fileSize && atoms.length < 10000) {
      const header = Buffer.alloc(16);
      const bytesRead = fs.readSync(fd, header, 0, 16, offset);
      if (bytesRead < 8) break;
      let atomSize = header.readUInt32BE(0);
      const type = header.toString('ascii', 4, 8);
      let headerSize = 8;
      if (atomSize === 1) {
        if (bytesRead < 16) break;
        atomSize = Number(header.readBigUInt64BE(8));
        headerSize = 16;
      } else if (atomSize === 0) {
        atomSize = fileSize - offset;
      }
      if (!Number.isSafeInteger(atomSize) || atomSize < headerSize || offset + atomSize > fileSize) break;
      atoms.push({ type, offset, size: atomSize });
      offset += atomSize;
    }
  } finally {
    fs.closeSync(fd);
  }
  const moov = atoms.find((atom) => atom.type === 'moov');
  const mdat = atoms.find((atom) => atom.type === 'mdat');
  return {
    fastStart: !!moov && !!mdat && moov.offset < mdat.offset,
    fragmented: atoms.some((atom) => atom.type === 'moof'),
    hasMoov: !!moov,
    hasMediaData: !!mdat,
    topLevelAtoms: atoms,
    fragmentCount: atoms.filter((atom) => atom.type === 'moof').length
  };
}

function analyzeFile(file) {
  const stats = fs.statSync(file);
  const info = probe(file);
  const streams = info.streams || [];
  const audioStreams = streams.filter((stream) => stream.codec_type === 'audio');
  const loudness = fast
    ? []
    : audioStreams.map((stream) => ({
        streamIndex: stream.index,
        ...analyzeLoudness(file, stream.index)
      }));
  return {
    file,
    sizeBytes: stats.size,
    modifiedAt: stats.mtime.toISOString(),
    format: info.format || {},
    streams,
    chapters: info.chapters || [],
    programs: info.programs || [],
    loudness,
    mp4: inspectMp4(file)
  };
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(unit ? 2 : 0)} ${units[unit]}`;
}

function formatDuration(seconds) {
  const total = number(seconds);
  if (total === null) return 'unknown';
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = (total % 60).toFixed(3).padStart(6, '0');
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${secs}`;
}

function printObject(label, value, indent = '  ') {
  if (!value || !Object.keys(value).length) return;
  console.log(`${indent}${label}:`);
  for (const [key, item] of Object.entries(value)) console.log(`${indent}  ${key}: ${item}`);
}

function printReport(report) {
  const format = report.format;
  console.log(`\n${'='.repeat(80)}\n${report.file}`);
  console.log(`  Size: ${formatBytes(report.sizeBytes)} (${report.sizeBytes} bytes)`);
  console.log(`  Modified: ${report.modifiedAt}`);
  console.log(`  Container: ${format.format_long_name || format.format_name || 'unknown'}`);
  console.log(`  Duration: ${formatDuration(format.duration)}`);
  console.log(`  Start: ${format.start_time ?? 'unknown'} s`);
  console.log(`  Bitrate: ${format.bit_rate ? `${Math.round(Number(format.bit_rate) / 1000)} kb/s` : 'unknown'}`);
  printObject('Container tags', format.tags);

  for (const stream of report.streams) {
    const label = `${stream.codec_type || 'unknown'} stream #${stream.index}`;
    console.log(`\n  ${label}`);
    console.log(`    Codec: ${stream.codec_long_name || stream.codec_name || 'unknown'} (${stream.codec_name || '?'})`);
    if (stream.profile) console.log(`    Profile: ${stream.profile}`);
    if (stream.codec_type === 'video') {
      console.log(`    Resolution: ${stream.width || '?'}x${stream.height || '?'}`);
      console.log(`    Pixel format: ${stream.pix_fmt || 'unknown'}`);
      console.log(`    Frame rate: ${stream.avg_frame_rate || stream.r_frame_rate || 'unknown'}`);
      console.log(`    Color: ${[stream.color_space, stream.color_transfer, stream.color_primaries].filter(Boolean).join(' / ') || 'unknown'}`);
    }
    if (stream.codec_type === 'audio') {
      console.log(`    Sample rate: ${stream.sample_rate || 'unknown'} Hz`);
      console.log(`    Channels: ${stream.channels || 'unknown'} (${stream.channel_layout || 'layout unknown'})`);
      console.log(`    Bitrate: ${stream.bit_rate ? `${Math.round(Number(stream.bit_rate) / 1000)} kb/s` : 'unknown'}`);
      const measured = report.loudness.find((item) => item.streamIndex === stream.index);
      if (measured) {
        console.log(`    Loudness: ${measured.integratedLufs ?? 'unknown'} LUFS`);
        console.log(`    True peak: ${measured.truePeakDbtp ?? 'unknown'} dBTP`);
        console.log(`    Loudness range: ${measured.loudnessRangeLu ?? 'unknown'} LU`);
        console.log(`    Crawlcast action: ${measured.wouldNormalize ? `BOOST to ${TARGET_I} LUFS` : 'leave unchanged'}`);
      } else if (fast) {
        console.log('    Loudness: skipped (--fast)');
      }
    }
    if (stream.codec_type === 'subtitle') {
      console.log(`    Language: ${stream.tags?.language || 'unknown'}`);
      console.log(`    Title: ${stream.tags?.title || 'unknown'}`);
    }
    console.log(`    Duration: ${formatDuration(stream.duration)}`);
    console.log(`    Disposition: ${Object.entries(stream.disposition || {}).filter(([, value]) => value).map(([key]) => key).join(', ') || 'none'}`);
    printObject('Tags', stream.tags, '    ');
  }

  if (report.chapters.length) console.log(`\n  Chapters: ${report.chapters.length}`);
  if (report.programs.length) console.log(`  Programs: ${report.programs.length}`);
  if (report.mp4) {
    console.log('\n  MP4 structure');
    console.log(`    Fast start: ${report.mp4.fastStart ? 'yes' : 'no'}`);
    console.log(`    Fragmented (moof): ${report.mp4.fragmented ? 'yes' : 'no'}`);
    console.log(`    moov: ${report.mp4.hasMoov ? 'present' : 'missing'}`);
    console.log(`    mdat: ${report.mp4.hasMediaData ? 'present' : 'missing'}`);
    console.log(`    Media fragments: ${report.mp4.fragmentCount}`);
    const structuralAtoms = report.mp4.topLevelAtoms.filter((atom) => !['moof', 'mdat'].includes(atom.type));
    console.log(`    Structural atoms: ${structuralAtoms.map((atom) => `${atom.type}@${atom.offset}`).join(', ') || 'none'}`);
  }
}

let files;
try {
  files = [...new Set(inputs.flatMap(collectFiles))];
} catch (error) {
  console.error(`Could not scan input: ${error.message}`);
  process.exit(1);
}

if (!files.length) {
  console.error('No supported media files found.');
  process.exit(1);
}

const reports = [];
const errors = [];
for (const file of files) {
  try {
    reports.push(analyzeFile(file));
    if (!jsonOutput) printReport(reports.at(-1));
  } catch (error) {
    errors.push({ file, error: error.message });
    if (!jsonOutput) console.error(`\nFAILED: ${file}\n  ${error.message}`);
  }
}

if (jsonOutput) console.log(JSON.stringify({ reports, errors }, null, 2));
else console.log(`\nScanned ${files.length} file(s): ${reports.length} succeeded, ${errors.length} failed.`);
process.exitCode = errors.length ? 1 : 0;
