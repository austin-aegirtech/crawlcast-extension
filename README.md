<div align="center">
  <img src="./icons/icon128.png" alt="Crawlcast logo" width="104" height="104">

  # Crawlcast

  **Detect HLS streams. Download them. Turn them into usable MP4 files.**

  Crawlcast is a Manifest V3 browser extension that watches the active page for HLS (`.m3u8`) streams, previews what it finds, downloads the stream segments, and assembles them into MP4 output directly from the browser.

  [![Version](https://img.shields.io/badge/version-1.0.0-7c3aed?style=for-the-badge)](./manifest.json)
  [![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white)](./manifest.json)
  [![HLS](https://img.shields.io/badge/media-HLS%20%2F%20M3U8-0ea5e9?style=for-the-badge)](./m3u8-parser.js)
  [![JavaScript](https://img.shields.io/badge/JavaScript-Vanilla-F7DF1E?style=for-the-badge&logo=javascript&logoColor=111)](./background.js)
  [![FFmpeg](https://img.shields.io/badge/FFmpeg-optional%20repair-007808?style=for-the-badge&logo=ffmpeg&logoColor=white)](./native-host)

  [Features](#features) · [Install](#install) · [How it works](#how-it-works) · [Native MP4 repair](#native-mp4-repair) · [Development](#development) · [Limitations](#current-limitations)
</div>

---

## What is Crawlcast?

Many streaming sites do not deliver video as a single downloadable file. Instead, HLS splits media into a playlist and a large number of small segments that a player fetches while the video runs.

Crawlcast watches those requests for you.

When it detects an HLS playlist, the extension adds it to the popup where you can inspect the stream, see available metadata and a preview, then download it as an MP4. When the optional native repair host is installed, Crawlcast can also run a final FFmpeg pass so the completed file is easier to seek and more broadly compatible with media players and servers.

> [!IMPORTANT]
> Crawlcast is a media transport and file-processing tool. Only download media that you own or are authorized to save. Website terms, copyright rules, and access restrictions still apply.

## Features

<table>
<tr>
<td width="50%" valign="top">

### For viewers

- Automatic `.m3u8` / HLS detection
- Stream cards scoped to the active tab
- Real page titles used for readable download filenames
- Thumbnail previews when the stream can be analyzed
- Duration, resolution, host, request type, and estimated size
- Live segment download progress
- Cancel support for active downloads
- Clear completion and repair states
- Built-in diagnostic log viewer
- Clean dark popup UI
- Premium UI placeholder for future features

</td>
<td width="50%" valign="top">

### Under the hood

- Chrome Manifest V3 service worker
- Session-backed detected-stream registry
- Offscreen document for DOM-dependent media work
- Master and media playlist parsing
- MPEG-TS → fragmented MP4 transmuxing with `mux.js`
- Separate HLS audio-rendition handling
- Browser `downloads` API integration
- Optional native messaging host
- FFmpeg / FFprobe MP4 repair and audio merge
- Post-download loudness normalization when supported

</td>
</tr>
</table>

## Install

Crawlcast is currently set up to run as an unpacked extension during development.

### 1. Get the project

```bash
git clone https://github.com/austin-aegirtech/crawlcast-extension.git
cd crawlcast-extension
```

### 2. Load it in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose the root `crawlcast-extension` directory.
5. Pin **Crawlcast** to the toolbar if you want quick access.

There is no build step for the extension itself. The browser loads the source files directly.

### 3. Detect a stream

1. Open a page containing HLS video.
2. Start video playback so the page requests its media playlist.
3. Open Crawlcast.
4. Pick the detected stream and select **Download**.

If the page was already playing before Crawlcast was installed or reloaded, refresh the page and start playback again so the extension can observe the `.m3u8` request.

## Using Crawlcast

The popup is designed to show useful information without hiding the details developers need when something behaves unexpectedly.

A detected stream can include:

- **Title** — derived from the active page and reused as the MP4 filename.
- **Preview** — generated from the stream when browser media APIs can decode it.
- **Duration** — estimated from the playlist.
- **Resolution** — reported by the selected HLS variant when available.
- **Estimated size** — calculated before the full download when possible.
- **Host** — the origin serving the playlist.
- **Request type** — the browser request category that exposed the stream.
- **Progress** — downloaded segment count, size, completion, and repair state.

The bottom toolbar provides the existing Crawlcast actions for refreshing detected streams, opening diagnostic logs, and clearing the stream list.

## How it works

Crawlcast is split across several browser contexts because Manifest V3 service workers cannot perform every operation needed for media processing.

At a high level, a download moves through these stages:

**Detect → Inspect → Download segments → Transmux → Save MP4 → Repair (optional) → Complete**

| Stage | Primary files | Responsibility |
|---|---|---|
| Detect | `background.js` | Watches browser requests for `.m3u8` URLs and records detected streams. |
| Present | `popup.html`, `popup.js` | Displays streams, metadata, previews, progress, logs, and user controls. |
| Parse | `m3u8-parser.js` | Parses HLS master/media playlists and resolves variants, segments, and audio renditions. |
| Download | `downloader.js` | Fetches media segments, retries failures, tracks progress, and prepares output chunks. |
| Process | `offscreen.html`, `offscreen.js` | Hosts DOM APIs unavailable to the service worker and coordinates media/thumbnail work. |
| Transmux | `lib/mux.min.js` | Repackages supported MPEG-TS HLS media into MP4 fragments without a full video transcode. |
| Save | `background.js` | Sends the completed Blob through Chrome's Downloads API. |
| Repair | `native-host/crawlcast_host.py` | Optionally runs FFmpeg/FFprobe to repair the MP4, merge separate audio, and normalize audio. |

A full architecture flow chart and file-by-file execution map can be maintained separately from this customer-facing overview.

## Native MP4 repair

The browser pipeline produces fragmented MP4 output. That can work in some players, but a conventional finalized MP4 is usually a better file for seeking, libraries, media servers, and long-term storage.

Crawlcast therefore supports an **optional native messaging host**. After Chrome finishes saving the file, the host can:

- rebuild the MP4 container with FFmpeg;
- move MP4 metadata for fast startup where appropriate;
- merge a separately downloaded HLS audio rendition;
- verify the repaired output with FFprobe;
- apply audio loudness normalization when the source allows it.

Without the host, the download can still be saved, but Crawlcast reports **Saved, but not repaired** and the file may start slowly or have limited seeking in some players.

### Requirements

- Python 3
- `ffmpeg`
- `ffprobe`
- Chrome extension ID from `chrome://extensions`

Verify FFmpeg is available:

```bash
ffmpeg -version
ffprobe -version
```

### Windows / PowerShell

From the repository root:

```powershell
.\native-host\register-native-host.ps1 -ExtensionId YOUR_EXTENSION_ID
```

Then fully restart Chrome.

### Windows with WSL

From the repository root inside WSL:

```bash
chmod +x native-host/register-native-host-from-wsl.sh
./native-host/register-native-host-from-wsl.sh YOUR_EXTENSION_ID
```

Then fully restart Chrome.

> [!NOTE]
> The current native-host registration scripts are Windows-oriented. Do not assume the Windows registration path applies unchanged to native Chrome installations on macOS or Linux.

## Development

Crawlcast intentionally has a small development surface: vanilla JavaScript, browser APIs, and checked-in runtime dependencies.

### Repository layout

```text
crawlcast-extension/
├── manifest.json                 # Extension manifest and permissions
├── background.js                 # Service worker, detection, state, saves, native messaging
├── popup.html                    # Popup markup and styling
├── popup.js                      # Popup behavior and download UI state
├── offscreen.html                # Hidden DOM-capable extension document
├── offscreen.js                  # Download orchestration and thumbnail generation
├── m3u8-parser.js                # HLS playlist parsing
├── downloader.js                 # Segment fetching, transmux orchestration, audio handling
├── lib/
│   ├── mux.min.js                # HLS TS → MP4 transmuxing dependency
│   └── StreamSaver.min.js        # Checked-in library file
├── icons/                        # Extension icons and artwork
├── native-host/
│   ├── crawlcast_host.py         # FFmpeg/FFprobe native messaging host
│   ├── crawlcast_host.bat        # Windows launcher
│   ├── com.crawlcast.downloader.json
│   └── register-native-host*.{ps1,sh}
└── tools/
    ├── remux.sh                  # Standalone repair helper
    └── Repair-Videos.ps1         # Windows repair / scan helper
```

### Reloading changes

For extension-side changes:

1. Save your files.
2. Open `chrome://extensions`.
3. Select **Reload** on Crawlcast.
4. Refresh the page you are testing if the change affects detection.

The popup itself is recreated whenever it is closed and reopened, but the extension still needs to be reloaded when source files change.

### Useful debugging surfaces

- **Popup UI:** right-click the popup and inspect it.
- **Service worker:** `chrome://extensions` → Crawlcast → **Service worker**.
- **Crawlcast logs:** open **Logs** from the popup toolbar.
- **Native host:** test FFmpeg/FFprobe from the same Windows environment that launches the host.

## Permissions

Crawlcast currently requests the following extension permissions:

| Permission | Why it is used |
|---|---|
| `webRequest` | Observe requests so HLS playlists can be detected. |
| `storage` | Persist detected-stream state across Manifest V3 worker suspension. |
| `activeTab` | Scope the popup to the page the user is currently viewing and read its title. |
| `downloads` | Save completed media through the browser download manager. |
| `offscreen` | Run media work requiring DOM APIs that are unavailable to the service worker. |
| `nativeMessaging` | Communicate with the optional local MP4 repair host. |
| `<all_urls>` | Detect playlists and fetch media segments regardless of the host serving them. |

## Privacy

Crawlcast does not send usage telemetry, analytics events, stream URLs, or downloaded media to a Crawlcast metrics service.

The media download pipeline fetches the stream directly from its source and processes it locally in the browser/native host rather than uploading the video to a Crawlcast processing service.

## Current limitations

Crawlcast is under active development. The current implementation has a few important boundaries:

- **HLS-first:** detection is based on `.m3u8` requests. Other streaming protocols are outside the current pipeline.
- **Memory-backed downloads:** media is assembled in browser memory before saving. `downloader.js` currently guards in-browser downloads at approximately **1.5 GB**.
- **Native repair is optional but recommended:** without FFmpeg/native messaging, saved fragmented MP4 files may have poorer compatibility or seeking behavior.
- **Encrypted/DRM media:** Crawlcast is not a DRM bypass tool. Protected streams may not be downloadable or usable.
- **Separate audio:** some HLS masters provide audio independently from video. Crawlcast can fetch that rendition, but the native host is required to merge it into the final repaired MP4.
- **Metadata is best-effort:** preview, duration, resolution, and estimated size depend on what the playlist and browser expose.

## Troubleshooting

<details>
<summary><strong>No streams detected</strong></summary>

- Start playback before opening the popup.
- Refresh the page after installing or reloading the extension.
- Select **Refresh** in Crawlcast.
- Confirm the site is actually using HLS (`.m3u8`) rather than another delivery format.
- Check the Crawlcast log window and the extension service-worker console.

</details>

<details>
<summary><strong>Download says “Saved, but not repaired”</strong></summary>

The browser download finished, but Crawlcast could not complete the native FFmpeg repair stage.

Check that:

- the Crawlcast native host is registered for the current extension ID;
- Chrome was fully restarted after registration;
- `ffmpeg` and `ffprobe` are available;
- the native host manifest points to the correct launcher.

</details>

<details>
<summary><strong>The file downloads but seeking is poor</strong></summary>

That is the main case the native repair pass is intended to solve. Install/register the native host and confirm the popup reaches **Complete** after the **Repairing MP4 file** stage.

</details>

<details>
<summary><strong>The stream is too large</strong></summary>

The current browser pipeline buffers the media in memory and enforces an approximately 1.5 GB guard. Large-file handling is an area for future improvement rather than something the current README should hide.

</details>

## Roadmap

Some of the visible product direction is already represented in the UI, while implementation will land incrementally.

- [ ] Premium feature set and account flow
- [ ] Improved large-file handling / reduced browser-memory pressure
- [ ] Broader automated compatibility testing
- [ ] Stream naming and metadata improvements
- [ ] Expanded native-host installation support
- [ ] Store-ready packaging and release workflow

## Contributing

Issues and focused pull requests are welcome.

When changing the media pipeline, keep the browser contexts in mind: the service worker, popup, offscreen document, and native host communicate through explicit messages and do not share normal in-memory state.

For changes that affect downloads, test both paths:

1. browser download without native repair;
2. browser download followed by a successful native FFmpeg repair.

Repository: **[github.com/austin-aegirtech/crawlcast-extension](https://github.com/austin-aegirtech/crawlcast-extension)**

## Security & responsible use

Do not use Crawlcast to bypass access controls, DRM, authentication boundaries, or rights restrictions. If a site does not authorize downloading its media, the presence of an HLS request does not create that authorization.

If you discover a security issue in Crawlcast, avoid publishing sensitive exploit details in a public issue until the maintainer has had a chance to review them.

---

<div align="center">
  <strong>Crawlcast</strong><br>
  <sub>Find the stream. Build the file. Keep it local.</sub>
</div>
