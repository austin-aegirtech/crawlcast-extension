#!/usr/bin/env bash
#
# remux.sh — rebuild fragmented MP4s into normal, seekable MP4s.
#
# Videos produced by the in-browser HLS pipeline are FRAGMENTED MP4: the moov
# box has empty sample tables and there is no sidx/mfra index, so players must
# scan every fragment before playback. That causes slow startup, broken seeking,
# and transcoder failures (e.g. Plex on mobile).
#
#   ffmpeg -i in.mp4 -c copy -movflags +faststart out.mp4
#
# -c copy      rebuild the container without re-encoding (fast, lossless)
# +faststart   move moov to the front of the file for streaming clients
#
# Filenames are preserved. Containers that cannot hold an MP4 index (.ts, .mkv,
# .webm) get a .mp4 extension — the only case where a name changes.
#
# Usage:
#   ./remux.sh [DIR] [options]
#
# Options:
#   -o DIR   output directory (default: DIR/remuxed)
#   -i       in-place: replace originals (stages to a temp file, then swaps)
#   -r       recurse into subdirectories
#   -n       dry run: print what would happen, change nothing
#   -f       overwrite existing outputs instead of skipping
#   -h       show this help
#
# Examples:
#   ./remux.sh ~/Downloads
#   ./remux.sh ~/Downloads -o ~/Videos/fixed
#   ./remux.sh ~/Downloads -i -r
#   ./remux.sh ~/Downloads -n

set -uo pipefail

SRC_DIR="."
OUT_DIR=""
IN_PLACE=0
RECURSE=0
DRY_RUN=0
FORCE=0

# Extensions we attempt to remux.
EXTENSIONS=(mp4 m4v mov mkv ts webm)

usage() { sed -n '2,34p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

# ------------------------------------------------------------------ arguments

while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) OUT_DIR="${2:-}"; shift 2 ;;
    -i) IN_PLACE=1; shift ;;
    -r) RECURSE=1; shift ;;
    -n) DRY_RUN=1; shift ;;
    -f) FORCE=1; shift ;;
    -h|--help) usage ;;
    -*) echo "Unknown option: $1" >&2; exit 2 ;;
    *)  SRC_DIR="$1"; shift ;;
  esac
done

[[ -z "$OUT_DIR" ]] && OUT_DIR="$SRC_DIR/remuxed"

# -------------------------------------------------------------------- checks

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "Error: ffmpeg not found on PATH." >&2
  echo "  Windows: winget install Gyan.FFmpeg   (then reopen your terminal)" >&2
  echo "  macOS:   brew install ffmpeg" >&2
  echo "  Linux:   sudo apt install ffmpeg" >&2
  exit 1
fi

HAVE_FFPROBE=0
command -v ffprobe >/dev/null 2>&1 && HAVE_FFPROBE=1

# Only emit carriage returns to a real terminal; keeps piped/redirected
# output readable in logs.
if [[ -t 1 ]]; then CR=$'\r'; else CR=""; fi

if [[ ! -d "$SRC_DIR" ]]; then
  echo "Error: '$SRC_DIR' is not a directory." >&2
  exit 1
fi

if [[ $IN_PLACE -eq 0 && $DRY_RUN -eq 0 ]]; then
  mkdir -p "$OUT_DIR" || { echo "Error: cannot create '$OUT_DIR'." >&2; exit 1; }
fi

# --------------------------------------------------------------- file listing

# Build a find expression matching any of our extensions
find_args=()
for i in "${!EXTENSIONS[@]}"; do
  [[ $i -gt 0 ]] && find_args+=(-o)
  find_args+=(-iname "*.${EXTENSIONS[$i]}")
done

depth_args=()
[[ $RECURSE -eq 0 ]] && depth_args=(-maxdepth 1)

# NUL-delimited so spaces, quotes and unicode in filenames survive.
# Prune the current output dir and any previous "remuxed" folder, otherwise a
# recursive run re-processes files this script produced earlier.
files=()
while IFS= read -r -d '' f; do
  files+=("$f")
done < <(find "$SRC_DIR" "${depth_args[@]}" \
           \( -type d \( -path "$OUT_DIR" -o -name remuxed \) -prune \) -o \
           \( -type f \( "${find_args[@]}" \) -print0 \) 2>/dev/null | sort -z)

