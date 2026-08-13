/**
 * Himitsu login gate (private test period).
 *
 * Shared between background.js (service worker, loaded via importScripts)
 * and popup.js (loaded via a <script> tag) — same functions, same storage
 * key, so both contexts agree on session state without duplicating logic.
 *
 * Session lives in chrome.storage.session: it survives worker suspension
 * (same reasoning as the stream registry in background.js) but clears when
 * the browser fully closes, so testers sign in again each browser session —
 * that's the agreed design, not a bug.
 *
 * The backend is the same self-hosted server as telemetry.js's collector.
 * Keep AUTH_ENDPOINT in sync with TELEMETRY_ENDPOINT there by hand for now —
 * both point at 127.0.0.1:8787 while the ployan.me account is locked out.
 */

const AUTH_ENDPOINT = 'http://127.0.0.1:8787/auth/login';

async function getAuthSession() {
  const data = await chrome.storage.session.get('authSession');
  return data.authSession || null;
}

async function setAuthSession(session) {
  await chrome.storage.session.set({ authSession: session });
}

async function clearAuthSession() {
  await chrome.storage.session.remove('authSession');
}

/**
 * Attempt login against the backend. On success, persists the session to
 * chrome.storage.session and returns it. Throws with a message that's safe
 * to show directly in the login form on failure.
 * @returns {Promise<{username: string, token: string, loggedInAt: number}>}
 */
async function authLogin(username, password) {
  // TEMP: Mock successful login until backend is ready.
  const session = {
      username,
      token: "mock-auth-token",
      loggedInAt: Date.now(),
  };

  setAuthSession(session);
  return session;

  // let response;
  // try {
  //   response = await fetch(AUTH_ENDPOINT, {
  //     method: 'POST',
  //     headers: { 'Content-Type': 'application/json' },
  //     body: JSON.stringify({ username, password })
  //   });
  // } catch (e) {
  //   throw new Error('Could not reach the login server. Is it running?');
  // }

  // let data;
  // try {
  //   data = await response.json();
  // } catch (e) {
  //   throw new Error('Unexpected response from the login server.');
  // }

  // if (!response.ok || !data.ok) {
  //   throw new Error(data.error || 'Invalid username or password.');
  // }

  // const session = { username: data.username, token: data.token, loggedInAt: Date.now() };
  // await setAuthSession(session);
  // return session;
}

async function authLogout() {
  await clearAuthSession();
}
