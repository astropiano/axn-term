// JWT ownership matrix for gateway /remote: needs the gateway running with
// its JwksUri pointed at this script's JWKS stub (port 9777):
//   ASPNETCORE_URLS=http://localhost:7700 \
//     Authentication__Authority=http://localhost:9777 \
//     Authentication__JwksUri=http://localhost:9777/jwks \
//     dotnet run --project apps/gateway -f net10.0
// then: node tests/remote-auth-matrix.mjs

import http from "node:http";
import { generateKeyPairSync, createSign } from "node:crypto";

// --- tiny JWKS stub ---
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" });
jwk.kid = "test-key";
jwk.use = "sig";
jwk.alg = "RS256";
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ keys: [jwk] }));
});
await new Promise((r) => server.listen(9777, r));

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function jwt(sub) {
  const header = b64({ alg: "RS256", typ: "JWT", kid: "test-key" });
  const payload = b64({ sub, preferred_username: sub, exp: Math.floor(Date.now() / 1000) + 3600 });
  const sig = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKey, "base64url");
  return `${header}.${payload}.${sig}`;
}

const { RamphastosAuthority, RamphastosSession } = await import(
  process.env.RAMPHASTOS_CLIENT_DIST ?? "ramphastos-client"
);
const alice = jwt("alice"), bob = jwt("bob");
let fails = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n} ${c ? "" : x}`); if (!c) fails++; };
const tryConnect = async (kind, token, session) => {
  try {
    if (kind === "authority")
      return await RamphastosAuthority.connect("http://localhost:7700/remote", { sessionId: session, auth: token });
    return await RamphastosSession.connect("http://localhost:7700/remote", { role: kind, sessionId: session, auth: token });
  } catch { return null; }
};

// 1. alice publishes her desktop
const authA = await tryConnect("authority", alice, "alice-desktop");
check("authority alice binds alice-desktop", !!authA);

// 2. alice's phone attaches
const viewA = await tryConnect("viewer", alice, "alice-desktop");
check("viewer alice attaches to own session", !!viewA, "");
check("viewer sees replica", viewA?.sessionId === "alice-desktop");

// 3. bob cannot attach to alice's session
check("viewer bob denied on alice-desktop", !(await tryConnect("viewer", bob, "alice-desktop")));

// 4. bob cannot hijack the session id as authority
check("authority bob denied on alice-desktop", !(await tryConnect("authority", bob, "alice-desktop")));

// 5. bob publishes his own session
const authB = await tryConnect("authority", bob, "bob-desktop");
check("authority bob binds bob-desktop", !!authB);

// 6. alice cannot see bob's
check("viewer alice denied on bob-desktop", !(await tryConnect("viewer", alice, "bob-desktop")));

// 7. authority must pin a session id
check("authority without session id denied", !(await tryConnect("authority", alice, undefined)));

// 8. garbage token denied
check("garbage token denied", !(await tryConnect("viewer", "not-a-jwt", "alice-desktop")));

// 9. control: connecting is free
check("controller alice attaches", !!(await tryConnect("controller", alice, "alice-desktop")));

// 10. discovery: /remote/sessions lists only the caller's own sessions
const listSessions = async (token) => {
  const res = await fetch("http://localhost:7700/remote/sessions", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return res.status === 200 ? (await res.json()).sessions : res.status;
};
const aliceList = await listSessions(alice);
check("alice discovers alice-desktop", Array.isArray(aliceList) && aliceList.includes("alice-desktop"),
  JSON.stringify(aliceList));
check("alice does not see bob-desktop", !aliceList?.includes?.("bob-desktop"));
const bobList = await listSessions(bob);
check("bob discovers bob-desktop only",
  Array.isArray(bobList) && bobList.includes("bob-desktop") && !bobList.includes("alice-desktop"),
  JSON.stringify(bobList));
check("no token → 401/403", (await listSessions(null)) >= 400);

await authA?.disconnect(); await authB?.disconnect(); await viewA?.disconnect();
server.close();
console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
