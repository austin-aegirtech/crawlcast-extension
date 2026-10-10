#!/usr/bin/env python3
"""Crawlcast native messaging host for MP4 repair and audio extraction.

Protocol: Chrome native messaging over stdin/stdout using length-prefixed JSON.
"""

import json
import os
import re
import struct
import subprocess
import sys
import unicodedata

# Used to repair fragmented/non-faststart MP4s produced by the in-browser
# pipeline. Optional: if absent, files are simply left as they are.
def bundled_tool(name):
    """Prefer tools shipped beside the packaged companion executable."""
    base_dir = os.path.dirname(
        sys.executable if getattr(sys, "frozen", False) else os.path.abspath(__file__)
    )
    executable = f"{name}.exe" if os.name == "nt" else name
    candidate = os.path.join(base_dir, "bin", executable)
    return candidate if os.path.isfile(candidate) else name


FFMPEG_BIN = os.environ.get("CRAWLCAST_FFMPEG_BIN", bundled_tool("ffmpeg"))
FFPROBE_BIN = os.environ.get("CRAWLCAST_FFPROBE_BIN", bundled_tool("ffprobe"))
LOUDNESS_TARGET_I = -16.0
LOUDNESS_TARGET_TP = -1.5
LOUDNESS_TARGET_LRA = 11.0
LOUDNESS_BOOST_THRESHOLD = 0.5


def sanitize_output_filename(value, extension):
    """Return an FFmpeg-safe filename while preserving readable punctuation."""
    translated = unicodedata.normalize("NFKC", str(value or "")).translate(str.maketrans({
        "\u2018": "'",
        "\u2019": "'",
        "\u201a": "'",
        "\u201b": "'",
        "\u201c": "",
        "\u201d": "",
        "\u201e": "",
        "\u201f": "",
        "\u2013": "-",
        "\u2014": "-",
        "\u2026": "...",
        "\u00a0": " ",
    }))
    filename = os.path.basename(translated.strip())
    filename = re.sub(r'[<>:"/\\|?*\x00-\x1f]', ' ', filename)
    filename = re.sub(r'\s+', ' ', filename).rstrip('. ').strip()

    expected_ext = f".{extension.lower()}"
    stem = os.path.splitext(filename)[0].rstrip('. ').strip()
    if not stem:
        stem = "audio"
    if re.fullmatch(r'(con|prn|aux|nul|com[1-9]|lpt[1-9])', stem, re.IGNORECASE):
        stem = f"audio_{stem}"

    # Keep room for the temporary suffix and the containing Downloads path.
    stem = stem[:180].rstrip('. ').strip() or "audio"
    return f"{stem}{expected_ext}"


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


def _finite_float(value):
    try:
        number = float(value)
        return number if number not in (float("inf"), float("-inf")) else None
    except (TypeError, ValueError):
        return None


def analyze_loudness(path):
    """Measure the first audio stream using FFmpeg's EBU R128 loudnorm pass."""
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
    cmd = [
        FFMPEG_BIN, "-nostdin", "-hide_banner", "-v", "info", "-i", path,
        "-map", "0:a:0", "-vn",
        "-af", (
            f"loudnorm=I={LOUDNESS_TARGET_I}:TP={LOUDNESS_TARGET_TP}:"
            f"LRA={LOUDNESS_TARGET_LRA}:print_format=json"
        ),
        "-f", "null", "-",
    ]
    try:
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=creationflags,
        )
    except (FileNotFoundError, OSError):
        return None

    output = proc.stdout or ""
    matches = re.findall(r"\{\s*\"input_i\"[\s\S]*?\}", output)
    if not matches:
        return None
    try:
        raw = json.loads(matches[-1])
    except json.JSONDecodeError:
        return None

    measured = {
        "input_i": _finite_float(raw.get("input_i")),
        "input_tp": _finite_float(raw.get("input_tp")),
        "input_lra": _finite_float(raw.get("input_lra")),
        "input_thresh": _finite_float(raw.get("input_thresh")),
        "target_offset": _finite_float(raw.get("target_offset")),
    }
    if any(measured[key] is None for key in measured):
        return None
    return measured


def should_normalize(measured):
    return bool(measured) and measured["input_i"] < (
        LOUDNESS_TARGET_I - LOUDNESS_BOOST_THRESHOLD
    )


