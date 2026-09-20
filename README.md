<div align="center">
  <img src="./icons/icon128.png" alt="Crawlcast logo" width="104" height="104">

  # Crawlcast

  **Detect streams. Capture video. Save clean MP4 files.**

  Crawlcast is a Manifest V3 browser extension for detecting HLS streams and direct MP4 media, downloading them from the active page, and producing practical local video files with an optional native FFmpeg repair step.

  [![Version](https://img.shields.io/badge/version-0.1.0-0284c7?style=for-the-badge)](./manifest.json)
  [![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white)](./manifest.json)
  [![HLS](https://img.shields.io/badge/HLS-M3U8-0ea5e9?style=for-the-badge)](./m3u8-parser.js)
  [![MP4](https://img.shields.io/badge/Direct-MP4-8b5cf6?style=for-the-badge)](./background.js)
  [![FFmpeg](https://img.shields.io/badge/FFmpeg-fast%20repair-007808?style=for-the-badge&logo=ffmpeg&logoColor=white)](./native-host)
  [![JavaScript](https://img.shields.io/badge/JavaScript-Vanilla-F7DF1E?style=for-the-badge&logo=javascript&logoColor=111)](./background.js)

  [Features](#features) · [Install](#install) · [How it works](#how-it-works) · [Native MP4 repair](#native-mp4-repair) · [Development](#development) · [Limitations](#current-limitations)
</div>

---

## What is Crawlcast?

Video on the web is not always delivered as one simple file. Some sites expose a direct `.mp4`; others use HLS, where an `.m3u8` playlist points to many individual media segments.

Crawlcast handles both paths:

- **Direct MP4** — detected and handed directly to the browser download manager.
- **HLS / M3U8** — playlist parsed, segments downloaded, media assembled, then saved as MP4.

When the optional native host is installed, Crawlcast can also inspect the finished MP4 and repair its container structure with FFmpeg when necessary. Already-optimized direct MP4 files can skip the rewrite entirely.

> [!IMPORTANT]
> Crawlcast is a media transport and file-processing tool. Only download media that you own or are authorized to save. Website terms, copyright rules, authentication boundaries, DRM, and access restrictions still apply.

## Features

<table>
<tr>
<td width="50%" valign="top">

### For users

- Automatic `.m3u8` / HLS detection
- Automatic direct `.mp4` detection
- Active-tab stream cards
- `M3U8` and `MP4` format badges
- Real page titles for readable filenames
- Click-to-edit download titles
- Pencil control for explicit title editing
- Thumbnail previews for supported HLS streams
- Duration, resolution, host, request type, and estimated size where available
- Live download progress
- Cancel support for active downloads
- Clear **Complete** state after processing
- Floating diagnostic log window
- Clean dark UI with separate stylesheet

</td>
<td width="50%" valign="top">

### Under the hood

- Chrome Manifest V3 service worker
- Session-backed detected-stream state
- Direct MP4 downloads through `chrome.downloads`
- Offscreen document for HLS media work
- HLS master/media playlist parsing
- MPEG-TS → fragmented MP4 transmuxing with `mux.js`
- Separate HLS audio-rendition handling
- Optional native messaging host
- Fast MP4 structure inspection
- Lossless FFmpeg stream-copy repair
- `+faststart` MP4 finalization
- Duration verification with FFprobe

</td>
</tr>
</table>

## Free mode & Premium

Crawlcast currently includes the product scaffolding for a free and Premium experience.

### User Mode

**User Mode is the default.** It allows one accepted download start per rolling 60-minute window.

When the limit is reached:

- download controls are disabled;
- the Premium card displays a purple live countdown;
- the countdown shows exactly when the next free download becomes available;
- controls automatically become available again when the timer reaches zero.

### Premium

The Premium card is already present in the UI, but billing and account entitlements are **not connected yet**. The current **Get Premium** action is a coming-soon stub.

A development-only **God Mode** toggle currently exists for unrestricted testing. It is intended as a development convenience, not the final production entitlement system.

## Install

Crawlcast is currently run as an unpacked extension during development.

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
5. Pin **Crawlcast** to the toolbar if desired.

There is currently no frontend build step. Chrome loads the extension source directly.

### 3. Detect media

1. Open a page containing video.
2. Start playback so the page requests its media.
3. Open Crawlcast.
4. Select a detected stream.
5. Edit the title if desired.
6. Select **Download**.

If media playback started before Crawlcast was installed or reloaded, refresh the webpage and start playback again so the extension can observe the request.

## Using Crawlcast

Each detected stream is shown as a card containing the information Crawlcast was able to determine.

Depending on the source, a card may include:

- **Format** — `M3U8` or `MP4`.
- **Title** — derived from the active page, editable before download, and reused for the filename.
- **Preview** — generated when the HLS stream can be analyzed by browser media APIs.
- **Duration** — derived from available playlist/media metadata.
- **Resolution** — reported by the selected HLS variant where available.
- **Estimated size** — calculated when the source exposes enough information.
- **Host** — the origin serving the media.
- **Request type** — the browser request category that exposed the media.
- **Progress** — download state, bytes/segments, processing stage, and completion state.

### Editing a filename

Before downloading, either:

- click the title itself; or
- click the pencil icon beside it.

Then:

- **Enter** saves the title;
- clicking away also saves it;
- **Esc** cancels the edit.

The saved title is sanitized before being used as an `.mp4` filename.

### Popup controls

The bottom toolbar currently contains:

- **Logs** — opens the floating diagnostic log window;
- **Clear** — clears detected streams that are safe to remove.

The Premium panel can also be dismissed with its close button.

## How it works

Crawlcast uses separate pipelines for HLS and direct MP4 media.

```text
Browser media request
        │
        ▼
  background.js
        │
        ├─────────────── .mp4 ─────────────────┐
        │                                       │
        │                                       ▼
        │                               chrome.downloads
        │                                       │
        │                                       ▼
        │                               Native inspection
        │                                  (optional)
        │                                  │       │
        │                          healthy │       │ needs repair
        │                                  ▼       ▼
        │                              Complete   FFmpeg
        │                                           │
        │                                           ▼
        │                                        Complete
        │
        └────────────── .m3u8 ────────────────┐
                                              ▼
                                      offscreen.js
                                              │
                                              ▼
                                      m3u8-parser.js
                                              │
                                              ▼
                                       downloader.js
                                              │
                                              ▼
                                         mux.js
                                              │
                                              ▼
                                     Fragmented MP4
                                              │
                                              ▼
                                      chrome.downloads
                                              │
                                              ▼
                                        FFmpeg repair
                                          (optional)
                                              │
                                              ▼
                                           Complete
```

### Runtime responsibilities

| Stage | Primary files | Responsibility |
|---|---|---|
| Detect | `background.js` | Watches browser requests, identifies HLS/direct MP4 media, stores stream state, enforces User Mode rate limiting, and coordinates downloads. |
| Present | `popup.html`, `styles/popup.css`, `popup.js` | Renders stream cards, editable titles, Premium UI, countdowns, progress, floating logs, and controls. |
| Parse HLS | `m3u8-parser.js` | Parses HLS master/media playlists and resolves variants, segments, and separate audio renditions. |
| Download HLS | `downloader.js` | Fetches HLS media segments, retries failures, reports progress, and prepares output chunks. |
| Offscreen work | `offscreen.html`, `offscreen.js` | Provides DOM-capable media processing unavailable to the MV3 service worker and coordinates HLS downloads/previews. |
| Transmux | `lib/mux.min.js` | Repackages supported MPEG-TS HLS media into fragmented MP4 without a full video transcode. |
| Download MP4 | `background.js` | Sends direct MP4 URLs straight to Chrome's Downloads API and tracks byte progress/cancellation. |
| Save | `background.js` | Saves assembled HLS output through Chrome's Downloads API and tracks final browser completion. |
| Inspect / repair | `native-host/crawlcast_host.py` | Inspects direct MP4 structure, skips healthy files, or performs a lossless FFmpeg stream-copy repair when required. |

## Native MP4 repair

Crawlcast supports an optional Chrome native messaging host for final MP4 inspection and repair.

### Why it exists

The in-browser HLS pipeline produces fragmented MP4 output. Some players can open those files directly, but conventional finalized MP4 files are generally better for:

- seeking;
- media libraries;
- Jellyfin/Plex-style servers;
- playback startup;
- compatibility with other tools.

Direct MP4 files are different: many are already properly indexed and optimized. Crawlcast therefore avoids rewriting a healthy direct MP4 when it can.

### Current repair behavior

For **direct MP4** downloads, the native host:

1. inspects MP4 box headers;
2. checks for fragmentation (`moof`);
3. verifies that `moov` metadata exists and is positioned before media data;
4. skips FFmpeg when the file is already optimized;
5. otherwise repairs it with a stream-copy remux.

For **HLS-generated MP4** files, Crawlcast performs the final stream-copy repair because the browser pipeline intentionally produces fragmented MP4 output.

The repair command is designed around the equivalent of:

```bash
ffmpeg -i input.mp4 -c copy -movflags +faststart output.mp4
```

No normal video/audio re-encoding is performed during this repair, so it is primarily limited by disk I/O rather than codec speed.

If an HLS master supplied a separate audio rendition, the native host can merge that audio with the downloaded video during the same FFmpeg stream-copy pass.

FFprobe is used afterward to sanity-check output duration before the repaired file replaces the original.

> [!NOTE]
> Without the native host, Crawlcast can still save the browser download, but it cannot perform the local MP4 inspection/repair step or merge a separate HLS audio track.

### Requirements

- Python 3
- `ffmpeg`
- `ffprobe`
- The current extension ID from `chrome://extensions`

Verify the tools are available:

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
> The current registration tooling is primarily Windows-oriented. Do not assume the same registration path applies unchanged to native Chrome installations on macOS or Linux.

## Development

Crawlcast intentionally keeps the browser extension side lightweight: vanilla JavaScript, browser APIs, and checked-in runtime dependencies.

### Repository layout

```text
crawlcast-extension/
├── manifest.json                 # Manifest V3 metadata and permissions
├── background.js                 # Detection, rate limit, direct MP4, saves, native messaging
├── popup.html                    # Popup structure
├── popup.js                      # Popup behavior and UI state
├── styles/
│   └── popup.css                 # Popup styling
├── offscreen.html                # Hidden DOM-capable extension document
├── offscreen.js                  # HLS orchestration and thumbnail generation
├── m3u8-parser.js                # HLS playlist parsing
├── downloader.js                 # HLS segment fetching and transmux orchestration
├── lib/
│   └── mux.min.js                # HLS TS → MP4 transmux dependency
├── icons/                        # Extension icons and artwork
├── native-host/
│   ├── crawlcast_host.py         # MP4 inspection + FFmpeg/FFprobe repair host
│   ├── crawlcast_host.bat        # Windows launcher
│   ├── com.crawlcast.downloader.json
│   └── register-native-host*.{ps1,sh}
└── tools/
    ├── remux.sh                  # Standalone remux helper
    └── Repair-Videos.ps1         # Windows video repair/scan helper
```

### User Mode and God Mode

Rate-limit state is stored in `chrome.storage.local` so it survives popup closes and browser restarts.

- `user` is the default mode.
- User Mode permits one accepted download start every 60 minutes.
- The free slot is consumed as soon as the background service worker accepts the download.
- The popup calculates the remaining cooldown from the stored next-allowed timestamp.
- `god` bypasses the cooldown and currently exists for development/testing.

### Reloading changes

For extension-side changes:

1. Save the files.
2. Open `chrome://extensions`.
3. Select **Reload** on Crawlcast.
4. Refresh the test webpage when the change affects request detection.

The popup itself is recreated whenever it closes and reopens, but extension source changes still require a reload.

### Useful debugging surfaces

- **Popup UI:** right-click the popup and inspect it.
- **Service worker:** `chrome://extensions` → Crawlcast → **Service worker**.
- **Crawlcast logs:** select **Logs** in the bottom toolbar.
- **Native host:** test `ffmpeg` and `ffprobe` from the same Windows environment that launches the host.

## Permissions

Crawlcast currently requests:

| Permission | Why it is used |
|---|---|
| `webRequest` | Observe browser media requests so HLS playlists and direct MP4 URLs can be detected. |
| `storage` | Preserve detected-stream/session state and User Mode rate-limit state. |
| `activeTab` | Scope the popup to the active page and use its title for stream labels/filenames. |
| `downloads` | Save assembled HLS files and direct MP4 media through the browser download manager. |
| `offscreen` | Run HLS media work that requires DOM-capable APIs unavailable to the MV3 service worker. |
| `nativeMessaging` | Communicate with the optional local MP4 inspection/repair host. |
| `<all_urls>` | Detect and fetch media regardless of the host serving the video. |

## Privacy

Crawlcast's media processing is local-first:

- direct MP4 downloads are handled by the browser;
- HLS media is fetched from its source and assembled locally;
- optional MP4 inspection/repair runs on the user's machine through the native host;
- downloaded video is not uploaded to a Crawlcast media-processing service.

Any future account, Premium, or payment functionality should be documented here before a public store release.

## Current limitations

Crawlcast is under active development.

- **Supported detection:** current media detection targets HLS (`.m3u8`) and direct MP4 (`.mp4`) requests. Other delivery protocols are outside the current pipeline.
- **HLS memory limit:** HLS media is currently assembled in browser memory. `downloader.js` guards this path at approximately **1.5 GB**. Direct MP4 downloads use Chrome's normal download manager instead of that HLS memory buffer.
- **Native repair:** direct MP4 files can be downloaded without the native host, but local structure inspection/repair requires it. HLS output has the best compatibility after final repair.
- **Separate HLS audio:** a native host is required to merge separately delivered audio into the final MP4.
- **Metadata is best-effort:** thumbnails, resolution, duration, and estimated size depend on what the source exposes.
- **DRM/encrypted media:** Crawlcast is not a DRM bypass tool and does not promise support for protected streams.
- **Premium:** the UI exists, but payment, account, and entitlement services are not yet connected.

## Troubleshooting

<details>
<summary><strong>No media detected</strong></summary>

- Start video playback so the page actually requests its media.
- Refresh the webpage after installing/reloading Crawlcast.
- Confirm the source is using HLS (`.m3u8`) or a direct `.mp4` request.
- Open the floating Crawlcast **Logs** window.
- Inspect the extension service-worker console from `chrome://extensions`.

</details>

<details>
<summary><strong>User Mode says the free limit was reached</strong></summary>

User Mode permits one accepted download every rolling 60 minutes. The purple timer under the Premium features section shows the remaining cooldown and updates automatically.

God Mode currently bypasses this restriction for development/testing.

</details>

<details>
<summary><strong>Download says “Saved, but not repaired”</strong></summary>

The browser download completed, but Crawlcast could not finish the native inspection/repair stage.

Check that:

- the native host is registered for the current extension ID;
- Chrome was fully restarted after host registration;
- `ffmpeg` and `ffprobe` are available;
- the native-host manifest points to the correct launcher.

</details>

<details>
<summary><strong>“Repairing MP4 file” takes too long</strong></summary>

The current repair path uses FFmpeg stream copy rather than a full video/audio transcode. Direct MP4s are inspected first and skip the rewrite entirely when already optimized.

For files that genuinely need repair, runtime is primarily influenced by file size and disk I/O speed.

</details>

<details>
<summary><strong>An HLS stream is too large</strong></summary>

The HLS pipeline currently buffers assembled media in browser memory and enforces an approximately 1.5 GB guard. Direct MP4 files do not use this same HLS memory path.

</details>

## Roadmap

- [ ] Connect Premium billing and account entitlements
- [ ] Remove the development God Mode control from production builds
- [ ] Build the production Premium feature set
- [ ] Improve large HLS download handling / reduce browser-memory pressure
- [ ] Add broader compatibility and regression testing
- [ ] Expand native-host installation support
- [ ] Produce Chrome Web Store release packaging and listing assets
- [ ] Add automated release/version workflow

## Contributing

Issues and focused pull requests are welcome.

When changing Crawlcast, keep the runtime boundaries in mind: the service worker, popup, offscreen document, browser downloads API, and native host communicate through explicit messages and do not share ordinary in-memory state.

For download-related changes, test both media paths:

1. direct `.mp4` download;
2. HLS `.m3u8` download and assembly.

When native-host behavior changes, also test:

1. an already-optimized direct MP4 that should skip repair;
2. an MP4 with `moov` metadata after media data;
3. a fragmented MP4 that requires repair;
4. HLS with separate audio when available.

Repository: **[github.com/austin-aegirtech/crawlcast-extension](https://github.com/austin-aegirtech/crawlcast-extension)**

## Security & responsible use

Do not use Crawlcast to bypass access controls, DRM, authentication boundaries, or rights restrictions. A detectable media request does not itself grant permission to download or redistribute that media.

If you discover a security issue in Crawlcast, avoid publishing sensitive exploit details in a public issue before the maintainer has had a chance to review them.

---

<div align="center">
  <strong>Crawlcast</strong><br>
  <sub>Stream. Capture. Download.</sub>
</div>
