// End-to-end check of the client-authoritative topology: RemoteAuthority
// (the desktop side) publishes a mirrored session upstream; RemoteBackend
// attaches as controller and drives the desktop's PTYs through the
// server's tunnels — invoke forwarding + pty:<id> stream relay.
//
//   node --experimental-strip-types tests/remote-authority-e2e.mjs [baseUrl]
//
// Needs a session host running (default http://localhost:7682), e.g.
//   SESSION_HOST_PORT=7682 dotnet run --project apps/session-host -f net10.0
// 'ramphastos-client' resolves from node_modules (the published package);
// RAMPHASTOS_CLIENT_DIST overrides it with a local build (sibling
// checkout's src/client/ramphastos-client/dist/index.js).

const { RemoteAuthority } = await import("../libs/session-backend/src/RemoteAuthority.ts");
const { RemoteBackend } = await import("../libs/session-backend/src/RemoteBackend.ts");
const { scopeSessionId } = await import("../libs/session-backend/src/remoteScope.ts");
const { RamphastosSession } = await import(process.env.RAMPHASTOS_CLIENT_DIST ?? "ramphastos-client");

// Hub URL arg may be a bare base (session-host) or a full endpoint path
// (gateway /remote). Bare bases get the session-host's /ramphastos appended.
const HUB_URL = (process.argv[2] ?? "http://localhost:7682/ramphastos")
  .replace(/\/$/, "")
  .replace(/^(https?:\/\/[^/]+)$/, "$1/ramphastos");
// Optional JWT (AXN_E2E_TOKEN) — required when the hub denies anonymous
// hellos (gateway /remote). Session ids get the '<sub>/' scope the
// tenant-isolation check demands.
const TOKEN = process.env.AXN_E2E_TOKEN;
const getToken = TOKEN ? () => TOKEN : undefined;
const scoped = (id) => scopeSessionId(id, TOKEN);
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
  writes = [];
  emit(id, data) { for (const cb of this.outputCbs.get(id) ?? []) cb(data); }
  createSession(id) { this.live.add(id); setTimeout(() => this.emit(id, enc("fake$ ")), 20); return Promise.resolve(true); }
  createSubshell(id, opts) { this.live.add(id); setTimeout(() => this.emit(id, enc(`${opts.command}\nfake$ `)), 20); return Promise.resolve(true); }
  write(id, data) { this.writes.push([id, data]); this.emit(id, enc(data)); }
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
  getToken,
  backend: fake,
  meta: { kind: "desktop", window: "main" },
});
// Race order that poisoned sessions pre-fix: a viewer/controller hello to
// an unknown session id creates the session FIRST. On a client-authoritative
// hub that must claim a mirrored slot (authority_offline), not a server-
// owned session — the latter rejected the authority's attach forever
// ("server-owned — authority attach rejected").
const RACE_ID = `race-${Math.random().toString(36).slice(2, 8)}`;
const earlyViewer = new RemoteBackend({ url: HUB_URL, sessionId: RACE_ID, getToken });
await earlyViewer.ramphastosSession();
await sleep(400);
const raceAuthority = new RemoteAuthority({ url: HUB_URL, sessionId: RACE_ID, getToken, backend: fake });
await raceAuthority.start();
check("authority attaches to a viewer-claimed session",
  raceAuthority.sessionId === scoped(RACE_ID) && raceAuthority.remoteConsole.get().state === "ready",
  String(raceAuthority.remoteConsole.get().state));
await raceAuthority.stop().catch(() => {});
await earlyViewer.disconnect().catch(() => {});

await authority.start();
check("authority connected, pinned session id", authority.sessionId === scoped(SESSION_ID), String(authority.sessionId));
// Regression: the rail dot stayed gray because 'ready' fired inside
// connect() before RemoteAuthority subscribed to state changes.
check("authority console reports connected", authority.remoteConsole.get().state === "ready",
  String(authority.remoteConsole.get().state));

// reflect a locally-running session (as if restored from window state)
authority.reflectPtys([
  { id: "local-1", name: "shell", cwd: "/home/dev", kind: "session", workspaceId: "ws-a" },
  { id: "sub-1", kind: "subshell", sessionId: "local-1", command: "htop", name: "htop" },
]);
await sleep(300);

// ---- viewer attaches to the mirror: replica state visible ----
const viewer = await RamphastosSession.connect(HUB_URL, { role: "viewer", sessionId: scoped(SESSION_ID), auth: TOKEN });
const vmv = viewer.vm();
await sleep(200);
check("viewer sees mirrored session", viewer.sessionId === scoped(SESSION_ID));
check("replica has ptys collection", Array.isArray(vmv.ptys), JSON.stringify(Object.keys(vmv)));
check("replica has local pty", vmv.ptys?.some((p) => p.id === "local-1"), JSON.stringify(vmv.ptys));
check("replica marks desktop device", vmv.device === "desktop", String(vmv.device));

// ---- controller: RemoteBackend drives a remote-created PTY ----
const controller = new RemoteBackend({ url: HUB_URL, sessionId: SESSION_ID, getToken });
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

// ---- mirror ownership: a viewer must never kill a desktop PTY ----
// Attach a stream to the mirrored pty, then drop it — desktop keeps it.
controller.onOutput("local-1", () => {});
await sleep(400);
const localStream = controller.ptys.get("local-1")?.stream;
check("viewer stream attached to mirrored pty", Boolean(localStream));
localStream?.close("reload");
await sleep(400);
check("stream detach does not kill mirrored pty", !fake.closedWith.includes("local-1"),
  JSON.stringify(fake.closedWith));

