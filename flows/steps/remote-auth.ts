// Reproduces the desktop remote-control auth path headlessly:
//   1. device-flow POST → axn-term-desktop client must yield a device_code
//      (an "invalid_client" response here is exactly the failure the DMG hit)
//   2. password grant → a real JWT for the demo account
//   3. /remote hello over ws:// — denied without a token, bound to the
//      caller's JWT sub with one (AllowAnonymous=false on the gateway)
//
// Endpoints default to the scenario's plain listeners; override via env.

const KC = process.env.REMOTE_KC_URL ?? 'http://127.0.0.1:18097/auth/realms/axn-term';
const GW = process.env.REMOTE_GW_URL ?? 'http://127.0.0.1:18097/gw/remote';
const CLIENT = process.env.REMOTE_CLIENT_ID ?? 'axn-term-desktop';
const USER = process.env.TEST_USER ?? 'demo';
const PASSWORD = process.env.TEST_PASSWORD ?? 'changeme';
const SESSION = process.env.REMOTE_SESSION ?? 'flow-test';

async function postForm(url: string, params: Record<string, string>) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { error: `HTTP ${res.status}`, body: text.slice(0, 200) }; }
}

async function main() {

// The real client — same code path the desktop app runs (raw-WS hello with
// auth in the envelope + access_token query param). Resolves from
// node_modules (the published package); RAMPHASTOS_CLIENT_DIST points it
// at a local build instead (sibling checkout's dist/index.js).
const clientDist = process.env.RAMPHASTOS_CLIENT_DIST ?? 'ramphastos-client';
const { RamphastosAuthority } = await import(clientDist);

// Tenant-scoped session ids: the gateway namespaces every mirrored session
// '<jwt-sub>/<id>' — same helper the real client runs (libs/session-backend).
const { scopeSessionId } = await import(
  new URL('../../libs/session-backend/src/remoteScope.ts', import.meta.url).href
);

async function hello(token: string | undefined): Promise<'accepted'> {
  const url = token ? `${GW}?access_token=${encodeURIComponent(token)}` : GW;
  const authority = await RamphastosAuthority.connect(url, {
    auth: token,
    sessionId: scopeSessionId(SESSION, token) ?? SESSION,
    webSocketOnly: true,
    meta: { kind: 'flow-test' },
  });
  await authority.disconnect().catch(() => {});
  return 'accepted';
}

const failures: string[] = [];
const ok = (cond: boolean, label: string, detail?: unknown) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 160)}` : ''}`);
  if (!cond) failures.push(label);
};

// 1. device flow: the desktop client must offer a device code
const dev = await postForm(`${KC}/protocol/openid-connect/auth/device`, { client_id: CLIENT });
ok(Boolean(dev.device_code), 'device endpoint returns device_code (not invalid_client)', dev.error ?? dev.user_code);

// 2. mint a JWT for the test user via password grant (direct access on the client)
const tok = await postForm(`${KC}/protocol/openid-connect/token`, {
  grant_type: 'password', client_id: CLIENT, username: USER, password: PASSWORD,
});
ok(Boolean(tok.access_token), 'password grant returns access_token', tok.error ?? 'token ok');

// 3a. /remote authority connect without a token must be denied
//     (AllowAnonymous=false) — RamphastosAuthority.connect rejects.
try {
  await hello(undefined);
  ok(false, 'anonymous authority hello is denied', 'unexpectedly accepted');
} catch (e) {
  ok(true, 'anonymous authority hello is denied', String(e).slice(0, 120));
}

// 3b. authority connect with the demo JWT must be accepted (session→sub bind)
if (tok.access_token) {
  try {
    await hello(tok.access_token);
    ok(true, 'JWT authority hello is accepted', 'connected');
  } catch (e) {
    ok(false, 'JWT authority hello is accepted', String(e).slice(0, 160));
  }
}

console.log(failures.length ? `remote auth flow FAILED (${failures.length})` : 'remote auth flow passed');
process.exit(failures.length ? 1 : 0);

}

main();
