#!/usr/bin/env python3
"""
Crawlcast native messaging host.

A thin, general-purpose pipe between the Chrome extension and an external
downloader program that the USER has installed on their own machine.
This script contains no site-specific logic: it takes a URL, hands it to
the configured binary, and relays that binary's progress output back to
the extension.

Protocol (Chrome native messaging):
    stdin/stdout, each message = 4-byte little-endian length + UTF-8 JSON.

Messages in:   {"url": "...", "outdir": "optional/path"}
               {"action": "remux", "path": "C:/.../video.mp4"}
Messages out:  {"type": "progress", "percent": 12.3, "line": "..."}
               {"type": "done", "filename": "..."}
               {"type": "remuxed", "path": "...", "bytes": 123, "normalized": true}
               {"type": "remuxSkipped", "message": "..."}
               {"type": "error", "message": "..."}
"""

import json
import os
import re
import struct
import subprocess
import sys

# The external program invoked for each request. Must already be installed
# and on PATH (or given as an absolute path). Override with CRAWLCAST_DL_BIN.
DOWNLOADER_BIN = os.environ.get("CRAWLCAST_DL_BIN", "yt-dlp")

# Used to repair fragmented MP4s produced by the in-browser pipeline.
# Optional: if absent, files are simply left as they are.
FFMPEG_BIN = os.environ.get("CRAWLCAST_FFMPEG_BIN", "ffmpeg")
FFPROBE_BIN = os.environ.get("CRAWLCAST_FFPROBE_BIN", "ffprobe")

# Loudness normalization target, applied to every remuxed file that has an
# audio track (two-pass EBU R128-style loudnorm). I=-16 LUFS matches common
# streaming-platform targets; TP=-1.5 dBTP leaves true-peak headroom; LRA=11
# caps how much loudness varies within one file. Using the same targets for
# every download is what makes separately-downloaded files land at a
# consistent, comparable volume instead of some being much louder/quieter
# or "flatter" than others.
LOUDNORM_I = "-16"
LOUDNORM_TP = "-1.5"
LOUDNORM_LRA = "11"

PROGRESS_RE = re.compile(r"\[download\]\s+([\d.]+)%")
DEST_RE = re.compile(r"\[download\] Destination:\s*(.+)")
MERGE_RE = re.compile(r'\[Merger\] Merging formats into "(.+)"')
ALREADY_RE = re.compile(r"\[download\]\s+(.+) has already been downloaded")


# ----------------------------------------------------------- wire protocol

def read_message():
    """Read one length-prefixed JSON message from stdin. None at EOF."""
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    (length,) = struct.unpack("<I", raw_len)
    data = sys.stdin.buffer.read(length).decode("utf-8")
    return json.loads(data)


def send_message(obj):
    """Write one length-prefixed JSON message to stdout."""
    encoded = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


# --------------------------------------------------------------- execution

def run_download(url, outdir=None):
    """Invoke the external downloader, streaming progress back as it runs."""
    if not url or not isinstance(url, str) or not url.startswith(("http://", "https://")):
        send_message({"type": "error", "message": "A valid http(s) URL is required"})
        return

    target_dir = outdir or os.path.join(os.path.expanduser("~"), "Downloads")

    cmd = [
        DOWNLOADER_BIN,
        "--newline",             # one progress line per update, easier to parse
        "--no-colors",
        "--progress",
        "--paths", target_dir,
        url,
    ]

    # Don't flash a console window on Windows
    creationflags = 0
    if os.name == "nt":
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            universal_newlines=True,
            bufsize=1,
            creationflags=creationflags,
        )
    except FileNotFoundError:
        send_message({
            "type": "error",
            "message": f"'{DOWNLOADER_BIN}' not found on PATH. Install it or set CRAWLCAST_DL_BIN.",
        })
        return
    except Exception as exc:  # noqa: BLE001 - surface anything to the UI
        send_message({"type": "error", "message": f"Failed to start downloader: {exc}"})
        return

    filename = None
    last_percent = -1.0
    tail = []

    for line in proc.stdout:
        line = line.rstrip("\n")
        tail.append(line)
        del tail[:-10]  # keep only the last 10 lines for error reporting

        dest = DEST_RE.search(line) or MERGE_RE.search(line) or ALREADY_RE.search(line)
        if dest:
            filename = os.path.basename(dest.group(1).strip())

        match = PROGRESS_RE.search(line)
        if match:
            percent = float(match.group(1))
            # Throttle: only report whole-percent changes
            if percent - last_percent >= 1.0 or percent >= 100.0:
                last_percent = percent
                send_message({"type": "progress", "percent": percent, "line": line})

    proc.wait()

    if proc.returncode == 0:
        send_message({"type": "done", "filename": filename or "download"})
    else:
        send_message({
            "type": "error",
            "message": f"Downloader exited with code {proc.returncode}: " + " | ".join(tail[-3:]),
        })


