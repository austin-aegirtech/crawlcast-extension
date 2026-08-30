/**
 * Crawlcast metrics collector + dashboard server.
 * Zero dependencies — Node.js built-ins only. Events are appended to
 * events.jsonl (one JSON object per line); stats are aggregated on read
 * with an mtime-based cache.
 *
 * Run:    node server.js            (listens on 127.0.0.1:8787)
 * Deploy: see README.md (nginx reverse proxy + systemd unit)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_FILE = path.join(__dirname, 'events.jsonl');
const DASHBOARD_FILE = path.join(__dirname, 'dashboard.html');
const USERS_FILE = path.join(__dirname, 'users.json');
const SECRET_FILE = path.join(__dirname, 'session-secret.txt');
const MAX_BODY_BYTES = 1024 * 1024; // 1 MB per request is plenty

// ---------------------------------------------------------------------------
// Auth (private test period)
//
// Gates the extension behind login for the initial small test group. Users
// are managed with `node manage-users.js add/remove/list` (see that file) —
// this server only ever reads users.json, never writes it. Passwords are
// hashed with scrypt (Node's built-in crypto — no extra dependency).
// ---------------------------------------------------------------------------

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch {
    return {}; // no users.json yet — every login fails closed, not open
  }
}

function verifyPassword(password, salt, hash) {
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(check, 'hex');
  const b = Buffer.from(hash, 'hex');
  // Constant-time compare — a length mismatch alone would otherwise leak
  // timing information about the stored hash.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Generated on first run, kept out of git (see metrics-server/.gitignore).
// Losing/rotating this just invalidates existing sessions — testers log in
// again, nothing else depends on it right now.
function getSessionSecret() {
  try {
    return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SECRET_FILE, secret + '\n', { mode: 0o600 });
    return secret;
  }
}
const SESSION_SECRET = getSessionSecret();

/** Opaque, HMAC-signed token. Not currently re-verified by any endpoint —
 *  the extension only needs a successful login handshake once per browser
 *  session — but it's real and signed now in case that changes later
 *  (e.g. gating /collect the same way). */
function issueToken(username) {
  const payload = `${username}.${Date.now()}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}.${sig}`).toString('base64');
}

// Small in-memory throttle against password guessing. Deliberately simple —
// a handful of testers, not a public login form — so it doesn't survive a
// restart and doesn't need a dependency.
const loginAttempts = new Map(); // ip -> { count, resetAt }
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;

function isRateLimited(key) {
  const entry = loginAttempts.get(key);
  if (!entry) return false;
  if (Date.now() > entry.resetAt) { loginAttempts.delete(key); return false; }
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}

