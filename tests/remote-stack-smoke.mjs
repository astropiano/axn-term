// Smoke test of the real remote path on a running stack — the path phones
// and browsers take: discovery → endpoint pick → sign-in → /remote/status →
// a (fake) desktop publishes over the hub → a controller attaches and
// drives its terminals (tests/remote-authority-e2e.mjs).
//
//   NODE_EXTRA_CA_CERTS=scenarios/axn-term-online/certs/ca.pem \
//     node --experimental-strip-types tests/remote-stack-smoke.mjs https://192.168.1.41:18092
//
// Env: AXN_E2E_USER / AXN_E2E_PASSWORD (default admin / admin). Signs in
// with the desktop client's password grant (dev realm) — no browser needed.
// Not the account you test with by hand: the hub keeps the fake desktop's
// session listed as offline afterwards, and that account's viewers would
// find it.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const { fetchServerDiscovery, pickEndpoint, endpointUrls } = await import(
  "../libs/session-backend/src/serverDiscovery.ts"
);

const server = process.argv[2] ?? "https://axn-term.localhost:8092";
const user = process.env.AXN_E2E_USER ?? "admin";
const password = process.env.AXN_E2E_PASSWORD ?? "admin";

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : ` — ${extra}`}`);
  if (!cond) failures++;
  return cond;
};
const fail = (name, e) => {
  check(name, false, e instanceof Error ? e.message : String(e));
  if (/certificate|self.signed|UNABLE_TO_VERIFY/i.test(String(e?.cause ?? e)))
    console.log("      hint: set NODE_EXTRA_CA_CERTS to the stack's CA (scenarios/axn-term-online/certs/ca.pem)");
  process.exit(1);
};

// 1. discovery
let doc;
try {
  doc = await fetchServerDiscovery(server);
  check(`discovery at ${server}`, true);
} catch (e) {
  fail(`discovery at ${server}`, e);
}
console.log(`      server ${doc.name} (${doc.id}); endpoints: ${doc.endpoints.map((e) => e.label).join(", ")}`);

// 2. a reachable endpoint
const endpoint = await pickEndpoint(doc);
if (!check("an endpoint answers", !!endpoint)) process.exit(1);
const urls = endpointUrls(endpoint);
console.log(`      using ${endpoint.label}: ${endpoint.gateway}`);

// 3. sign in (desktop client — it is what publishes)
const clientId = doc.clients.desktop ?? "axn-term-desktop";
let token;
try {
  const res = await fetch(`${endpoint.issuer}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: clientId, username: user, password, scope: "openid" }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error_description ?? body.error ?? `HTTP ${res.status}`);
  token = body.access_token;
  check(`sign-in as ${user} (${clientId})`, !!token);
} catch (e) {
  fail(`sign-in as ${user} (${clientId})`, e);
}

// 4. the gateway accepts the token and explains state
try {
  const res = await fetch(`${urls.http}/remote/status`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json();
  check("gateway accepts the token (/remote/status)", res.ok, body.error);
} catch (e) {
  fail("gateway /remote/status", e);
}

// 5. publish + attach + drive through the hub
const e2e = fileURLToPath(new URL("./remote-authority-e2e.mjs", import.meta.url));
const run = spawnSync(process.execPath, ["--experimental-strip-types", e2e, urls.http + "/remote"], {
  env: { ...process.env, AXN_E2E_TOKEN: token },
  encoding: "utf8",
  timeout: 120_000,
});
const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
for (const line of out.split("\n")) if (/^(PASS|FAIL)/.test(line)) console.log(`      ${line}`);
check("desktop publishes, controller attaches and drives terminals", run.status === 0, out.split("\n").filter((l) => l.startsWith("FAIL")).join("; ") || `exit ${run.status}`);

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
