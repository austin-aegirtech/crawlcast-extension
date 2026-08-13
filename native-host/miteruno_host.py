#!/usr/bin/env python3
"""
Miteruno native messaging host.

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
               {"type": "remuxed", "path": "...", "bytes": 123}
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
# and on PATH (or given as an absolute path). Override with MITERUNO_DL_BIN.
DOWNLOADER_BIN = os.environ.get("MITERUNO_DL_BIN", "yt-dlp")

# Used to repair fragmented MP4s produced by the in-browser pipeline.
# Optional: if absent, files are simply left as they are.
FFMPEG_BIN = os.environ.get("MITERUNO_FFMPEG_BIN", "ffmpeg")
FFPROBE_BIN = os.environ.get("MITERUNO_FFPROBE_BIN", "ffprobe")

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
            "message": f"'{DOWNLOADER_BIN}' not found on PATH. Install it or set MITERUNO_DL_BIN.",
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


def run_remux(path, audio_path=None):
    """
    Rebuild a fragmented MP4 into a normal, seekable one, in place.

    The in-browser pipeline emits fragmented MP4: empty sample tables, no
    sidx/mfra index. Players must scan every fragment before playback, which
    causes slow startup, broken seeking, and transcoder failures. Running
    `-c copy` rebuilds real sample tables without re-encoding; +faststart puts
    moov at the front. Fast and lossless.

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

    stem, ext = os.path.splitext(path)
    if ext.lower() not in (".mp4", ".m4v", ".mov"):
        ext = ".mp4"
    # Stage beside the original: ffmpeg cannot read and write the same path
    tmp = f"{stem}.remux.tmp{ext}"

    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0

    if merging:
        # -map picks video from input 0 and audio from input 1; -shortest
        # guards against a track that runs slightly long.
        cmd = [FFMPEG_BIN, "-nostdin", "-v", "error", "-y",
               "-i", path, "-i", audio_path,
               "-map", "0:v:0", "-map", "1:a:0",
               "-c", "copy", "-movflags", "+faststart", "-shortest", tmp]
    else:
        cmd = [FFMPEG_BIN, "-nostdin", "-v", "error", "-y",
               "-i", path, "-c", "copy", "-movflags", "+faststart", tmp]

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
    if ok:
        d_src, d_out = probe_duration(path), probe_duration(tmp)
        if d_src and d_out and not (d_src * 0.99 < d_out < d_src * 1.01):
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
                          "merged": merging})
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