// Keystrokes into a MIRRORED pty tunnel upstream the same way (re-pulls a
// fresh stream after the detach above) — the path the phone takes.
controller.write("local-1", "ping-mirror\n");
await sleep(2000);
check("viewer input reaches mirrored pty",
  fake.writes.some(([id]) => id === "local-1"), JSON.stringify(fake.writes));

// Model write-backs every viewer app issues (MirrorStateStore.save).
const hub = await controller.ramphastosSession();
const metaRes = await hub.invoke("/vm/setPtyMeta", ["local-1", null, null, "renamed-on-phone", null]);
check("setPtyMeta accepted", metaRes?.ok === true, JSON.stringify(metaRes));
const wsRes = await hub.invoke("/vm/upsertWorkspace", ["ws-a", "Renamed WS"]);
check("upsertWorkspace accepted", wsRes?.ok === true, JSON.stringify(wsRes));
const psRes = await hub.invoke("/vm/setPluginState", ["app:test", '{"k":1}']);
check("setPluginState accepted", psRes?.ok === true, JSON.stringify(psRes));
await sleep(400);
check("replica shows renamed pty",
  vmv.ptys.find((p) => p.id === "local-1")?.name === "renamed-on-phone", JSON.stringify(vmv.ptys));
check("replica carries workspace name",
  (vmv.workspaces ?? []).some((w) => w.id === "ws-a" && w.name === "Renamed WS"),
  JSON.stringify(vmv.workspaces));
check("replica carries plugin state",
  (vmv.pluginStates ?? []).some((p) => p.key === "app:test"), JSON.stringify(vmv.pluginStates));

// A remote closePty detaches a mirrored pty too — it must not reach the
// backend (the desktop owns that session's lifecycle).
controller.close("local-1");
await sleep(400);
check("remote closePty does not kill mirrored pty", !fake.closedWith.includes("local-1"),
  JSON.stringify(fake.closedWith));
check("replica drops remotely-closed mirrored pty", !vmv.ptys.some((p) => p.id === "local-1"));

// ---- authority supersede: a second authority kills the first's conn ----
// Regression: a zombie authority conn (stop() racing connect()) used to
// attach alongside the live one — the hub silently replaced
// _authorityConnId and the zombie's stale model/dead subscriptions served
// remote I/O: mirrored sessions showed ghost state and keystrokes landed
// in whatever PTY the stale ids happened to point at ("total mess").
const REPL_ID = `repl-${Math.random().toString(36).slice(2, 8)}`;
const fakeOld = new FakeBackend();
const fakeNew = new FakeBackend();
const oldAuth = new RemoteAuthority({ url: HUB_URL, sessionId: REPL_ID, getToken, backend: fakeOld });
await oldAuth.start();
oldAuth.reflectPtys([{ id: "p-shared", kind: "session", cwd: "/old" }]);
await sleep(300);
const newAuth = new RemoteAuthority({ url: HUB_URL, sessionId: REPL_ID, getToken, backend: fakeNew });
await newAuth.start();
newAuth.reflectPtys([
  { id: "p-shared", kind: "session", cwd: "/new" },
  { id: "p-new", kind: "session", cwd: "/new" },
]);
// Superseded authority keeps publishing — every patch must be dropped.
oldAuth.reflectPtys([{ id: "zombie-pty", kind: "session" }]);
await sleep(400);
const replViewer = await RamphastosSession.connect(HUB_URL, { role: "controller", sessionId: scoped(REPL_ID), auth: TOKEN });
await sleep(300);
const rvm = replViewer.vm();
check("replica reflects the live authority only",
  rvm.ptys?.some((p) => p.id === "p-new") === true, JSON.stringify(rvm.ptys));
check("superseded authority's patches are dropped",
  rvm.ptys?.some((p) => p.id === "zombie-pty") !== true, JSON.stringify(rvm.ptys?.map((p) => p.id)));

// Keystrokes route to the live authority's backend only — never the
// superseded conn's (that's how "input lands in the wrong session").
const replCtl = new RemoteBackend({ url: HUB_URL, sessionId: REPL_ID, getToken });
replCtl.onOutput("p-shared", () => {});
await replCtl.ensureStream("p-shared").catch(() => {});
await sleep(400);
replCtl.write("p-shared", "MARKER_INPUT\n");
await sleep(500);
check("input reaches the live authority's backend",
  fakeNew.writes.some(([id, d]) => id === "p-shared" && d === "MARKER_INPUT\n"),
  JSON.stringify(fakeNew.writes));
check("input never reaches the superseded authority",
  !fakeOld.writes.some(([id]) => id === "p-shared"), JSON.stringify(fakeOld.writes));

// Give the superseded conn time to (not) steal the session back — its
// client must treat authority_replaced as terminal, not reconnect.
await sleep(1500);
oldAuth.reflectPtys([{ id: "zombie-pty-2", kind: "session" }]);
await sleep(400);
check("superseded conn does not re-attach (no ping-pong)",
  rvm.ptys?.some((p) => p.id === "zombie-pty-2") !== true, JSON.stringify(rvm.ptys?.map((p) => p.id)));

await replCtl.disconnect();
await replViewer.disconnect();
await newAuth.stop();
await oldAuth.stop();

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