function recordLoginAttempt(key) {
  const entry = loginAttempts.get(key);
  if (!entry || Date.now() > entry.resetAt) {
    loginAttempts.set(key, { count: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
  } else {
    entry.count++;
  }
}

function clearLoginAttempts(key) {
  loginAttempts.delete(key);
}

// ---------------------------------------------------------------- helpers

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*'); // extension origins vary per install
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, status, obj) {
  setCors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(status === 204 ? undefined : JSON.stringify(obj));
}

// ------------------------------------------------------------- event store

let cache = { key: '', events: [] };

function loadEvents() {
  let stat;
  try {
    stat = fs.statSync(DATA_FILE);
  } catch {
    return []; // no events yet
  }
  const key = `${stat.mtimeMs}:${stat.size}`;
  if (cache.key === key) return cache.events;

  const events = [];
  for (const line of fs.readFileSync(DATA_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
  }
  cache = { key, events };
  return events;
}

function appendEvents(installId, version, incoming) {
  const now = Date.now();
  const lines = incoming.map((e) => JSON.stringify({
    installId: String(installId).slice(0, 64),
    version: String(version || '?').slice(0, 32),
    event: String(e.event).slice(0, 64),
    props: (e.props && typeof e.props === 'object') ? e.props : {},
    ts: Number(e.ts) || now,
    receivedAt: now
  })).join('\n') + '\n';
  fs.appendFileSync(DATA_FILE, lines);
}

// -------------------------------------------------------------- aggregation

function dayOf(ts) {
  return new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function buildStats() {
  const events = loadEvents();

  const installs = new Set();
  const versions = {};
  const eventCounts = {};
  const byDay = {}; // day -> { installs:Set, events:{name:count}, bytes }
  let totalBytes = 0;
  let totalDownloadMs = 0;
  let completeCount = 0;
  let errorCount = 0;

  for (const e of events) {
    installs.add(e.installId);
    versions[e.version] = (versions[e.version] || 0) + 1;
    eventCounts[e.event] = (eventCounts[e.event] || 0) + 1;

    const day = dayOf(e.ts);
    if (!byDay[day]) byDay[day] = { installs: new Set(), events: {}, bytes: 0 };
    byDay[day].installs.add(e.installId);
    byDay[day].events[e.event] = (byDay[day].events[e.event] || 0) + 1;

    if (e.event === 'download_complete') {
      completeCount++;
      totalBytes += Number(e.props.bytes) || 0;
      totalDownloadMs += Number(e.props.ms) || 0;
      byDay[day].bytes += Number(e.props.bytes) || 0;
    }
    if (e.event === 'download_error') errorCount++;
  }

  const days = Object.keys(byDay).sort();
  return {
    generatedAt: Date.now(),
    totals: {
      events: events.length,
      installs: installs.size,
      downloads: completeCount,
      downloadErrors: errorCount,
      errorRate: (completeCount + errorCount) > 0
        ? errorCount / (completeCount + errorCount) : 0,
      bytesDownloaded: totalBytes,
      avgDownloadMs: completeCount > 0 ? Math.round(totalDownloadMs / completeCount) : 0
    },
    versions,
    eventCounts,
    daily: days.map((day) => ({
      day,
      activeInstalls: byDay[day].installs.size,
      events: byDay[day].events,
      bytes: byDay[day].bytes
    })),
    recent: events.slice(-50).reverse().map((e) => ({
      ts: e.ts,
      installId: e.installId.slice(0, 8), // shortened for display
      version: e.version,
      event: e.event,
      props: e.props
    }))
  };
}

// ------------------------------------------------------------------ server

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    setCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // POST /auth/login — test-group login gate for the extension
  if (req.method === 'POST' && url.pathname === '/auth/login') {
    const ip = req.socket.remoteAddress || 'unknown';
    let body = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { req.destroy(); return; }
      body += chunk;
    });
    req.on('end', () => {
      if (isRateLimited(ip)) {
        json(res, 429, { ok: false, error: 'Too many attempts. Try again in a few minutes.' });
        return;
      }

      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        json(res, 400, { ok: false, error: 'Invalid request' });
        return;
      }

      const { username, password } = payload || {};
      if (!username || !password) {
        json(res, 400, { ok: false, error: 'Username and password are required' });
        return;
      }

      const users = loadUsers();
      const user = users[username];
      if (!user || !verifyPassword(password, user.salt, user.hash)) {
        recordLoginAttempt(ip);
        json(res, 401, { ok: false, error: 'Invalid username or password' });
        return;
      }

      clearLoginAttempts(ip);
      json(res, 200, { ok: true, username, token: issueToken(username) });
    });
    return;
  }

  // POST /collect — event ingestion from extension instances
  if (req.method === 'POST' && url.pathname === '/collect') {
    let body = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { req.destroy(); return; }
      body += chunk;
    });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        if (!payload.installId || !Array.isArray(payload.events) || payload.events.length === 0) {
          json(res, 400, { error: 'installId and non-empty events[] required' });
          return;
        }
        appendEvents(payload.installId, payload.version, payload.events.slice(0, 100));
        json(res, 204, {});
      } catch {
        json(res, 400, { error: 'invalid JSON' });
      }
    });
    return;
  }

  // GET /api/stats — aggregated metrics for the dashboard
  if (req.method === 'GET' && url.pathname === '/api/stats') {
    json(res, 200, buildStats());
    return;
  }

  // GET / — the dashboard
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/dashboard')) {
    setCors(res);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(DASHBOARD_FILE));
    return;
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`[metrics] listening on http://${HOST}:${PORT}`);
  console.log(`[metrics] events file: ${DATA_FILE}`);
});
