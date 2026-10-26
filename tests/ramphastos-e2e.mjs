// End-to-end check of the session-host's /ramphastos endpoint: connect a
// controller, create a PTY, exercise the pty:<id> duplex stream and the
// fs/exec commands, then verify a viewer sees the same projection.
//
//   node tests/ramphastos-e2e.mjs [baseUrl]
//
// Needs a session host running (default http://localhost:7682), e.g.
//   SESSION_HOST_PORT=7682 dotnet run --project apps/session-host -f net10.0
// The ramphastos-client is imported from the sibling checkout
// (dev/libraries/ramphastos) — built dist, no package install required.

import { RamphastosSession } from "../../../libraries/ramphastos/src/client/ramphastos-client/dist/index.js";

const BASE = process.argv[2] ?? "http://localhost:7682";
const URL = `${BASE}/ramphastos`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : ` ${extra}`}`);
  if (!cond) failures++;
};

// Collect downstream data for a stream name.
function collectOutput(session, name) {
  const chunks = [];
  const seen = new Promise((resolve) => {
    const unsub = session.onStream((s) => {
      if (s.name !== name) return;
      s.onData((d) => chunks.push(d));
      resolve(s);
    });
    // resolve also when the stream already exists (announced earlier)
    for (const s of session.streams.values()) {
      if (s.name === name) {
        s.onData((d) => chunks.push(d));
        unsub();
        resolve(s);
        break;
      }
    }
  });
  return { chunks, stream: seen };
}

const text = (chunks) => new TextDecoder().decode(
  chunks.reduce((a, c) => { const b = new Uint8Array(a.length + c.length); b.set(a); b.set(c, a.length); return b; }, new Uint8Array()));

// --- controller session ---
const s = await RamphastosSession.connect(URL);
const vm = s.vm();
check("connected, role controller", s.role === "controller");
check("snapshot has ptys collection", Array.isArray(vm.ptys));
check("snapshot has defaultShell", typeof vm.defaultShell === "string");

// --- create a PTY ---
const ptyId = "e2e-" + Math.random().toString(36).slice(2, 10);
const out = collectOutput(s, `pty:${ptyId}`);
const created = await vm.createPty(ptyId, 100, 30);
check("createPty ok+spawned", created?.ok === true && created?.spawned === true, JSON.stringify(created));
await sleep(300);
check("ptys now contains the entry", vm.ptys.some((p) => p.id === ptyId), JSON.stringify(vm.ptys));

const stream = await out.stream;
check("pty:<id> stream announced", !!stream);

// --- write + read output over the stream ---
stream.write(new TextEncoder().encode("echo hello-ramphastos\n"));
await sleep(800);
check("pty output contains echoed line", text(out.chunks).includes("hello-ramphastos"), JSON.stringify(text(out.chunks).slice(-200)));

// --- cwd / fg / tty queries ---
const cwd = await vm.ptyCwd(ptyId);
check("ptyCwd ok", cwd?.ok === true && typeof cwd.cwd === "string", JSON.stringify(cwd));
const tty = await vm.ptyTty(ptyId);
check("ptyTty ok or null", tty?.ok === true, JSON.stringify(tty));

// --- fs + exec scoped to the PTY's live cwd ---
const wr = await vm.fsWrite(ptyId, "e2e-marker.txt", "from-ramphastos");
check("fsWrite ok", wr?.ok === true, JSON.stringify(wr));
const rd = await vm.fsRead(ptyId, "e2e-marker.txt");
check("fsRead round-trips", rd?.ok === true && rd.contents === "from-ramphastos", JSON.stringify(rd));
const st = await vm.fsStat(ptyId, "e2e-marker.txt");
check("fsStat isFile", st?.ok === true && st.isFile === true, JSON.stringify(st));
const ls = await vm.fsList(ptyId, ".");
check("fsList includes marker", ls?.ok === true && ls.entries.some((e) => e.name === "e2e-marker.txt"));
const ex = await vm.exec(ptyId, undefined, "echo exec-ok", cwd?.cwd);
check("exec runs in session env", ex?.ok === true && ex.stdout.trim() === "exec-ok", JSON.stringify(ex));

// --- resize ---
const rz = await vm.resizePty(ptyId, 120, 40);
check("resizePty ok", rz?.ok === true);
await sleep(200);
check("ptys cols/rows patched", vm.ptys.find((p) => p.id === ptyId)?.cols === 120);

// --- viewer attach: same session, same projection, read-only stream ---
const viewer = await RamphastosSession.connect(URL, { role: "viewer", sessionId: s.sessionId });
const vmv = viewer.vm();
check("viewer same session", viewer.sessionId === s.sessionId);
check("viewer sees ptys", vmv.ptys.some((p) => p.id === ptyId));
await sleep(200);
const viewerSeesStream = [...viewer.streams.values()].some((st2) => st2.name === `pty:${ptyId}`);
check("viewer received stream announce", viewerSeesStream);
const forbidden = await vmv.createPty("nope").then(() => "resolved", (e) => e.body?.code);
check("viewer createPty forbidden", forbidden === "forbidden", String(forbidden));

// --- close ---
await vm.closePty(ptyId);
await sleep(300);
check("ptys entry removed", !vm.ptys.some((p) => p.id === ptyId), JSON.stringify(vm.ptys));
check("stream closed on viewer", ![...viewer.streams.values()].some((st2) => st2.name === `pty:${ptyId}`));

await s.disconnect();
await viewer.disconnect();

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
