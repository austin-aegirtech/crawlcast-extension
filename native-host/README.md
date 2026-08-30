# Crawlcast External Downloader Bridge

Lets the extension hand a URL to a downloader program **you** have installed
on your own machine, and shows its progress in the popup.

The extension itself contains no site-specific extraction logic. This host is
a generic pipe: URL in, progress out. Whatever the external binary supports is
what the bridge supports.

## How it fits together

```
popup  ──►  background.js  ──►  native messaging  ──►  crawlcast_host.py  ──►  external binary
                       ◄── progress / done / error ◄──
```

## Install (Windows)

1. **Have the downloader on PATH.** Verify in a terminal:

   ```
   yt-dlp --version
   ```

   To point at a different program or an absolute path, set the
   `CRAWLCAST_DL_BIN` environment variable.

2. **Copy the host files** somewhere stable, e.g. `C:\Users\austi\crawlcast-host\`:

   - `crawlcast_host.py`
   - `crawlcast_host.bat`

3. **Get your extension ID** from `chrome://extensions` (with Developer mode on).

4. **Edit `com.crawlcast.downloader.json`:**

   - set `path` to the absolute path of `crawlcast_host.bat`
     (e.g. `C:\\Users\\austi\\crawlcast-host\\crawlcast_host.bat` — note doubled backslashes)
   - replace `REPLACE_WITH_YOUR_EXTENSION_ID` with the ID from step 3

   Save it next to the host script.

5. **Register it** in the Windows registry (Command Prompt):

   ```
   reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.crawlcast.downloader" /ve /t REG_SZ /d "C:\Users\austi\crawlcast-host\com.crawlcast.downloader.json" /f
   ```

6. **Restart Chrome completely** (native host registration is read at startup).

## Install (macOS / Linux)

Same idea, but `path` points directly at `crawlcast_host.py` (make it
executable with `chmod +x`), and the manifest goes in:

- macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
- Linux: `~/.config/google-chrome/NativeMessagingHosts/`

## Use

Open the popup, paste a video page URL into the **External downloader** field,
press Fetch. Progress appears under the field; the file lands in your Downloads
folder.

The HLS pipeline (stream detection, in-browser transmuxing, thumbnails) is
unchanged and still handles `.m3u8` streams entirely inside the browser.

## Troubleshooting

| Symptom | Cause |
|---|---|
| "Native host not reachable" / "Specified native messaging host not found" | Registry key missing, wrong manifest path, or Chrome not restarted |
| "Access to the specified native messaging host is forbidden" | Extension ID in `allowed_origins` doesn't match |
| "'yt-dlp' not found on PATH" | Binary not installed, or set `CRAWLCAST_DL_BIN` |
| Nothing happens, no error | Check the service worker console at `chrome://extensions` |

Test the host directly without Chrome:

```
python -c "import struct,sys,json; m=json.dumps({'url':'https://example.com/x'}).encode(); sys.stdout.buffer.write(struct.pack('<I',len(m))+m)" | python crawlcast_host.py
```

## Note on scope

The bridge invokes software you installed and control. Downloading content you
don't own or that a site's terms prohibit is your responsibility, not the
extension's — worth a sentence in your project writeup about where the
in-browser pipeline ends and the external tool begins.