def has_audio_stream(path):
    """True if ffprobe finds at least one audio stream in path."""
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
    try:
        out = subprocess.run(
            [FFPROBE_BIN, "-v", "error", "-select_streams", "a",
             "-show_entries", "stream=index", "-of", "csv=p=0", path],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            universal_newlines=True, creationflags=creationflags,
        )
        return bool(out.stdout.strip())
    except (FileNotFoundError, OSError):
        return False


def measure_loudness(path):
    """
    Pass 1 of two-pass loudnorm: analyze path's audio against the LOUDNORM_*
    targets and return the measured stats dict, or None on any failure
    (missing ffmpeg, no audio, unparseable output) so callers can fall back
    to an unnormalized remux rather than losing the file.

    Deliberately does not pass "-v error" — loudnorm prints its JSON stats
    at the info log level, which "-v error" would silently swallow along
    with everything else.
    """
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
    cmd = [FFMPEG_BIN, "-nostdin", "-hide_banner", "-y",
           "-i", path,
           "-af", f"loudnorm=I={LOUDNORM_I}:TP={LOUDNORM_TP}:LRA={LOUDNORM_LRA}:print_format=json",
           "-f", "null", "-"]
    try:
        proc = subprocess.run(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            universal_newlines=True, creationflags=creationflags,
        )
    except (FileNotFoundError, OSError):
        return None

    match = re.search(r'\{[^{}]*"input_i"[^{}]*\}', proc.stdout or "", re.DOTALL)
    if not match:
        return None
    try:
        return json.loads(match.group(0))
    except json.JSONDecodeError:
        return None


def build_loudnorm_filter(stats):
    """Second-pass loudnorm filter string, fed pass 1's measured values."""
    return (
        f"loudnorm=I={LOUDNORM_I}:TP={LOUDNORM_TP}:LRA={LOUDNORM_LRA}"
        f":measured_I={stats['input_i']}:measured_TP={stats['input_tp']}"
        f":measured_LRA={stats['input_lra']}:measured_thresh={stats['input_thresh']}"
        f":offset={stats['target_offset']}:linear=true:print_format=summary"
    )