def build_loudnorm_filter(measured):
    return (
        f"loudnorm=I={LOUDNESS_TARGET_I}:TP={LOUDNESS_TARGET_TP}:LRA={LOUDNESS_TARGET_LRA}:"
        f"measured_I={measured['input_i']}:measured_TP={measured['input_tp']}:"
        f"measured_LRA={measured['input_lra']}:measured_thresh={measured['input_thresh']}:"
        f"offset={measured['target_offset']}:linear=true:print_format=summary"
    )


# --------------------------------------------------------------- execution

def run_remux(path, audio_path=None, subtitle_path=None, subtitle_url=None,
              subtitle_name=None, subtitle_language=None):
    """Rebuild an MP4 into a normal, seekable/faststart file in place.

    This is intentionally a stream-copy operation. Video and audio are not
    re-encoded, so repair is limited primarily by disk I/O rather than codec
    speed. Separate audio is copied losslessly. A WebVTT subtitle file or HLS
    subtitle playlist is converted to MP4-compatible mov_text in the same pass.
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

    subtitle_source = None
    if subtitle_path:
        if not os.path.isfile(subtitle_path):
            send_message({
                "type": "remuxSkipped",
                "message": f"Subtitle file not found: {subtitle_path}",
            })
            return
        subtitle_source = subtitle_path
    elif subtitle_url:
        if not isinstance(subtitle_url, str) or not re.match(r"^https?://", subtitle_url, re.I):
            send_message({
                "type": "remuxSkipped",
                "message": "Subtitle URL must use HTTP or HTTPS",
            })
            return
        subtitle_source = subtitle_url
    subtitling = bool(subtitle_source)
    loudness = analyze_loudness(audio_path if merging else path)
    normalizing = should_normalize(loudness)

    stem, ext = os.path.splitext(path)
    if ext.lower() not in (".mp4", ".m4v", ".mov"):
        ext = ".mp4"
    tmp = f"{stem}.remux.tmp{ext}"

    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0

    if merging or subtitling or normalizing:
        cmd = [FFMPEG_BIN, "-nostdin", "-v", "error", "-y", "-i", path]
        audio_input = None
        subtitle_input = None
        next_input = 1
        if merging:
            audio_input = next_input
            cmd.extend(["-i", audio_path])
            next_input += 1
        if subtitling:
            subtitle_input = next_input
            cmd.extend(["-i", subtitle_source])

        cmd.extend(["-map", "0:v:0"])
        if audio_input is not None:
            cmd.extend(["-map", f"{audio_input}:a:0"])
        else:
            cmd.extend(["-map", "0:a:0?"])
        if subtitle_input is not None:
            cmd.extend(["-map", f"{subtitle_input}:s:0"])

        cmd.extend(["-c:v", "copy"])
        if normalizing:
            cmd.extend([
                "-c:a", "aac", "-b:a", "256k",
                "-af", build_loudnorm_filter(loudness),
            ])
        else:
            cmd.extend(["-c:a", "copy"])
        if subtitling:
            cmd.extend(["-c:s", "mov_text", "-disposition:s:0", "default"])
            if subtitle_name:
                cmd.extend(["-metadata:s:s:0", f"title={subtitle_name}"])
            if subtitle_language:
                cmd.extend(["-metadata:s:s:0", f"language={subtitle_language}"])
        cmd.extend(["-movflags", "+faststart"])
        if merging and not subtitling:
            cmd.append("-shortest")
        cmd.append(tmp)
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
            text=True,
            encoding="utf-8",
            errors="replace",
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
                "subtitled": subtitling,
                "normalized": normalizing,
                "inputLoudness": loudness["input_i"] if loudness else None,
                "targetLoudness": LOUDNESS_TARGET_I,
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


def unique_output_path(directory, filename):
    """Return a non-existing output path without overwriting prior downloads."""
    candidate = os.path.join(directory, filename)
    if not os.path.exists(candidate):
        return candidate

    stem, ext = os.path.splitext(filename)
    counter = 1
    while True:
        candidate = os.path.join(directory, f"{stem} ({counter}){ext}")
        if not os.path.exists(candidate):
            return candidate
        counter += 1


def run_extract_audio(path, output_name, audio_format):
    """Extract the first audio track to M4A/AAC or 320 kbps MP3.

    M4A first attempts a lossless AAC stream copy. If the source audio codec
    cannot be stored in M4A, it falls back to AAC transcoding. MP3 always
    transcodes because MP4/HLS sources normally carry AAC audio.
    """
    if not path or not isinstance(path, str):
        send_message({"type": "error", "message": "A source file path is required"})
        return
    if not os.path.isfile(path):
        send_message({"type": "error", "message": f"Source file not found: {path}"})
        return
    if audio_format not in ("m4a", "mp3"):
        send_message({"type": "error", "message": "Audio format must be m4a or mp3"})
        return

    requested_name = sanitize_output_filename(output_name, audio_format)

    output_path = unique_output_path(os.path.dirname(path), requested_name)
    output_stem, output_ext = os.path.splitext(output_path)
    tmp = f"{output_stem}.crawlcast.tmp{output_ext}"
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
    loudness = analyze_loudness(path)
    normalizing = should_normalize(loudness)
    loudnorm_args = ["-af", build_loudnorm_filter(loudness)] if normalizing else []

    if audio_format == "m4a":
        if normalizing:
            commands = [
                ([FFMPEG_BIN, "-nostdin", "-v", "error", "-y", "-i", path,
                  "-map", "0:a:0", "-vn", *loudnorm_args,
                  "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", tmp], True),
            ]
        else:
            commands = [
                ([FFMPEG_BIN, "-nostdin", "-v", "error", "-y", "-i", path,
                  "-map", "0:a:0", "-vn", "-c:a", "copy", "-movflags", "+faststart", tmp], False),
                ([FFMPEG_BIN, "-nostdin", "-v", "error", "-y", "-i", path,
                  "-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", "256k",
                  "-movflags", "+faststart", tmp], True),
            ]
    else:
        commands = [
            ([FFMPEG_BIN, "-nostdin", "-v", "error", "-y", "-i", path,
              "-map", "0:a:0", "-vn", *loudnorm_args,
              "-c:a", "libmp3lame", "-b:a", "320k",
              "-id3v2_version", "3", tmp], True),
        ]

    last_output = ""
    transcoded = False
    for cmd, command_transcoded in commands:
        if os.path.isfile(tmp):
            os.remove(tmp)
        try:
            proc = subprocess.run(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                creationflags=creationflags,
            )
        except FileNotFoundError:
            send_message({"type": "error", "message": f"'{FFMPEG_BIN}' not found on PATH"})
            return
        except Exception as exc:  # noqa: BLE001
            send_message({"type": "error", "message": f"Failed to start ffmpeg: {exc}"})
            return

        last_output = proc.stdout or ""
        if proc.returncode == 0 and os.path.isfile(tmp) and os.path.getsize(tmp) > 1024:
            transcoded = command_transcoded
            break
    else:
        if os.path.isfile(tmp):
            os.remove(tmp)
        if re.search(r'(matches no streams|contains no audio|no audio stream)', last_output, re.IGNORECASE):
            send_message({
                "type": "error",
                "message": "No audio track was found in the downloaded source. "
                           "This page may deliver video and audio as separate streams.",
            })
            return
        tail = last_output.strip().splitlines()[-2:]
        send_message({
            "type": "error",
            "message": "ffmpeg could not extract audio: " + " | ".join(tail),
        })
        return

    try:
        os.replace(tmp, output_path)
        source_removed = True
        try:
            os.remove(path)
        except OSError:
            source_removed = False
        send_message({
            "type": "audioExtracted",
            "path": output_path,
            "format": audio_format,
            "bytes": os.path.getsize(output_path),
            "transcoded": transcoded,
            "sourceRemoved": source_removed,
            "normalized": normalizing,
            "inputLoudness": loudness["input_i"] if loudness else None,
            "targetLoudness": LOUDNESS_TARGET_I,
        })
    except OSError as exc:
        if os.path.isfile(tmp):
            os.remove(tmp)
        send_message({"type": "error", "message": f"Could not finalize audio file: {exc}"})


def probe_duration(path):
    """Container duration in seconds, or None if ffprobe is unavailable."""
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
    try:
        out = subprocess.run(
            [FFPROBE_BIN, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding="utf-8", errors="replace",
            creationflags=creationflags,
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
            run_remux(
                message.get("path"),
                message.get("audioPath"),
                message.get("subtitlePath"),
                message.get("subtitleUrl"),
                message.get("subtitleName"),
                message.get("subtitleLanguage"),
            )
        elif action == "extractAudio":
            run_extract_audio(
                message.get("path"),
                message.get("outputName"),
                message.get("format"),
            )
        else:
            send_message({"type": "error", "message": "Unsupported native-host action"})


if __name__ == "__main__":
    main()
