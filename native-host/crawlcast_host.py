#!/usr/bin/env python3
"""Crawlcast native messaging host for MP4 inspection and remux/repair.

Protocol: Chrome native messaging over stdin/stdout using length-prefixed JSON.
"""

import json
import os
import struct
import subprocess
import sys

# Used to repair fragmented/non-faststart MP4s produced by the in-browser
# pipeline. Optional: if absent, files are simply left as they are.
FFMPEG_BIN = os.environ.get("CRAWLCAST_FFMPEG_BIN", "ffmpeg")
FFPROBE_BIN = os.environ.get("CRAWLCAST_FFPROBE_BIN", "ffprobe")


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


# --------------------------------------------------------------- inspection

def inspect_mp4(path):
    """Return whether an MP4 needs remuxing for normal indexed/faststart use.

    A normal seekable MP4 should have its ``moov`` metadata before media data
    and should not contain top-level ``moof`` fragments. The check only reads
    MP4 box headers, not media payloads, so even very large direct downloads
    can be classified quickly.
    """
    if not path or not isinstance(path, str):
        return True, "invalid-path"
    if not os.path.isfile(path):
        return True, "file-not-found"

    try:
        file_size = os.path.getsize(path)
        moov_offset = None
        mdat_offset = None
        fragmented = False
        offset = 0

        with open(path, "rb") as handle:
            while offset + 8 <= file_size:
                handle.seek(offset)
                header = handle.read(8)
                if len(header) != 8:
                    break

                box_size = struct.unpack(">I", header[:4])[0]
                box_type = header[4:8]
                header_size = 8

                if box_size == 1:
                    extended = handle.read(8)
                    if len(extended) != 8:
                        return True, "invalid-box-header"
                    box_size = struct.unpack(">Q", extended)[0]
                    header_size = 16
                elif box_size == 0:
                    box_size = file_size - offset

                if box_size < header_size or offset + box_size > file_size:
                    return True, "invalid-box-size"

                if box_type == b"moov" and moov_offset is None:
                    moov_offset = offset
                elif box_type == b"mdat" and mdat_offset is None:
                    mdat_offset = offset
                elif box_type == b"moof":
                    fragmented = True

                offset += box_size

        if fragmented:
            return True, "fragmented"
        if moov_offset is None:
            return True, "missing-moov"
        if mdat_offset is None:
            return True, "missing-mdat"
        if moov_offset > mdat_offset:
            return True, "moov-after-media"
        return False, "already-optimized"
    except OSError:
        return True, "inspection-failed"


def send_inspection(path):
    if not path or not isinstance(path, str):
        send_message({"type": "error", "message": "A file path is required"})
        return
    if not os.path.isfile(path):
        send_message({"type": "error", "message": f"File not found: {path}"})
        return

    needs_remux, reason = inspect_mp4(path)
    send_message({
        "type": "inspection",
        "path": path,
        "needsRemux": needs_remux,
        "reason": reason,
    })


# --------------------------------------------------------------- execution

def run_remux(path, audio_path=None):
    """Rebuild an MP4 into a normal, seekable/faststart file in place.

    This is intentionally a stream-copy operation. Video and audio are not
    re-encoded, so repair is limited primarily by disk I/O rather than codec
    speed. When ``audio_path`` is supplied, the separate audio rendition is
    merged into the video in the same lossless-copy pass.
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
        return

    stem, ext = os.path.splitext(path)
    if ext.lower() not in (".mp4", ".m4v", ".mov"):
        ext = ".mp4"
    tmp = f"{stem}.remux.tmp{ext}"

    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0

    if merging:
        cmd = [
            FFMPEG_BIN, "-nostdin", "-v", "error", "-y",
            "-i", path, "-i", audio_path,
            "-map", "0:v:0", "-map", "1:a:0",
            "-c", "copy", "-movflags", "+faststart", "-shortest", tmp,
        ]
    else:
        cmd = [
            FFMPEG_BIN, "-nostdin", "-v", "error", "-y",
            "-i", path,
            "-c", "copy", "-movflags", "+faststart", tmp,
        ]

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

    # Verify by duration, not size: a lossless remux can legitimately shrink
    # a file substantially, so a size heuristic yields false failures.
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
                os.remove(path)
            if merging and os.path.isfile(audio_path):
                try:
                    os.remove(audio_path)
                except OSError:
                    pass
            send_message({
                "type": "remuxed",
                "path": target,
                "bytes": os.path.getsize(target),
                "merged": merging,
            })
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
            return

        action = message.get("action")
        if action == "inspect":
            send_inspection(message.get("path"))
        elif action == "remux":
            run_remux(message.get("path"), message.get("audioPath"))
        else:
            send_message({"type": "error", "message": "Unsupported native-host action"})


if __name__ == "__main__":
    main()