if [[ ${#files[@]} -eq 0 ]]; then
  echo "No video files found in '$SRC_DIR'."
  exit 0
fi

# ------------------------------------------------------------------ helpers

human() {
  local b=$1
  if   [[ $b -ge 1000000000 ]]; then awk "BEGIN{printf \"%.2f GB\", $b/1000000000}"
  elif [[ $b -ge 1000000    ]]; then awk "BEGIN{printf \"%.0f MB\", $b/1000000}"
  else                               awk "BEGIN{printf \"%.0f KB\", $b/1000}"
  fi
}

size_of() { wc -c < "$1" 2>/dev/null | tr -d ' ' || echo 0; }

duration_of() {
  ffprobe -v error -show_entries format=duration \
          -of default=noprint_wrappers=1:nokey=1 "$1" 2>/dev/null || echo ""
}

# Is the remux complete? Compare durations, not sizes: a TS -> MP4 remux
# legitimately shrinks the file by ~50% (MPEG-TS carries heavy 188-byte-packet
# overhead), so a size heuristic produces false failures. Duration within 1%
# means every sample made it across.
remux_is_valid() {
  local src="$1" out="$2"
  [[ -s "$out" ]] || return 1

  if [[ $HAVE_FFPROBE -eq 1 ]]; then
    local d_src d_out
    d_src="$(duration_of "$src")"
    d_out="$(duration_of "$out")"
    if [[ -n "$d_src" && -n "$d_out" ]]; then
      awk "BEGIN{ s=$d_src; o=$d_out; exit !(s > 0 && o > s*0.99 && o < s*1.01) }"
      return $?
    fi
  fi

  # Fallback when ffprobe is unavailable or can't read a duration:
  # just require non-trivial output.
  local out_size
  out_size=$(size_of "$out")
  [[ "$out_size" -gt 1024 ]]
}

converted=0; skipped=0; failed=0
failed_files=()

echo "Found ${#files[@]} file(s) in '$SRC_DIR'"
if [[ $IN_PLACE -eq 1 ]]; then
  echo "Mode: IN-PLACE (originals will be replaced)"
else
  echo "Mode: copy to '$OUT_DIR'"
fi
[[ $DRY_RUN -eq 1 ]] && echo "DRY RUN - nothing will be written"
echo

# ---------------------------------------------------------------------- work

for src in "${files[@]}"; do
  base="$(basename "$src")"
  stem="${base%.*}"
  ext="${base##*.}"
  ext_lower="$(printf '%s' "$ext" | tr '[:upper:]' '[:lower:]')"

  # Keep the extension when the container can already hold an MP4 index
  case "$ext_lower" in
    mp4|m4v|mov) out_ext="$ext" ;;
    *)           out_ext="mp4"  ;;
  esac

  if [[ $IN_PLACE -eq 1 ]]; then
    dest="$(dirname "$src")/$stem.$out_ext"
  else
    dest="$OUT_DIR/$stem.$out_ext"
  fi

  # Skip work already done
  if [[ $IN_PLACE -eq 0 && $FORCE -eq 0 && -f "$dest" ]]; then
    echo "  skip   $base (output exists)"
    skipped=$((skipped + 1))
    continue
  fi

  if [[ $DRY_RUN -eq 1 ]]; then
    echo "  would  $base  ->  $dest"
    converted=$((converted + 1))
    continue
  fi

  # ffmpeg cannot read and write the same path, so always stage to a temp file
  tmp="$(dirname "$dest")/.${stem}.remux.$$.$out_ext"
  err="$(mktemp)"

  [[ -n "$CR" ]] && printf '  ...    %s' "$base"

  if ffmpeg -nostdin -v error -y -i "$src" -c copy -movflags +faststart "$tmp" 2>"$err"; then
    if remux_is_valid "$src" "$tmp"; then
      tmp_size=$(size_of "$tmp")
      mv -f "$tmp" "$dest"
      # Extension changed (e.g. .ts -> .mp4): drop the now-redundant original
      [[ $IN_PLACE -eq 1 && "$src" != "$dest" ]] && rm -f "$src"
      printf '%s  ok     %s  (%s)\n' "$CR" "$base" "$(human "$tmp_size")"
      converted=$((converted + 1))
    else
      rm -f "$tmp"
      printf '%s  FAIL   %s  (duration mismatch - output incomplete)\n' "$CR" "$base"
      failed_files+=("$base")
      failed=$((failed + 1))
    fi
  else
    rm -f "$tmp"
    printf '%s  FAIL   %s\n' "$CR" "$base"
    sed 's/^/           /' "$err" | head -3
    failed_files+=("$base")
    failed=$((failed + 1))
  fi

  rm -f "$err"
done

# ------------------------------------------------------------------- summary

echo
echo "-----------------------------------------"
echo "  converted: $converted"
echo "  skipped:   $skipped"
echo "  failed:    $failed"
if [[ $failed -gt 0 ]]; then
  echo
  echo "  Failures:"
  for f in "${failed_files[@]}"; do echo "    - $f"; done
fi
echo "-----------------------------------------"

[[ $failed -gt 0 ]] && exit 1
exit 0
