// End-to-end check of RemoteBackend — the SessionBackend implementation over
// the session-host's /ramphastos hub. Runs the TypeScript source directly via
// `node --experimental-strip-types` (Node >= 22.6).
//
//   node --experimental-strip-types tests/remote-backend-e2e.mjs [baseUrl]
//
// Needs a session host running (default http://localhost:7682), e.g.
//   SESSION_HOST_PORT=7682 dotnet run --project apps/session-host -f net10.0
// 'ramphastos-client' resolves from node_modules (the published package)
// — RemoteBackend.ts finds it through libs/session-backend's own
// dependency. Scripts importing the client directly take
// RAMPHASTOS_CLIENT_DIST for a local build.

const { RemoteBackend } = await import("../libs/session-backend/src/RemoteBackend.ts");

const BASE = process.argv[2] ?? "http://localhost:7682";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : ` ${extra}`}`);
  if (!cond) failures++;
};

const backend = new RemoteBackend({ url: `${BASE}/ramphastos` });

// --- create a session PTY ---
const ptyId = "rbe2e-" + Math.random().toString(36).slice(2, 10);
const out = [];
backend.onOutput(ptyId, (d) => out.push(d));
let anyOut = [];
backend.onAnyOutput((id, d) => { if (id === ptyId) anyOut.push(d); });
const spawned = await backend.createSession(ptyId, { cols: 100, rows: 30 });
check("createSession spawned=true", spawned === true);
check("sessionId assigned", typeof backend.sessionId === "string" && backend.sessionId.length > 0);
check("serverSessionId resolves", backend.serverSessionId(ptyId) === ptyId);

await sleep(300);
const text = (chunks) => new TextDecoder().decode(
  chunks.reduce((a, c) => { const b = new Uint8Array(a.length + c.length); b.set(a); b.set(c, a.length); return b; }, new Uint8Array()));

// --- IO over the pty:<id> stream ---
backend.write(ptyId, "echo remote-backend-ok\n");
await sleep(800);
check("onOutput carries echoed line", text(out).includes("remote-backend-ok"), JSON.stringify(text(out).slice(-200)));
check("onAnyOutput fires for the pty", anyOut.length > 0);

// --- queries ---
check("getDefaultShell", typeof (await backend.getDefaultShell()) === "string");
const cwd = await backend.getCwd(ptyId);
check("getCwd", typeof cwd === "string" && cwd.startsWith("/"), String(cwd));
const fg = await backend.getForegroundProcess(ptyId);
check("getForegroundProcess", fg === null || typeof fg === "string", String(fg));

// --- fs surface ---
check("writeFile", (await backend.writeFile(ptyId, "rb-marker.txt", "from-backend")).ok === true);
const rd = await backend.readFile(ptyId, "rb-marker.txt");
check("readFile round-trips", rd.ok === true && rd.contents === "from-backend", JSON.stringify(rd));
const st = await backend.statPath(ptyId, cwd ?? "/", "rb-marker.txt");
check("statPath isFile", st?.isFile === true, JSON.stringify(st));
const ls = await backend.listDir(ptyId, ".");
check("listDir includes marker", ls.some((e) => e.name === "rb-marker.txt"), JSON.stringify(ls.slice(0, 8)));
check("fsExists", (await backend.fsExists(ptyId, "rb-marker.txt")) === true);
const raw = await backend.readBytes(ptyId, "rb-marker.txt");
check("readBytes", new TextDecoder().decode(raw) === "from-backend");
await backend.mkdir(ptyId, "rb-dir");
check("mkdir", (await backend.fsExists(ptyId, "rb-dir")) === true);

// --- exec ---
const ex = await backend.exec(ptyId, "echo backend-exec-ok", cwd ?? undefined);
check("exec", ex.trim() === "backend-exec-ok", JSON.stringify(ex));
const git = await backend.execGit(ptyId, cwd ?? "/", ["--version"]);
check("execGit", git.startsWith("git version"), JSON.stringify(git));

// --- resize ---
backend.resize(ptyId, 120, 40);
await sleep(300);

// --- sub-shell: one-shot command → onSubshellExit with code ---
const subId = ptyId + "-sub";
const subExit = new Promise((resolve) => backend.onSubshellExit((id, code) => { if (id === subId) resolve(code); }));
const subOut = [];
backend.onOutput(subId, (d) => subOut.push(d));
await backend.createSubshell(subId, { parentId: ptyId, command: "echo sub-ok", cols: 80, rows: 24 });
await sleep(1000);
check("subshell ran and exited", text(subOut).includes("sub-ok"), JSON.stringify(text(subOut)));
const subCode = await Promise.race([subExit, sleep(3000).then(() => "timeout")]);
check("onSubshellExit with code", subCode === 0, String(subCode));

// --- close → session exit notification ---
const exited = new Promise((resolve) => backend.onSessionExit((id) => { if (id === ptyId) resolve(id); }));
let streamClosed = false;
backend.onSessionClosed(ptyId, () => { streamClosed = true; });
backend.close(ptyId);
await Promise.race([exited, sleep(3000)]);
check("onSessionClosed on close", streamClosed);
check("onSessionExit not fired for explicit close", await Promise.race([exited.then(() => "fired"), sleep(300).then(() => "not-fired")]) === "not-fired");

await backend.disconnect();
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
