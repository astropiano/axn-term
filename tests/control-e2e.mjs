// End-to-end check of `axn-term session …` in web terminals: a program in a
// session-host PTY runs "$AXN_TERM_CLI" (the host-written sh + curl script),
// the host's control socket verifies the PTY secret and forwards the line to
// the browser side — here stood in for by this script — over both
// transports: the raw /ws protocol and RemoteBackend's Ramphastos `control`
// stream. Runs the TypeScript source via `node --experimental-strip-types`.
//
//   node --experimental-strip-types tests/control-e2e.mjs [baseUrl]
//
// Needs a session host (default http://localhost:7682) with bash + curl, e.g.
//   SESSION_HOST_PORT=7682 AXN_SESSION_HOST_INSECURE=1 dotnet run --project apps/session-host -f net10.0

import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const link = path.join(repoRoot, "node_modules", "@astropiano", "ramphastos-client");
const target = path.resolve(repoRoot, "../ramphastos/src/client/ramphastos-client");
if (!existsSync(link)) {
  mkdirSync(path.dirname(link), { recursive: true });
  symlinkSync(target, link, "junction");
}
const { RemoteBackend } = await import("../libs/session-backend/src/RemoteBackend.ts");

const BASE = process.argv[2] ?? "http://localhost:7682";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : ` ${extra}`}`);
  if (!cond) failures++;
};
const waitFor = async (pred, ms = 15000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return true;
    await sleep(100);
  }
  return false;
};

// ---------------------------------------------------------------- /ws
{
  const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/ws`);
  let output = "";
  let sessionId;
  const commands = [];
  let answer = (req) => ({ ok: true, message: `ws-ack:${req.line}` });
  ws.onmessage = (event) => {
    const text = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
    try {
      const msg = JSON.parse(text);
      if (msg.type === "session") { sessionId = msg.sessionId; return; }
      if (msg.type === "control-command") {
        commands.push(msg);
        const reply = answer(msg);
        if (reply) ws.send(JSON.stringify({ type: "control-reply", requestId: msg.requestId, ...reply }));
        return;
      }
    } catch { /* terminal output */ }
    output += text;
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  check("/ws: session assigned", await waitFor(() => sessionId));
  const type = (line) => ws.send(`${line}\n`);

  type(`"$AXN_TERM_CLI" session summary 'from the web'; echo okrc=$?`);
  check("/ws: summary answered (rc 0)", await waitFor(() => output.includes("okrc=0")), output.slice(-300));
  check("/ws: line forwarded verbatim", commands[0]?.line === "axn-session-summary from the web", JSON.stringify(commands[0]));
  check("/ws: the browser's message is printed", output.includes("ws-ack:axn-session-summary from the web"));

  type(`AXN_TERM_PTY_SECRET=bad "$AXN_TERM_CLI" session summary nope; echo badrc=$?`);
  check("/ws: bad secret refused (rc 1)", await waitFor(() => output.includes("badrc=1")), output.slice(-300));
  check("/ws: a refused line never reaches the browser", commands.length === 1);

  type(`"$AXN_TERM_CLI" session command rm -rf x; echo cmdrc=$?`);
  check("/ws: non-axn command refused (rc 2)", await waitFor(() => output.includes("cmdrc=2")), output.slice(-300));

  answer = () => ({ ok: false, error: "refused by the window" });
  type(`"$AXN_TERM_CLI" session focus nowhere; echo refrc=$?`);
  check("/ws: a refusal exits 1 with the reason", await waitFor(() => output.includes("refrc=1")) &&
    output.includes("refused by the window"), output.slice(-300));

  answer = () => null; // the window stays silent
  type(`"$AXN_TERM_CLI" session summary silent; echo silentrc=$?`);
  check("/ws: no answer times out (rc 1)", await waitFor(() => output.includes("silentrc=1"), 20000) &&
    output.includes("no axn-term window answered"), output.slice(-300));
  ws.close();
}

// ---------------------------------------------------------------- Ramphastos
{
  const backend = new RemoteBackend({ url: `${BASE}/ramphastos` });
  const ptyId = "ctle2e-" + Math.random().toString(36).slice(2, 10);
  let output = "";
  backend.onOutput(ptyId, (d) => { output += new TextDecoder().decode(d); });
  const seen = [];
  backend.onControlCommand(async (cmd) => {
    seen.push(cmd);
    return cmd.ptyId === ptyId ? { ok: true, message: `remote-ack:${cmd.line}` } : null;
  });
  await backend.createSession(ptyId, { cols: 120, rows: 30 });
  await sleep(500);
  backend.write(ptyId, `"$AXN_TERM_CLI" session rename "web box"; echo rrc=$?\n`);
  check("ramphastos: rename answered (rc 0)", await waitFor(() => output.includes("rrc=0")), output.slice(-300));
  check("ramphastos: request carries our pty id", seen[0]?.ptyId === ptyId, JSON.stringify(seen[0]));
  check("ramphastos: the reply is printed", output.includes("remote-ack:axn-rename web box"));
  await backend.disconnect();
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
