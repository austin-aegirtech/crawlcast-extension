#!/usr/bin/env bash

set -u

root="${1:-}"

if [[ -z "$root" || ! -d "$root" ]]; then
  echo "Usage: $0 /path/to/video/directory"
  exit 1
fi

find "$root" -type f -name '*.normalized.*' -print0 |
while IFS= read -r -d '' normalized; do
  extension=".${normalized##*.}"
  original="${normalized%$extension}"
  original="${original%.normalized}${extension}"
  backup="${original}.crawlcast-backup"

  if [[ ! -f "$original" ]]; then
    echo "SKIPPED — original missing: $normalized"
    continue
  fi

  if [[ -e "$backup" ]]; then
    echo "SKIPPED — backup already exists: $backup"
    continue
  fi

  mv -- "$original" "$backup" || {
    echo "FAILED — could not back up: $original"
    continue
  }

  if mv -- "$normalized" "$original"; then
    rm -- "$backup"
    echo "REPLACED: $original"
  else
    mv -- "$backup" "$original"
    echo "FAILED — original restored: $original"
  fi
done