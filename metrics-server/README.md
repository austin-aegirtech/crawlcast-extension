# Miteruno Metrics Server

Zero-dependency telemetry collector and dashboard for the Miteruno extension.
Events arrive at `POST /collect`, are appended to `events.jsonl`, and the
dashboard at `/` aggregates them live (auto-refresh every 30s).

## Run locally

```bash
node server.js
# dashboard: http://127.0.0.1:8787/
```

## Deploy on ployan.me

1. Copy this folder to the server, e.g. `/opt/miteruno-metrics/`.

2. nginx — add inside the existing `server { }` block for ployan.me:

   ```nginx
   location /miteruno-metrics/ {
       proxy_pass http://127.0.0.1:8787/;
       proxy_set_header Host $host;
   }
   ```

   Then `sudo nginx -t && sudo systemctl reload nginx`.

3. Keep it running with systemd — `/etc/systemd/system/miteruno-metrics.service`:

   ```ini
   [Unit]
   Description=Miteruno metrics collector
   After=network.target

   [Service]
   ExecStart=/usr/bin/node /opt/miteruno-metrics/server.js
   Restart=always
   User=www-data

   [Install]
   WantedBy=multi-user.target
   ```

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now miteruno-metrics
   ```

4. Verify:

   ```bash
   curl -X POST https://ployan.me/miteruno-metrics/collect \
     -H 'Content-Type: application/json' \
     -d '{"installId":"test","version":"1.1.0","events":[{"event":"download_complete","props":{"bytes":1000000,"ms":4000},"ts":0}]}'
   ```

   Then open https://ployan.me/miteruno-metrics/ — the test event should appear.

## Extension side

The endpoint is configured at the top of `telemetry.js`
(`TELEMETRY_ENDPOINT`). It must match the nginx path above.

Events sent: `extension_installed`, `stream_detected` (hostname only),
`download_start`, `download_complete` (bytes, segments, failedSegments, ms),
`download_error` (message), `thumbnail_generated` (ok).

Privacy: only an anonymous install UUID plus the metrics above — no stream
URLs, no page URLs, no personal data. If you ever publish the extension,
disclose this collection in a privacy policy (Chrome Web Store requirement).

## Login gate (private test period)

The extension won't detect streams or start downloads until the popup's
login form succeeds against `POST /auth/login` on this same server. See
`auth.js` in the extension root for the client side.

**Managing testers** — this server never writes `users.json` itself, only
reads it. Add/remove/list accounts with:

```bash
node manage-users.js add alice      # prompts for a password, hides input
node manage-users.js remove alice
node manage-users.js list
```

Passwords are hashed with scrypt (Node's built-in `crypto`, no dependency)
before they touch disk. `users.json` and the auto-generated
`session-secret.txt` (used to sign login tokens) are both gitignored — never
commit them.

A lightweight in-memory rate limit (5 attempts / 15 min per IP) guards
against password guessing. It resets on server restart — fine for a small
test group, not meant to be a real production defense.