def run_remux(path, audio_path=None):
    """
    Rebuild a fragmented MP4 into a normal, seekable one, in place, and
    loudness-normalize its audio.

    The in-browser pipeline emits fragmented MP4: empty sample tables, no
    sidx/mfra index. Players must scan every fragment before playback, which
    causes slow startup, broken seeking, and transcoder failures. Running
    `-c copy` rebuilds real sample tables without re-encoding; +faststart puts
    moov at the front. The video stream stays a lossless copy either way.

    When the file has an audio track, its audio is additionally re-encoded
    through a two-pass loudnorm pass (see LOUDNORM_* above) so every
    download ends up at the same target loudness and dynamic range, rather
    than each stream keeping whatever level the source happened to have.
    That step only touches audio — if it fails for any reason (no audio
    track, ffmpeg/ffprobe missing, unparseable measurement), this silently
    falls back to the previous plain, lossless `-c copy` behavior so the
    file is never lost over it.

    When audio_path is given, the stream had a separate audio rendition and
    the two files are merged in the same pass — the video file on its own is
    silent.
    """
    if not path or not isinstance(path, str):
        send_message({"type": "error", "message": "A file path is required"})
        return
    if not os.path.isfile(path):
        send_message({"type": "error", "message": f"File not found: {path}"})
        return

    merging = bool(audio_path) and os.path.isfile(audio_path)
    if audio_path and not merging:
        send_message({
            "type": "remuxSkipped",
            "message": f"Audio file not found: {audio_path} — video left silent.",
        })

    # Whichever file will supply the final audio track is what gets measured.
    audio_source = audio_path if merging else path
    normalized = False
    loudnorm_filter = None
    if has_audio_stream(audio_source):
        stats = measure_loudness(audio_source)
        if stats:
            loudnorm_filter = build_loudnorm_filter(stats)
            normalized = True

    stem, ext = os.path.splitext(path)
    if ext.lower() not in (".mp4", ".m4v", ".mov"):
        ext = ".mp4"
    # Stage beside the original: ffmpeg cannot read and write the same path
    tmp = f"{stem}.remux.tmp{ext}"

    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0

    if merging:
        # -map picks video from input 0 and audio from input 1; -shortest
        # guards against a track that runs slightly long.
        base = [FFMPEG_BIN, "-nostdin", "-v", "error", "-y",
                "-i", path, "-i", audio_path,
                "-map", "0:v:0", "-map", "1:a:0"]
        if loudnorm_filter:
            cmd = base + ["-c:v", "copy", "-af", loudnorm_filter, "-ar", "48000",
                          "-c:a", "aac", "-b:a", "192k",
                          "-movflags", "+faststart", "-shortest", tmp]
        else:
            cmd = base + ["-c", "copy", "-movflags", "+faststart", "-shortest", tmp]
    else:
        base = [FFMPEG_BIN, "-nostdin", "-v", "error", "-y", "-i", path]
        if loudnorm_filter:
            cmd = base + ["-c:v", "copy", "-af", loudnorm_filter, "-ar", "48000",
                          "-c:a", "aac", "-b:a", "192k",
                          "-movflags", "+faststart", tmp]
        else:
            cmd = base + ["-c", "copy", "-movflags", "+faststart", tmp]

    try:
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            universal_newlines=True,
            creationflags=creationflags,
        )
    except FileNotFoundError:
        send_message({
            "type": "remuxSkipped",
            "message": f"'{FFMPEG_BIN}' not found on PATH — file left as-is.",
        })
        return
    except Exception as exc:  # noqa: BLE001
        send_message({"type": "error", "message": f"Failed to start ffmpeg: {exc}"})
        return

    ok = proc.returncode == 0 and os.path.isfile(tmp) and os.path.getsize(tmp) > 1024

    # Verify by DURATION, not size: a lossless remux can legitimately shrink
    # a file substantially, so a size heuristic yields false failures.
    #
    # Tolerance is 1% OR 0.5s, whichever is larger — a pure percentage check
    # is too tight for short clips once loudnorm is in play: re-encoding
    # audio through AAC adds a small, roughly fixed amount of encoder
    # priming/padding (observed ~100ms in testing) that shows up as extra
    # container duration regardless of how long the source is. A genuine
    # failure (e.g. a truncated remux) differs by far more than this floor.
    if ok:
        d_src, d_out = probe_duration(path), probe_duration(tmp)
        if d_src and d_out:
            tolerance = max(d_src * 0.01, 0.5)
            if not (d_src - tolerance < d_out < d_src + tolerance):
                ok = False

    if ok:
        try:
            target = stem + ext
            os.replace(tmp, target)
            if target != path and os.path.isfile(path):
                os.remove(path)  # container changed
            # The separate audio file has been folded in; drop the leftover
            if merging and os.path.isfile(audio_path):
                try:
                    os.remove(audio_path)
                except OSError:
                    pass
            send_message({"type": "remuxed", "path": target,
                          "bytes": os.path.getsize(target),
                          "merged": merging,
                          "normalized": normalized})
        except OSError as exc:
            send_message({"type": "error", "message": f"Could not replace file: {exc}"})
    else:
        if os.path.isfile(tmp):
            os.remove(tmp)
        tail = (proc.stdout or "").strip().splitlines()[-2:]
        send_message({
            "type": "remuxSkipped",
            "message": "ffmpeg could not remux this file: " + " | ".join(tail),
        })


def probe_duration(path):
    """Container duration in seconds, or None if ffprobe is unavailable."""
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
    try:
        out = subprocess.run(
            [FFPROBE_BIN, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            universal_newlines=True, creationflags=creationflags,
        )
        return float(out.stdout.strip())
    except (FileNotFoundError, ValueError, OSError):
        return None


def main():
    while True:
        try:
            message = read_message()
        except Exception as exc:  # noqa: BLE001
            send_message({"type": "error", "message": f"Bad message: {exc}"})
            return
        if message is None:
            return  # extension closed the port

        if message.get("action") == "remux":
            run_remux(message.get("path"), message.get("audioPath"))
        else:
            run_download(message.get("url"), message.get("outdir"))


if __name__ == "__main__":
    main()
