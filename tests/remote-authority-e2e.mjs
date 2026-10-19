// End-to-end check of the client-authoritative topology: RemoteAuthority
// (the desktop side) publishes a mirrored session upstream; RemoteBackend
// attaches as controller and drives the desktop's PTYs through the
// server's tunnels — invoke forwarding + pty:<id> stream relay.
//
//   node --experimental-strip-types tests/remote-authority-e2e.mjs [baseUrl]
//
// Needs a session host running (default http://localhost:7682), e.g.
//   SESSION_HOST_PORT=7682 dotnet run --project apps/session-host -f net10.0
// 'ramphastos-client' resolves through the node_modules symlink created by
// remote-backend-e2e.mjs (recreated here if absent).

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

const { RemoteAuthority } = await import("../libs/session-backend/src/RemoteAuthority.ts");
const { RemoteBackend } = await import("../libs/session-backend/src/RemoteBackend.ts");
const { RamphastosSession } = await import("@astropiano/ramphastos-client");

// Hub URL arg may be a bare base (session-host) or a full endpoint path
// (gateway /remote). Bare bases get the session-host's /ramphastos appended.
const HUB_URL = (process.argv[2] ?? "http://localhost:7682/ramphastos")
  .replace(/\/$/, "")
  .replace(/^(https?:\/\/[^/]+)$/, "$1/ramphastos");
