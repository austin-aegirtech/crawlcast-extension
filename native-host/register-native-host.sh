#!/usr/bin/env bash
set -euo pipefail

HOST_NAME="com.crawlcast.downloader"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST_PATH="$SCRIPT_DIR/${HOST_NAME}.json"

if ! command -v wslpath >/dev/null 2>&1; then
  echo "This installer must be run from WSL." >&2
  exit 1
fi

if ! command -v reg.exe >/dev/null 2>&1; then
  echo "Windows reg.exe is not available from this WSL environment." >&2
  exit 1
fi

if [[ ! -f "$MANIFEST_PATH" ]]; then
  echo "Native host manifest not found: $MANIFEST_PATH" >&2
  exit 1
fi

WINDOWS_MANIFEST_PATH="$(wslpath -w "$MANIFEST_PATH")"
REGISTRY_KEY="HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}"

reg.exe ADD "$REGISTRY_KEY" /ve /t REG_SZ /d "$WINDOWS_MANIFEST_PATH" /f >/dev/null

echo "Registered ${HOST_NAME}"
echo "Manifest: ${WINDOWS_MANIFEST_PATH}"
echo "Restart Chrome before testing remux again."
