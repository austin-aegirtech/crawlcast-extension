#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: ./register-native-host-from-wsl.sh <chrome-extension-id>" >&2
  exit 1
fi

extension_id="$1"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ps_script_windows="$(wslpath -w "$script_dir/register-native-host.ps1")"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$ps_script_windows" -ExtensionId "$extension_id"