const SESSION_ID = "test-desktop-" + Math.random().toString(36).slice(2, 8);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : ` ${extra}`}`);
  if (!cond) failures++;
};
const enc = (s) => new TextEncoder().encode(s);
const text = (chunks) => new TextDecoder().decode(
  chunks.reduce((a, c) => { const b = new Uint8Array(a.length + c.length); b.set(a); b.set(c, a.length); return b; }, new Uint8Array()));

// ---- the "desktop": an in-memory SessionBackend pretending to own PTYs ----
class FakeBackend {
  live = new Set();
  outputCbs = new Map();
  exitCbs = [];
  closedWith = [];
  emit(id, data) { for (const cb of this.outputCbs.get(id) ?? []) cb(data); }
  createSession(id) { this.live.add(id); setTimeout(() => this.emit(id, enc("fake$ ")), 20); return Promise.resolve(true); }
  createSubshell(id, opts) { this.live.add(id); setTimeout(() => this.emit(id, enc(`${opts.command}\nfake$ `)), 20); return Promise.resolve(true); }
  write(id, data) { this.emit(id, enc(data)); }
  resize() {}
  close(id) { this.closedWith.push(id); this.live.delete(id); }
  onOutput(id, cb) {
    let s = this.outputCbs.get(id);
    if (!s) this.outputCbs.set(id, (s = new Set()));
    s.add(cb);
    return () => s.delete(cb);
  }
  getCwd() { return Promise.resolve("/home/dev"); }
  getTty() { return Promise.resolve("/dev/ttys001"); }
  getForegroundProcess() { return Promise.resolve("vim"); }
  getDefaultShell() { return Promise.resolve("/bin/zsh"); }
  exec() { return Promise.resolve("exec-output"); }
  onSessionExit(cb) { this.exitCbs.push(cb); return () => {}; }
}
const fake = new FakeBackend();

// ---- authority: publishes the mirrored session ----
const authority = new RemoteAuthority({
  url: HUB_URL,
  sessionId: SESSION_ID,
  backend: fake,
  meta: { kind: "desktop", window: "main" },
});
await authority.start();
check("authority connected, pinned session id", authority.sessionId === SESSION_ID, String(authority.sessionId));

// reflect a locally-running session (as if restored from window state)
authority.reflectPtys([
  { id: "local-1", name: "shell", cwd: "/home/dev", kind: "session", workspaceId: "ws-a" },
  { id: "sub-1", kind: "subshell", sessionId: "local-1", command: "htop", name: "htop" },
]);
await sleep(300);

// ---- viewer attaches to the mirror: replica state visible ----
const viewer = await RamphastosSession.connect(HUB_URL, { role: "viewer", sessionId: SESSION_ID });
const vmv = viewer.vm();
await sleep(200);
check("viewer sees mirrored session", viewer.sessionId === SESSION_ID);
check("replica has ptys collection", Array.isArray(vmv.ptys), JSON.stringify(Object.keys(vmv)));
check("replica has local pty", vmv.ptys?.some((p) => p.id === "local-1"), JSON.stringify(vmv.ptys));
check("replica marks desktop device", vmv.device === "desktop", String(vmv.device));

// ---- controller: RemoteBackend drives a remote-created PTY ----
const controller = new RemoteBackend({ url: HUB_URL, sessionId: SESSION_ID });
const out = [];
controller.onOutput("rpty-1", (d) => out.push(d));
check("controller createSession spawned", (await controller.createSession("rpty-1", { cols: 100, rows: 30 })) === true);
await sleep(400);
check("remote-created pty got prompt output", text(out).includes("fake$"), JSON.stringify(text(out)));
check("replica shows remote pty", vmv.ptys.some((p) => p.id === "rpty-1"), JSON.stringify(vmv.ptys?.map((p) => p.id)));

// keystrokes tunnel upstream: client → server → authority → fake PTY → output → back
controller.write("rpty-1", "echo tunneled-io\n");
await sleep(500);
check("pty stream carries tunneled io", text(out).includes("tunneled-io"), JSON.stringify(text(out)));

// queries forward to the desktop backend
check("getCwd forwarded", (await controller.getCwd("rpty-1")) === "/home/dev");
check("getTty forwarded", (await controller.getTty("rpty-1")) === "/dev/ttys001");
check("getForegroundProcess forwarded", (await controller.getForegroundProcess("rpty-1")) === "vim");
check("getDefaultShell forwarded", (await controller.getDefaultShell()) === "/bin/zsh");
check("exec forwarded", (await controller.exec("rpty-1", "anything")) === "exec-output");

// ---- exit path: fake PTY dies → replica marks exited ----
fake.emit("local-1", enc("bye\n"));
for (const cb of fake.exitCbs) cb("local-1");
await sleep(300);
check("replica marks exited pty", vmv.ptys.find((p) => p.id === "local-1")?.status === "exited", JSON.stringify(vmv.ptys));

// ---- mirror store: synthesizes WindowState for the shared UI ----
const { createMirrorStateStore } = await import("../libs/session-backend/src/MirrorStateStore.ts");
const store = createMirrorStateStore(() => controller.ramphastosSession());
const winState = await store.load("win-1");
check("mirror state has workspaces+sessions",
  Array.isArray(winState.workspaces) && Array.isArray(winState.sessions));
check("mirror session carries workspace+cwd",
  winState.sessions.some((s) => s.id === "local-1" && s.cwd === "/home/dev" && s.workspaceId === "ws-a"),
  JSON.stringify(winState.sessions));
check("mirror maps exited → completed",
  winState.sessions.find((s) => s.id === "local-1")?.status === "completed");
check("mirror subshell becomes a shell tab",
  winState.sessions.find((s) => s.id === "local-1")?.editors?.some(
    (e) => e.id === "sub-1" && e.kind === "shell"),
  JSON.stringify(winState.sessions.find((s) => s.id === "local-1")?.editors));
// watch fires when the replica patches
let watched = 0;
const unwatch = store.watch("win-1", () => watched++);
authority.reflectPtys([
  { id: "local-1", name: "shell", cwd: "/home/dev", kind: "session", workspaceId: "ws-a" },
  { id: "local-2", name: "two", kind: "session", workspaceId: "ws-a" },
]);
await sleep(400);
check("watch fires on upstream patch", watched > 0);
unwatch();
const winState2 = await store.load("win-1");
check("mirror picks up new session", winState2.sessions.some((s) => s.id === "local-2"));

// ---- close path ----
controller.close("rpty-1");
await sleep(300);
check("closePty forwarded to desktop", fake.closedWith.includes("rpty-1"), JSON.stringify(fake.closedWith));
check("replica drops closed pty", !vmv.ptys.some((p) => p.id === "rpty-1"));

await controller.disconnect();
await viewer.disconnect();
await authority.stop();
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
