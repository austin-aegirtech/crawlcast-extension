#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TARGET_I = -16;
const TARGET_TP = -1.5;
const TARGET_LRA = 11;
const BOOST_THRESHOLD = 0.5;
const FFMPEG = process.env.CRAWLCAST_FFMPEG_BIN || 'ffmpeg';
const SUPPORTED = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.m4a', '.mp3']);

const args = process.argv.slice(2);
const inPlace = args.includes('--in-place');
const force = args.includes('--force');
const inputs = args.filter((arg) => !arg.startsWith('--'));

if (args.includes('--help') || inputs.length === 0) {
  console.log(`Usage: npm run fix:audio -- <file-or-folder> [more paths] [--in-place] [--force]

Measures the first audio track using EBU R128 and raises quiet audio to -16 LUFS.
Video is stream-copied and never re-encoded.

Options:
  --in-place  Replace the original after the fixed file passes validation.
  --force     Normalize even when audio is already at or above -16.5 LUFS.

Without --in-place, output is written beside the source as <name>.normalized.<ext>.`);
  process.exit(args.includes('--help') ? 0 : 1);
}

function run(commandArgs) {
  const result = spawnSync(FFMPEG, commandArgs, {
    encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024
  });
  if (result.error) throw result.error;
  return result;
}

function collect(input) {
  const resolved = path.resolve(input);
  const stat = fs.statSync(resolved);
  if (stat.isFile()) return SUPPORTED.has(path.extname(resolved).toLowerCase()) ? [resolved] : [];
  if (!stat.isDirectory()) return [];
  const files = [];
  const pending = [resolved];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile() && SUPPORTED.has(path.extname(entry.name).toLowerCase())) files.push(full);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function measure(file) {
  const result = run([
    '-nostdin', '-hide_banner', '-v', 'info', '-i', file,
    '-map', '0:a:0', '-vn',
    '-af', `loudnorm=I=${TARGET_I}:TP=${TARGET_TP}:LRA=${TARGET_LRA}:print_format=json`,
    '-f', 'null', '-'
  ]);
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const matches = [...output.matchAll(/\{\s*"input_i"[\s\S]*?\}/g)];
  if (!matches.length) throw new Error('No measurable audio track was found');
  const raw = JSON.parse(matches.at(-1)[0]);
  const measured = {
    inputI: finite(raw.input_i), inputTp: finite(raw.input_tp),
    inputLra: finite(raw.input_lra), inputThresh: finite(raw.input_thresh),
    offset: finite(raw.target_offset)
  };
  if (Object.values(measured).some((value) => value === null)) {
    throw new Error('FFmpeg returned incomplete loudness measurements');
  }
  return measured;
}

function filter(measured) {
  return `loudnorm=I=${TARGET_I}:TP=${TARGET_TP}:LRA=${TARGET_LRA}:` +
    `measured_I=${measured.inputI}:measured_TP=${measured.inputTp}:` +
    `measured_LRA=${measured.inputLra}:measured_thresh=${measured.inputThresh}:` +
    `offset=${measured.offset}:linear=true:print_format=summary`;
}

function outputPaths(file) {
  const parsed = path.parse(file);
  const final = inPlace ? file : path.join(parsed.dir, `${parsed.name}.normalized${parsed.ext}`);
  const temp = path.join(parsed.dir, `${parsed.name}.crawlcast-audio-fix.tmp${parsed.ext}`);
  return { final, temp };
}

function fix(file) {
  const measured = measure(file);
  if (!force && measured.inputI >= TARGET_I - BOOST_THRESHOLD) {
    console.log(`SKIP ${file}\n  ${measured.inputI} LUFS is already within target`);
    return 'skipped';
  }

  const ext = path.extname(file).toLowerCase();
  const { final, temp } = outputPaths(file);
  const codecArgs = ext === '.mp3'
    ? ['-c:a:0', 'libmp3lame', '-b:a:0', '320k']
    : ['-c:a:0', 'aac', '-b:a:0', '256k'];
  const command = [
    '-nostdin', '-hide_banner', '-v', 'error', '-y', '-i', file,
    '-map', '0', '-c', 'copy', ...codecArgs,
    '-filter:a:0', filter(measured),
    '-map_metadata', '0'
  ];
  if (['.mp4', '.m4v', '.mov'].includes(ext)) command.push('-movflags', '+faststart');
  command.push(temp);

  const result = run(command);
  if (result.status !== 0 || !fs.existsSync(temp) || fs.statSync(temp).size < 1024) {
    if (fs.existsSync(temp)) fs.rmSync(temp);
    throw new Error((result.stderr || result.stdout || 'FFmpeg failed').trim());
  }
  if (inPlace) {
    const backup = `${file}.crawlcast-audio-fix.backup`;
    fs.renameSync(file, backup);
    try {
      fs.renameSync(temp, file);
      fs.rmSync(backup);
    } catch (error) {
      if (fs.existsSync(file)) fs.rmSync(file);
      fs.renameSync(backup, file);
      throw error;
    }
  } else {
    fs.renameSync(temp, final);
  }
  console.log(`FIXED ${file}\n  ${measured.inputI} LUFS -> target ${TARGET_I} LUFS\n  ${final}`);
  return 'fixed';
}

let files;
try {
  files = [...new Set(inputs.flatMap(collect))];
} catch (error) {
  console.error(`Could not scan input: ${error.message}`);
  process.exit(1);
}
if (!files.length) {
  console.error('No supported MP4, MOV, MKV, M4A, or MP3 files found.');
  process.exit(1);
}

let fixed = 0;
let skipped = 0;
let failed = 0;
for (const file of files) {
  try {
    if (fix(file) === 'fixed') fixed++; else skipped++;
  } catch (error) {
    failed++;
    console.error(`FAILED ${file}\n  ${error.message}`);
  }
}
console.log(`\nProcessed ${files.length}: ${fixed} fixed, ${skipped} unchanged, ${failed} failed.`);
process.exitCode = failed ? 1 : 0;
