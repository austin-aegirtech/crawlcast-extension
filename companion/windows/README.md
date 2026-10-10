# Crawlcast Companion for Windows

This installer packages the Crawlcast native host with FFmpeg and FFprobe. It
installs per user under `%LOCALAPPDATA%`, registers the host for Chrome and
Edge, and does not require Python on the customer's computer.

## Build requirements

- Windows 11
- Python 3
- `py -3 -m pip install pyinstaller`
- Inno Setup 6
- A redistributable Windows x64 FFmpeg build containing `ffmpeg.exe` and
  `ffprobe.exe`
- The final Chrome Web Store extension ID
- The final Edge Add-ons extension ID, when publishing through Edge Add-ons

## Build

```powershell
.\companion\windows\build-companion.ps1 `
  -ChromeExtensionId 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' `
  -EdgeExtensionId 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' `
  -FfmpegBinDirectory 'C:\path\to\ffmpeg\bin' `
  -Version '0.3.0'
```

The installer is written to `companion\windows\dist`.

## Before release

1. Replace the example IDs with the IDs assigned by the two stores.
2. Use an FFmpeg build whose redistribution terms you can satisfy and replace
   `THIRD-PARTY-NOTICES.txt` with the required notices.
3. Code-sign the installer and `crawlcast_host.exe` with your signing
   certificate.
4. Install on a clean Windows user account and test both browsers.
5. Restart each browser after installing or upgrading the companion.
