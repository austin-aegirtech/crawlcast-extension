# Crawlcast — Technical Documentation

> **Running document.** Update the [Change Log](#14-change-log) whenever behaviour
> changes, and keep [Known Limitations](#12-known-limitations--trade-offs) honest.
> Last updated: 2026-08-04 · Extension version 1.0.0 (Himitsu)

---

## Table of Contents

1. [What This Is](#1-what-this-is)
2. [High-Level Architecture](#2-high-level-architecture)
3. [Why It's Built This Way](#3-why-its-built-this-way)
4. [File Map](#4-file-map)
5. [Stream Detection](#5-stream-detection)
6. [The Download Pipeline](#6-the-download-pipeline)
7. [MP4 Container Internals](#7-mp4-container-internals)
8. [Thumbnails & Previews](#8-thumbnails--previews)
9. [The Native Host](#9-the-native-host)
11. [Message Protocol Reference](#11-message-protocol-reference)
12. [Known Limitations & Trade-offs](#12-known-limitations--trade-offs)
13. [Testing Notes](#13-testing-notes)
14. [Change Log](#14-change-log)
15. [Future Work](#15-future-work)

---

## 1. What This Is

Crawlcast is a Chrome extension (Manifest V3) that detects **HLS video streams**
on any web page and converts them into playable MP4 files entirely inside the
browser — no server, no upload, no external service.

HLS (HTTP Live Streaming) doesn't ship a video as one file. It ships a *playlist*
(`.m3u8`) listing hundreds or thousands of small `.ts` chunks, which the player
fetches and stitches together on the fly. To produce a downloadable file you have
to do the same work the player does, plus repackage the result into a container
that offline players understand.

The extension does five distinct jobs:

| Job | Where it runs |
|---|---|
| Notice `.m3u8` requests as pages load | Service worker |
| Estimate size + generate animated previews | Offscreen document |
| Download + transmux segments into an MP4 | Offscreen document |
| Repair the saved file so it seeks properly | Native messaging host |
| Hand large/unsupported videos to an external tool | Native messaging host |

tracks usage across installs.

Only the first three are self-contained. The native host requires a one-time
local install; without it, downloads still work but stay fragmented.

---

## 2. High-Level Architecture

MV3 extensions are split across several isolated JavaScript contexts that cannot
call each other directly; everything happens by message passing.

```
┌─────────────────┐                         ┌──────────────────────┐
│     popup.js    │  getStreams             │    background.js     │
│  (popup.html)   │ ──────────────────────► │  (service worker)    │
│                 │ ◄────────────────────── │                      │
│  • stream list  │  streams + downloading   │  • webRequest hook   │
│  • thumbnails   │                          │  • stream registry   │
│  • progress UI  │  downloadProgress        │  • message broker    │
│  • external box │ ◄────────────────────── │  • chrome.downloads  │
└─────────────────┘                          └──────────┬───────────┘
                                                        │
                            ┌───────────────────────────┼─────────────────┐
                            │ downloadStream            │ connectNative   │
                            ▼                           ▼                 │
                 ┌─────────────────────┐    ┌───────────────────────┐     │
                 │    offscreen.js     │    │  crawlcast_host.py     │     │
                 │  (offscreen.html)   │    │  (native host)        │     │
                 │                     │    │                       │     │
                 │  • VideoDownloader  │    │  • spawns yt-dlp      │     │
                 │  • M3U8Parser       │    │  • runs ffmpeg remux  │     │
                 │  • mux.js transmux  │    │  • relays progress    │     │
                 │  • <video>+<canvas> │    └───────────────────────┘     │
                 │  • Blob assembly    │ ── saveBlob ─────────────────────┘
                 └─────────────────────┘
```

The full lifecycle of one HLS download touches every context:

```
detect (worker) → list (popup) → analyze: size + preview (offscreen)
   → download + transmux (offscreen) → save (worker, chrome.downloads)
      → remux (native host) → "Saved and repaired" (popup)
```

### The four contexts and why each exists

**Popup** (`popup.html` + `popup.js`) — the UI. Destroyed every time it closes,
so it holds no authoritative state; it re-queries the service worker on open.

**Service worker** (`background.js`) — the only context that can use
`chrome.webRequest` and `chrome.downloads`. Owns the stream registry and brokers
every message. Chrome suspends it after ~30 s idle, so its memory is *not*
durable — see [§5](#5-stream-detection).

**Offscreen document** (`offscreen.html` + `offscreen.js`) — a hidden page that
exists purely to provide DOM APIs the service worker lacks: `Blob`,
`URL.createObjectURL`, `<video>`, `<canvas>`. All heavy lifting happens here.
Created on demand, destroyed when idle.

**Native host** (`crawlcast_host.py`) — a local process outside the browser
entirely, reached over stdio. Handles cases the in-browser pipeline can't.

---

## 3. Why It's Built This Way

Three constraints drove nearly every architectural decision.

**A service worker has no DOM.** The original code called
`streamSaver.createWriteStream()` from `background.js`. StreamSaver builds hidden
`<iframe>`s to stream data to disk — impossible without a document. That is why
the offscreen document exists. The same constraint rules out `<video>`/`<canvas>`
thumbnail capture in the worker.

**A service worker is not durable.** Chrome terminates it after roughly 30 s of
inactivity and restarts it on the next event, with all module-level state reset.
An in-memory `Map` of detected streams silently empties. Hence
`chrome.storage.session` persistence.

**Everything is buffered in memory.** Without streaming-to-disk, the whole video
accumulates as `Uint8Array` chunks and is then copied into a `Blob` — peak usage
roughly 2× the video size inside a single renderer process. This is the hard
ceiling that motivates both the size guard and the external bridge.

---

## 4. File Map

Line counts as of v1.0.0 (Himitsu).

**Extension core**

| File | Lines | Role |
|---|---:|---|
| `manifest.json` | 36 | Permissions, entry points |
| `background.js` | 517 | Service worker: detection, registry, message broker, remux trigger |
| `popup.html` | 361 | UI markup + all CSS |
| `popup.js` | 456 | UI logic, rendering, hover animation |
| `offscreen.js` | 291 | Download orchestration, thumbnail generation |
| `offscreen.html` | 12 | Loads mux.js, parser, downloader, glue |
| `downloader.js` | 476 | `VideoDownloader` — fetch, transmux, assemble |
| `m3u8-parser.js` | 196 | `M3U8Parser` — playlist parsing |
| `lib/mux.min.js` | — | mux.js 7.1.0 (TS→MP4 transmuxer) |


**Companion components** (all optional — the extension works without them)

| File | Lines | Role |
|---|---:|---|
| `native-host/crawlcast_host.py` | 285 | Native host: external downloads **and** post-download remux |
| `native-host/crawlcast_host.bat` | 5 | Windows launcher (Chrome can't exec `.py`) |
| `native-host/com.crawlcast.downloader.json` | 9 | Native host manifest |
| `tools/remux.sh` | 252 | Batch-repair existing files (bash) |
| `tools/Repair-Videos.ps1` | 320 | Batch-repair + damage scan (PowerShell) |
| `PROJECT.md` | — | This document |

### Permissions and why each is needed

| Permission | Reason |
|---|---|
| `webRequest` | Observe network requests to spot `.m3u8` URLs |
| `storage` | `storage.session` for streams; `storage.local` for install ID |
| `activeTab` | Resolve the current tab so streams are scoped per-tab |
| `downloads` | Save the finished Blob to disk |
| `offscreen` | Create the hidden document that hosts the pipeline |
| `nativeMessaging` | Talk to the local downloader bridge |
| `<all_urls>` | Streams can live on any host; segments too |

---

## 5. Stream Detection

### High level

The service worker watches every network request the browser makes. Any URL
ending in `.m3u8` (optionally followed by a query string) is recorded against the
tab that requested it, the toolbar badge updates, and the popup can list it.

### Low level

```js
const M3U8_PATTERN = /\.m3u8($|\?)/i;

chrome.webRequest.onBeforeRequest.addListener(
  (details) => { /* record details.url, details.tabId, details.type */ },
  { urls: ["<all_urls>"] },
  ["requestBody"]
);
```

Each entry is `{ url, timestamp, tabId, type, initiator, title }`. The registry
is capped at 50 entries (oldest evicted first) to bound memory.

### Surviving worker suspension

Because the worker's memory resets, every mutation is mirrored to
`chrome.storage.session`:

```js
const streamsRestored = chrome.storage.session.get('detectedStreams').then(...)
```

`streamsRestored` is a promise created at module load. Every handler that reads
the registry awaits it first, guaranteeing restoration has completed before a
response is sent. `storage.session` is the right store here: it survives worker
restarts but clears when the browser closes, so stale streams don't accumulate
forever.

> **Gotcha we hit:** requests made by a *site's own* service worker report
> `tabId: -1` and get filtered out of the per-tab view. If a stream is detected
> in the worker console but never appears in the popup, this is why.

### What this cannot detect

Only literal `.m3u8` URLs. Not DASH (`.mpd`), not progressive MP4, not blob/MSE
sources, not DRM-protected streams, and not YouTube VOD — see
[§12](#12-known-limitations--trade-offs).

---

## 6. The Download Pipeline

### High level

Pick the best-quality variant → download every segment → convert each from
MPEG-TS to MP4 fragments → concatenate → patch the header → save.

### Step by step

```
popup: startDownload
  → background: ensureOffscreenDocument(), register in activeDownloads
    → offscreen: new VideoDownloader().download(url, filename)
       1. fetchPlaylist(m3u8Url)          → M3U8Parser.parse()
       2. if master → selectBestVariant() → fetchPlaylist(variant.url)
       2b. estimateSize() → abort if > memoryLimitBytes
       3. initializeTransmuxer()          → muxjs.mp4.Transmuxer
       4. chunks[] + writer shim
       5. downloadSegments()              → sliding window, ordered writes
       6. patchInitSegmentDuration() → new Blob(chunks)
    → background: chrome.downloads.download(blobUrl)
       → revoke blob URL on completion → maybeCloseOffscreen()
```

### 6.1 Playlist parsing (`m3u8-parser.js`)

An `.m3u8` file is line-based. Two kinds matter:

**Master playlist** — lists quality variants:
```
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1920x1080
1080p/index.m3u8
```

**Media playlist** — lists actual segments:
```
#EXTINF:4.000,
segment0001.ts
```

The parser walks lines, tracking whether the previous line was an `#EXT-X-STREAM-INF`
(→ next non-comment line is a variant URL) or an `#EXTINF` (→ next non-comment
line is a segment URL). `resolveUrl()` handles absolute, protocol-relative,
root-relative, and relative paths against the playlist's own URL.

> **Bug fixed here:** the master-variant branch ran before the segment branch and
> didn't check `currentVariant !== null`, so parsing a *media* playlist crashed
> with `Cannot set properties of null (setting 'url')`. This was the original
> "download does nothing" failure.

### 6.2 Segment fetching — parallel fetch, ordered processing

The naive approaches both fail:

- Fully serial → network idles during transmuxing; very slow.
- Fully parallel → segments reach the shared transmuxer out of order, producing
  interleaved, corrupt MP4 fragments.

The solution decouples the two phases. A **sliding window** of up to
`concurrency` (4) fetches runs ahead, while consumption is strictly sequential:

```js
for (let i = 0; i < segments.length; i++) {
  // top up the window
  for (let j = i; j < Math.min(i + this.concurrency, segments.length); j++) {
    if (!pending.has(j)) pending.set(j, this.fetchSegmentWithRetry(segments[j], j));
  }
  const arrayBuffer = await pending.get(i);   // consume in playlist order
  pending.delete(i);
  if (arrayBuffer === null) continue;          // failed → skip, keep going
  ...transmux, write...
}
```

Fetching is the slow part, so this recovers most of the parallel speedup with
none of the ordering risk.

**Retry and timeout.** `fetchSegmentWithRetry` makes up to 20 attempts with
linear backoff (`1000ms × attempt` — 1 s, 2 s, 3 s, ... up to 20 s). Each
attempt gets its own 30 s timeout, combined with the user-cancel signal via
`AbortSignal.any()`:

```js
const timeoutController = new AbortController();
const timer = setTimeout(() => timeoutController.abort(), this.segmentTimeoutMs);
const signal = AbortSignal.any([this.abortController.signal, timeoutController.signal]);
```

> **Why this matters:** without a timeout, a server that accepts the connection
> but never responds leaves `await fetch()` pending forever. It never rejects, so
> retry never fires, and the entire download freezes silently. This is exactly
> what stalled a real download at segment 4127/4130 for 21 minutes.

### 6.3 Transmuxing (TS → MP4)

HLS segments are usually MPEG-TS — a broadcast format with 188-byte packets,
detected by sync byte `0x47` at offsets 0 and 188:

```js
isTransportStream(buffer) {
  const view = new Uint8Array(buffer);
  return view[0] === 0x47 && view[188] === 0x47;
}
```

TS is not playable by consumer players, so each segment is **transmuxed** — the
audio/video elementary streams are re-wrapped into MP4 boxes without re-encoding.
No quality loss, and it's fast (no decode/encode cycle). `mux.js` does the work;
`transmuxSegment()` wraps its event-based API in a promise, attaching one-shot
`data`/`done` handlers per segment and concatenating the output.

The first segment additionally emits an **init segment** (`ftyp` + `moov`) which
must be written before any media data.

### 6.4 Assembly and saving

Transmuxed fragments accumulate in a `chunks[]` array behind a minimal writer
shim (a leftover seam from the StreamSaver design — kept because it keeps
`downloadSegments()` agnostic about the destination). At the end:

1. `patchInitSegmentDuration(chunks[0], totalDuration)` — see [§7](#7-mp4-container-internals)
2. `new Blob(chunks, { type: 'video/mp4' })`
3. `chunks.length = 0` — release the duplicate buffers
4. Offscreen creates a blob URL and posts `saveBlob` to the background
5. Background calls `chrome.downloads.download()` (offscreen documents can't)
6. On `downloads.onChanged` complete/interrupted → tell offscreen to
   `URL.revokeObjectURL()` → `maybeCloseOffscreen()`

### 6.5 Size guard

Before downloading, `estimateSize()` computes `bandwidth / 8 × duration` (or a
per-segment average when there's no master playlist). Above
`memoryLimitBytes` (1.5 GB) the download is refused with a `tooLarge` error, and
the popup offers a one-click handoff to the external downloader.

### 6.6 Cancellation and stall recovery

- Each `VideoDownloader` holds an `AbortController`; `cancel()` aborts it.
- Offscreen keeps `runningDownloads: Map<url, VideoDownloader>` so cancel
  requests can reach the right instance.
- Background *also* removes its own tracking immediately, so a crashed offscreen
  document can never permanently lock the UI.
- Background records `lastProgressAt` on every progress message. **Clear**
  force-releases any download with no progress for `STALE_DOWNLOAD_MS` (2 min).

---

## 7. MP4 Container Internals

This section explains the single most consequential design constraint in the
project. It is worth understanding in full.

### Two kinds of MP4

**Regular (progressive) MP4:**
```
ftyp | moov (complete sample tables) | mdat (all media data)
```
The `moov` box contains `stts`, `stsc`, `stsz`, `stco` — a full index mapping
every sample to a timestamp and byte offset. A player reads a few KB of header
and instantly knows the duration and how to seek anywhere.

**Fragmented MP4 (what mux.js produces):**
```
ftyp | moov (EMPTY sample tables + mvex) | moof|mdat | moof|mdat | moof|mdat | ...
```
The sample tables are hollow *by design*. Timing lives inside each `moof` header,
scattered throughout the file. This format exists for streaming, where you can't
know the whole timeline up front.

### The three symptoms this caused

All from one root cause — **no index**:

1. **Seeking snapped back to zero.** No table maps a timestamp to a byte offset,
   and `mvhd` declared duration 0, so players couldn't compute a target.
2. **Plex mobile wouldn't play.** Direct Play worked on desktop, but mobile
   forced a transcode, and the ffmpeg transcoder needs to seek through the file.
3. **Very slow startup everywhere.** With no `sidx` (segment index) and no `mfra`
   (fragment random-access box), a player must parse *every* `moof` in the file
   before it can build a timeline. 4130 fragments = a full-file scan before frame one.

### The partial fix we implemented

`patchInitSegmentDuration()` walks the init segment's box tree and writes the
real duration (summed from `#EXTINF` values) into three places, each in its own
timescale:

| Box | Field offset (v0) | Timescale |
|---|---|---|
| `mvhd` | `+20` timescale, `+24` duration | movie |
| `tkhd` | `+28` duration | movie |
| `mdhd` | `+20` timescale, `+24` duration | track-local |

Box layout is `[4 bytes size][4 bytes type][payload]`, and `moov`/`trak`/`mdia`
are containers that must be recursed into. The walker skips `moof`/`mdat`.

Paired with `keepOriginalTimestamps: false` (rebasing the timeline to start at
t=0 instead of preserving the stream's original PTS), this fixed the seek bar and
seeking in mainstream players.

### What it does *not* fix

The sample tables are still empty and there is still no `sidx`/`mfra`. Startup
scanning and transcoder unhappiness remain. The complete fix is a remux:

```bash
ffmpeg -i video.mp4 -c copy -movflags +faststart fixed.mp4
```

`-c copy` rebuilds real sample tables from the fragments without re-encoding;
`+faststart` places `moov` at the front. Fast, lossless, and produces a normal
seekable MP4.

**As of v1.1.1 this runs automatically** after every download when the native
host and ffmpeg are available — see [§9.3](#93-post-download-remux). The
verifiable difference is `moof` count: a repaired file contains **zero** `moof`
boxes, proving it has genuine sample tables rather than a patched header.

When the host is unavailable the file stays fragmented and the popup says so.
`tools/remux.sh` repairs such files afterwards in bulk.

---

## 8. Thumbnails & Previews

### High level

Each stream card shows an animated preview: 8 frames sampled across the whole
video, cycling on hover. Generated lazily on first popup open, then cached.

### Low level

Triggered when the popup finds streams lacking `thumbnail` or `meta`:

```
popup: generateThumbnails(urls)
  → background: dedupe via thumbnailJobs Set, ensureOffscreenDocument()
    → offscreen: generateThumbnail(url) per stream
```

Inside `generateThumbnail()`:

1. Fetch the master playlist. Sort variants by bandwidth.
   - **Lowest** variant → used for frame sampling (cheapest to download)
   - **Highest** variant → used for size estimation (that's what a download grabs)
2. Fetch the chosen media playlist; sum `#EXTINF` for duration.
3. Emit `streamMeta` immediately — size appears in the UI well before frames do.
4. Choose 8 segment indices evenly spread across the playlist:
   ```js
   Math.round(i * (segments.length - 1) / (frameCount - 1))
   ```
   For 100 segments this yields `0, 14, 28, 42, 57, 71, 85, 99` — a scrub across
   the entire video rather than the first few seconds.
5. For each: fetch → transmux standalone (fresh transmuxer, since these segments
   are non-contiguous) → blob URL → `<video>` → seek to midpoint → `<canvas>`
   → 320 px JPEG at quality 0.6.
6. Emit `thumbnailReady` with all frames.

Frames and metadata are cached on the stream record in `storage.session`.
`thumbnailTried`/`metaTried` flags prevent retrying permanent failures (DRM,
audio-only) on every popup open.

**Hover animation** is pure JS in the popup: `mouseenter` starts a
`setInterval` at `FRAME_INTERVAL_MS` (600 ms) cycling `img.src`; `mouseleave`
clears it and restores frame 0. CSS adds a 1.5× scale and shadow on hover.

---

## 9. The Native Host

One local process, reached over stdio, doing two unrelated jobs: downloading
things the browser pipeline can't, and repairing files it produced.

Both are **optional**. Without the host the extension still detects streams,
downloads HLS, and generates thumbnails — it just can't fetch non-HLS sources
and leaves output fragmented.

### 9.1 Protocol

Chrome native messaging: stdio, each message framed as a 4-byte little-endian
length prefix followed by UTF-8 JSON.

```
extension ──► {"url": "...", "outdir": "..."}            # download
extension ──► {"action": "remux", "path": "C:/.../v.mp4"} # repair

extension ◄── {"type": "progress", "percent": 12.3, "line": "..."}
extension ◄── {"type": "done", "filename": "..."}
extension ◄── {"type": "remuxed", "path": "...", "bytes": 123}
extension ◄── {"type": "remuxSkipped", "message": "..."}
extension ◄── {"type": "error", "message": "..."}
```

Binaries are configurable by environment variable, so nothing is hardcoded:
`CRAWLCAST_DL_BIN` (default `yt-dlp`), `CRAWLCAST_FFMPEG_BIN` (`ffmpeg`),
`CRAWLCAST_FFPROBE_BIN` (`ffprobe`).

### 9.2 External downloads

The in-browser pipeline handles HLS only, up to ~1.5 GB. Anything else routes
here. The host spawns the configured downloader with
`--newline --no-colors --progress`, parses progress lines by regex, and relays
them. It keeps the last 10 output lines for error reporting and uses
`CREATE_NO_WINDOW` on Windows to avoid a console flash.

**Scope boundary (important for the writeup):** the extension contains no
site-specific extraction logic. The bridge is a generic pipe — URL in, progress
out. Whatever the external binary supports is what the bridge supports. Any
capability beyond HLS comes from that external tool, not from this codebase.

### 9.3 Post-download remux

The in-browser pipeline emits fragmented MP4 ([§7](#7-mp4-container-internals)).
This step repairs it automatically:

```
downloads.onChanged (state=complete)
  → downloads.search({id}) → item.filename (absolute local path)
    → connectNative → {"action":"remux", path}
      → ffmpeg -nostdin -v error -y -i PATH -c copy -movflags +faststart TMP
        → verify → os.replace(TMP, PATH)
          → {"type":"remuxed"} → popup shows "Saved and repaired"
```

Three details that matter:

**Staged, never in place.** ffmpeg cannot read and write the same path, so
output goes to `<name>.remux.tmp<ext>` and is swapped with `os.replace()` only
after verification. An interrupted or failed run cannot damage the original.

**Verified by duration, not size.** A first implementation compared file sizes
and wrongly rejected every `.ts` input, because MPEG-TS carries such heavy
188-byte-packet overhead that a *correct* lossless remux can halve the file.
`ffprobe` durations within 1% is the right test — it detects truncation without
false failures.

**Non-fatal by design.** Missing host, missing ffmpeg, or an unreadable file all
produce `remuxSkipped`, and the popup shows an amber note explaining the
playback consequences. The download itself is never reported as failed.

### 9.4 Installation

Requires a host manifest registered with Chrome (registry key on Windows, a JSON
file in a specific directory on macOS/Linux), whose `allowed_origins` must
contain the exact extension ID. **Chrome must be fully restarted** afterwards —
registration is read at startup. Full instructions in `native-host/README.md`.

> If downloads report *"Saved, but not repaired"*, the host is not reachable.
> Check: files copied to a stable path, `path` in the manifest pointing at the
> `.bat`, correct extension ID in `allowed_origins`, registry key present, and
> Chrome fully quit and reopened.

### 9.5 `tools/remux.sh`

Standalone batch repair for files downloaded before this was automated, or on
machines without the host. Same ffmpeg invocation and the same duration-based
verification.

```bash
./remux.sh ~/Downloads        # copies into ./remuxed, originals untouched
./remux.sh ~/Downloads -n     # dry run
./remux.sh ~/Downloads -i -r  # in place, recursive
```

Filenames are preserved. Only `.ts`/`.mkv`/`.webm` change extension, since
those containers cannot hold an MP4 index.

---


Optional, self-hosted, zero-dependency.


An anonymous UUID is generated once and stored in `chrome.storage.local`. Events
are queued in memory and flushed after 5 s of quiet or when 20 accumulate,
disturb the extension.

Events emitted: `extension_installed`, `stream_detected` (hostname only),
`download_start`, `download_complete` (bytes, segments, failedSegments, ms),
`download_error`, `thumbnail_generated`, `external_download_start` /
`_complete` / `_error`, `remux_complete` (bytes), `remux_skipped`.

The remux pair is worth watching in aggregate: a high `remux_skipped` ratio
means most installs lack the native host, and are therefore getting fragmented
files with slow startup.

**Privacy:** no stream URLs, no page URLs, no personal data. Publishing the
extension would require disclosing this collection in a privacy policy.


`server.js` uses only Node built-ins. Events append to `events.jsonl` (one JSON
object per line — append-only, crash-safe, trivially greppable). Aggregation
happens on read with an mtime+size cache key, so repeated dashboard refreshes
don't re-parse the file.

| Route | Purpose |
|---|---|
| `POST /collect` | Ingest a batch |
| `GET /api/stats` | Aggregated JSON |
| `GET /` | Dashboard |

`dashboard.html` renders cards (installs, downloads, bytes, error rate, average
duration) and four Chart.js charts (daily active installs, stacked events/day,
bytes/day, version split) plus a recent-events table. Auto-refreshes every 30 s.

Deployment (nginx reverse proxy + systemd) is documented in

---

## 11. Message Protocol Reference

### Popup → Background

| Action | Payload | Response |
|---|---|---|
| `getStreams` | `tabId` | `{streams}` with `downloading` flag |
| `clearStreams` | `tabId` | `{success}` |
| `startDownload` | `url`, `filename`, `tabId` | `{success, downloadId}` |
| `cancelDownload` | `url` | `{success}` |
| `startExternalDownload` | `url` | `{success}` |
| `generateThumbnails` | `urls[]`, `tabId` | `{started}` |

### Background → Offscreen (`target: 'offscreen'`)

| Action | Payload |
|---|---|
| `downloadStream` | `url`, `filename` |
| `cancelDownload` | `url` |
| `generateThumbnail` | `url` |
| `releaseBlob` | `blobUrl` |

### Background ↔ Native Host (port, not `sendMessage`)

| Direction | Message |
|---|---|
| → | `{url, outdir}` — external download |
| → | `{action:'remux', path}` — repair a saved file |
| ← | `{type:'progress', percent, line}` |
| ← | `{type:'done', filename}` |
| ← | `{type:'remuxed', path, bytes}` |
| ← | `{type:'remuxSkipped', message}` |
| ← | `{type:'error', message}` |

### Offscreen → Background

| Action | Payload |
|---|---|
| `saveBlob` | `blobUrl`, `filename`, `streamUrl`, `stats` |
| `downloadProgress` | `url`, `progress` |
| `downloadError` | `url`, `error`, `tooLarge` |
| `streamMeta` | `url`, `meta` |
| `thumbnailReady` | `url`, `thumbnail`, `frames[]` |

### Background → Popup (broadcast; ignored if popup closed)

| Action | Meaning |
|---|---|
| `downloadProgress` | Segment progress or `phase:'finalizing'` |
| `downloadComplete` | File saved |
| `downloadError` | Failed; `tooLarge` triggers the bridge handoff button |
| `remuxStarted` | Repair began |
| `remuxComplete` | Repaired — file now seeks properly |
| `remuxSkipped` | Saved but left fragmented (amber, not an error) |
| `streamMeta` | Size / duration / resolution for a card |
| `thumbnailReady` | Preview frames ready |
| `externalProgress` / `externalComplete` / `externalError` | Native-host download |

> All `sendMessage` calls are `.catch(() => {})` — a closed popup rejects, and
> that is expected, not an error.

---

## 12. Known Limitations & Trade-offs

| Limitation | Cause | Mitigation |
|---|---|---|
| Output MP4 is fragmented — slow startup, poor transcoder support | mux.js emits fMP4; no `sidx`/`mfra`; empty sample tables | **Auto-remuxed after download** when the native host + ffmpeg are present. Without them the file stays fragmented; repair later with `tools/remux.sh` |
| Hard ~1.5 GB size ceiling | Everything buffered in memory; peak ≈ 2× video size | Size guard + external bridge handoff |
| Only detects `.m3u8` | Detection is extension-based pattern matching | Bridge handles other formats |
| **YouTube VOD unsupported** | Uses DASH/progressive, not HLS; URLs protected by `signatureCipher` and `n` throttling | Out of scope by design — circumventing those protections is both a ToS violation and a deliberate non-goal of this codebase |
| Streams lost on browser close | `storage.session` clears at browser exit | Intentional — avoids stale data |
| Site-service-worker requests show `tabId: -1` | Chrome reports no tab for those | Known; not currently handled |
| Only one offscreen document allowed | Chrome limitation | Downloads share it; concurrent large downloads risk OOM |


---

## 13. Testing Notes

No test framework is wired up; verification so far has been targeted harnesses
run under Node with browser globals stubbed. Worth preserving as regression tests:

**Ordering + concurrency** — mock `fetch` with random latency, assert writes
arrive in playlist order, max in-flight ≤ 4, and a failing segment is skipped
without stalling.

**Timeout** — mock a segment whose fetch never settles; assert the pipeline
completes rather than hanging (it did, in <1 s with a 300 ms timeout).

**Duration patching** — build a synthetic `ftyp`+`moov`+`moof` buffer, patch it,
read back `mvhd`/`tkhd`/`mdhd` and confirm each equals `duration × its timescale`.

**Progress display** — assert 4127/4130 renders 99%, and only 4130/4130 renders 100%.

**Native host — downloads** — pipe a length-prefixed message to
`crawlcast_host.py` with `CRAWLCAST_DL_BIN` pointed at a mock script; assert
progress/done framing, plus the three failure modes (missing binary, bad URL,
non-zero exit).

**Native host — remux** — build a genuinely fragmented MP4 with
`ffmpeg -movflags 'frag_keyframe+empty_moov+default_base_moof'`, send
`{action:'remux'}`, then assert the output has **zero `moof` boxes**, `moov`
before `mdat`, an unchanged duration, the same filename, and no leftover
`.remux.tmp` file. Failure paths: missing file, missing path, absent ffmpeg
(via `CRAWLCAST_FFMPEG_BIN`), and a corrupt input — each must leave the original
untouched.

**`tools/remux.sh`** — a directory containing filenames with spaces and
parentheses, a `.ts` needing extension promotion, a corrupt file, plus empty and
missing directories. Assert skip-existing, `-f`, `-r` (and that it prunes its
own `remuxed/` output), and that `-i` swaps atomically.

byte totals, error rate, and per-day bucketing.

---

## 14. Change Log

> Append new entries at the top. Note *why*, not just *what*.

### 1.0.0 — 2026-08-04 — Himitsu rebrand

Renamed from "M3U8 Video Downloader" to **Himitsu**, and the version counter
restarted at 1.0.0 under the new name. The pre-rebrand history below (as
"M3U8 Video Downloader," through 1.2.0) still describes real, shipped
behaviour — nothing was reverted, only renamed.

- **Retries raised from 3 to 20**, still linear backoff (`1000ms × attempt`).
  A stalled/flaky segment now gets substantially more chances before the
  downloader gives up on it and moves on.
  password reset — not a change of collection intent.

---

### Pre-rebrand history (as "M3U8 Video Downloader")

### 1.2.0 — 2026-08-01

- **Separate audio renditions are now downloaded.** Previously the parser
  ignored `#EXT-X-MEDIA` entirely and the downloader only ever fetched the
  video variant's segments. When a stream muxes audio into those segments
  (typical for TV episodes) that worked; when audio is a **separate
  rendition** — normal for films, which ship multiple languages and 5.1 —
  the result was a **silent video**. The parser now reads renditions and the
  `AUDIO=` group, `selectAudioRendition()` picks the default (or
  highest-channel) track, and the downloader fetches it through its own
  transmuxer. ffmpeg merges the two with `-map 0:v:0 -map 1:a:0 -c copy` in
  the same pass that writes the index.
- **Attribute parsing rewritten.** `parseStreamInf` split on commas, which
  corrupted `CODECS="avc1.640028,mp4a.40.2"`. Now a quote-aware parser, which
  is also what makes `#EXT-X-MEDIA` parsing viable.
- **Graceful degradation.** No native host, or audio download failed → the
  video still saves and the popup warns that the file will be silent, with
  the manual ffmpeg command. Never a lost download.
- **Dead code removed.** Placeholder `<h1>` in popup.html, unused
  `lib/StreamSaver.min.js`, the orphaned `getProgress` handler, and the
  `web_accessible_resources` entry that only existed for StreamSaver.

### 1.1.1 — 2026-07-31

- **Automatic post-download remux.** When a download finishes,
  `chrome.downloads.search()` yields the saved file's absolute path, which is
  sent to the native host with `{action:"remux"}`. The host runs
  `ffmpeg -c copy -movflags +faststart`, verifies the result by **duration**
  (not size — a lossless remux can legitimately shrink a file), and swaps it
  in place. Output has real sample tables and zero `moof` boxes: it starts
  instantly, seeks correctly, and transcodes on Plex.
  Fully optional and non-fatal — with no host or no ffmpeg the file is simply
  left fragmented and the popup says so in amber rather than reporting an error.
- **`tools/remux.sh`** for repairing existing files in bulk.

### 1.1.0 — 2026-07-30

- **Size shown before download.** Cards display estimated size, duration,
  resolution, and segment count. Oversized streams flagged amber with a handoff
  hint. Reuses the thumbnail job's playlist fetches, so no extra network cost.
- **Stall fix.** Per-attempt 30 s segment timeout via `AbortSignal.any()`.
  Previously a hung request froze a download permanently.
- **Honest progress.** `Math.floor` + 99% cap until all segments are accounted
  for (`Math.round` displayed 100% from 4109/4130). Added a "Finalizing" phase.
- **Working cancel.** The old handler referenced `.downloader` on a background
  record that no longer holds it — dead code. Now forwards to offscreen, which
  tracks live instances. Clear force-releases downloads stale >2 min.
- **Size guard.** Refuse in-browser downloads over 1.5 GB with a one-click
  handoff, instead of silently OOM-ing the offscreen document.
- **External downloader bridge.** Native messaging host + popup panel.
- **Animated previews.** 8 frames spread across the whole video, 600 ms cycle
  on hover. (First cut sampled only the first segment — too narrow to read.)
- **Download button state persisted.** `getStreams` now stamps `downloading`
  from background state; the popup's own map dies when it closes.
- **Clear preserves active downloads.**
- **Memory hygiene.** Revoke blob URLs after save, free chunk buffers, close
  the idle offscreen document.
- **Parallel fetching.** Sliding window of 4 with strictly ordered processing.
- **Seekable output.** Duration patched into `mvhd`/`tkhd`/`mdhd`; timestamps
  rebased to t=0.
- **Download pipeline rearchitected** to the offscreen document; StreamSaver
  dropped (needs a DOM the service worker doesn't have).
- **Parser fix.** Guard `currentVariant` before assigning `.url` — media
  playlists were crashing the whole download.
- **Stream list persistence** via `chrome.storage.session`.
- **Fixed `lib/mux.min.js`** — was a 9-byte "Not Found" HTML page, which threw
  on `importScripts` line 1 and killed the entire service worker. Root cause of
  "nothing works."

---

## 15. Future Work

**Defragment without external tools.** The native-host remux (v1.1.1) solves
this whenever the host and ffmpeg are installed, but not otherwise. Two ways to
close that gap, both deliberately deferred:

- *`ffmpeg.wasm` in the offscreen document* — self-contained, but MV3 requires
  vendoring the ~30 MB WASM binary, and wasm32's ~2 GB address space must hold
  input and output simultaneously. It would fail on exactly the large files that
  need it most.
- *Write real sample tables during transmux* — buffer sample metadata and emit
  `stts`/`stsc`/`stsz`/`stco` with a single `moov` + `mdat`, producing a correct
  file with no second pass and no dependencies. The right answer architecturally;
  effectively implementing part of an MP4 muxer, since mux.js offers no help.

**Stream to disk.** Replace in-memory buffering with the File System Access API
to remove the size ceiling entirely and make the bridge unnecessary for large files.

**Quality selection.** Currently hardcoded to highest bandwidth. The variant list
is already parsed — surfacing a picker is mostly UI work.

**Resume interrupted downloads.** Segment-level progress could persist, letting a
failed download restart where it stopped rather than from zero.

**Handle `tabId: -1`.** Attribute service-worker-initiated requests to the active
tab so those streams stop vanishing from the popup.

**Delete dead code.** `lib/StreamSaver.min.js`, the unused `getProgress` handler,
and the placeholder `<h1>` in `popup.html`.
