// Shared helpers for the axn-term perf flows (flows/axn-term-perf.xml):
// launching a release binary with an isolated state dir, driving it through
// the remote-control server, sampling /proc for CPU and memory, and printing
// AXN_METRIC lines for the axn-dev flow runner.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const now = () => performance.now();
const HZ = 100; // USER_HZ

// ---------- metrics ----------

export function median(xs) {
  const s = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (s.length === 0) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function percentile(xs, p) {
  const s = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (s.length === 0) return null;
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

const round = (v, digits) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

/**
 * Print one AXN_METRIC line (collected by `axn-dev flow` into the report)
 * and a readable line. `samples` → the value is their median.
 */
export function metric(name, { value, samples, unit, better = "lower", description, digits = 1 }) {
  const clean = samples?.filter((x) => x != null && Number.isFinite(x));
  const v = value ?? (clean?.length ? median(clean) : null);
  if (v == null || !Number.isFinite(v)) {
    console.log(`  ${name}: n/a`);
    return;
  }
  // better: "lower" | "higher" | "none" (informational — compare shows Δ without a verdict)
  const payload = { name, value: round(v, digits), unit, ...(better === "none" ? {} : { better }) };
  if (clean && clean.length > 1) payload.samples = clean.map((x) => round(x, digits));
  if (description) payload.description = description;
  console.log(`AXN_METRIC ${JSON.stringify(payload)}`);
  const spread = clean && clean.length > 1 ? ` (${round(Math.min(...clean), digits)}–${round(Math.max(...clean), digits)}, n=${clean.length})` : "";
  process.stderr.write(`  ${name}: ${payload.value}${unit ? ` ${unit}` : ""}${spread}\n`);
}

export function meta(obj) {
  console.log(`AXN_META ${JSON.stringify(obj)}`);
}

// ---------- binary / config ----------

export function binaryPath() {
  const b = process.env.AXN_TERM_BINARY ?? "target/release/axn-term";
  let p = isAbsolute(b) ? b : resolve(REPO, b);
  // A bare binary cannot host WKWebView on macOS (the web content process
  // dies at window creation) — use the bundled .app binary next to it.
  if (process.platform === "darwin" && existsSync(p)) {
    const bundled = join(dirname(p), "bundle/macos/axn-term.app/Contents/MacOS/axn-term");
    if (existsSync(bundled)) p = bundled;
  }
  if (!existsSync(p)) {
    throw new Error(`axn-term binary not found: ${p} — build it (pnpm tauri build --no-bundle) or set AXN_TERM_BINARY`);
  }
  return p;
}

/** Run count for an action: the step's `runs`, scaled down by AXN_PERF_QUICK. */
export function runCount(step, fallback) {
  const n = Number(step.args?.runs ?? fallback);
  if (process.env.AXN_PERF_RUNS) return Math.max(1, Number(process.env.AXN_PERF_RUNS));
  if (process.env.AXN_PERF_QUICK === "1") return Math.max(1, Math.ceil(n / 3));
  return n;
}

/** Big generated input files live next to the reports (gitignored). */
export function dataDir() {
  const dir = join(REPO, "flows/.reports/perf-data");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------- /proc sampling ----------

// On macOS there is no /proc: `ps` gives the same numbers. WebKit's helper
// processes are XPC services parented to launchd, not children of the app, so
// they are told apart by pid: the ones that appeared after the app started
// are its own (see `snapshotWebKit` in `launch`) — keep the machine quiet of
// other WebKit apps while a run is going.
const IS_DARWIN = process.platform === "darwin";
const webkitBaseline = new Map(); // app pid → pids that existed before it started

function psTable() {
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,cputime=,rss=,comm="], { encoding: "utf8", maxBuffer: 16 << 20 });
  const rows = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d:.]+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const t = m[3].split(":").map(Number);
    const cpu = t.reduce((acc, v) => acc * 60 + v, 0);
    rows.push({ pid: +m[1], ppid: +m[2], cpu, rss: +m[4], comm: m[5].split("/").pop(), path: m[5] });
  }
  return rows;
}

export function snapshotWebKit() {
  return new Set(psTable().filter((r) => r.path.includes("com.apple.WebKit.")).map((r) => r.pid));
}

function readStat(pid) {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8");
    const r = s.lastIndexOf(")");
    const comm = s.slice(s.indexOf("(") + 1, r);
    const f = s.slice(r + 2).split(" ");
    return { pid, comm, ppid: +f[1], cpu: (+f[11] + +f[12]) / HZ };
  } catch {
    return null;
  }
}

function rssKb(pid) {
  try {
    const m = readFileSync(`/proc/${pid}/status`, "utf8").match(/VmRSS:\s+(\d+)/);
    return m ? +m[1] : 0;
  } catch {
    return 0;
  }
}

// The app's own processes: the binary plus WebKit helpers — not the shells
// it hosts.
const SHELLISH = new Set(["bash", "sh", "cat", "seq", "printf", "axn-login-shel", "env", "sleep", "ps", "head", "tr", "fold"]);
function appProcs(rootPid) {
  if (IS_DARWIN) return appProcsDarwin(rootPid);
  const all = [];
  for (const d of readdirSync("/proc")) {
    if (/^\d+$/.test(d)) {
      const st = readStat(+d);
      if (st) all.push(st);
    }
  }
  const kids = new Map();
  for (const p of all) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p);
  }
  const out = [];
  const walk = (pid) => {
    for (const c of kids.get(pid) ?? []) {
      if (SHELLISH.has(c.comm)) continue;
      out.push(c);
      walk(c.pid);
    }
  };
  const root = all.find((p) => p.pid === rootPid);
  if (root) out.push(root);
  walk(rootPid);
  return out;
}

function appProcsDarwin(rootPid) {
  const rows = psTable();
  const before = webkitBaseline.get(rootPid) ?? new Set();
  const out = [];
  const kids = new Map();
  for (const r of rows) {
    if (!kids.has(r.ppid)) kids.set(r.ppid, []);
    kids.get(r.ppid).push(r);
  }
  const walk = (pid) => {
    for (const c of kids.get(pid) ?? []) {
      if (SHELLISH.has(c.comm) || c.comm.startsWith("-")) continue;
      out.push(c);
      walk(c.pid);
    }
  };
  const root = rows.find((r) => r.pid === rootPid);
  if (root) out.push(root);
  walk(rootPid);
  for (const r of rows) {
    if (r.path.includes("com.apple.WebKit.") && !before.has(r.pid)) out.push(r);
  }
  return out;
}

const kindOf = (p, rootPid) =>
  p.pid === rootPid ? "main" : /WebKit\.WebContent|^WebKitWeb/.test(p.comm) ? "web" : /WebKit\.Networking|^WebKitNet/.test(p.comm) ? "net" : /WebKit\.GPU|^WebKitGPU/.test(p.comm) ? "gpu" : "other";

/** CPU seconds so far, per process kind (main = the app binary, web = WebKit content). */
export function cpuByKind(rootPid) {
  const o = { main: 0, web: 0, net: 0, gpu: 0, other: 0 };
  for (const p of appProcs(rootPid)) o[kindOf(p, rootPid)] += p.cpu;
  return o;
}

/** CPU seconds of the shells (and their children) the app hosts — the cost of starting them. */
export function shellCpu(rootPid) {
  if (IS_DARWIN) {
    const rows = psTable();
    const kids = new Map();
    for (const r of rows) {
      if (!kids.has(r.ppid)) kids.set(r.ppid, []);
      kids.get(r.ppid).push(r);
    }
    let total = 0;
    const walk = (pid) => {
      for (const c of kids.get(pid) ?? []) {
        total += c.cpu;
        walk(c.pid);
      }
    };
    walk(rootPid);
    return total;
  }
  const all = [];
  for (const d of readdirSync("/proc")) if (/^\d+$/.test(d)) { const st = readStat(+d); if (st) all.push(st); }
  const kids = new Map();
  for (const p of all) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p);
  }
  let total = 0;
  const walk = (pid) => { for (const c of kids.get(pid) ?? []) { if (SHELLISH.has(c.comm)) total += c.cpu; walk(c.pid); } };
  walk(rootPid);
  return total;
}

export const sumCpu = (o) => Object.values(o).reduce((a, b) => a + b, 0);

/** Resident memory in MB for the app and its WebKit helpers. */
export function rssMb(rootPid) {
  let kb = 0;
  for (const p of appProcs(rootPid)) kb += IS_DARWIN ? p.rss : rssKb(p.pid);
  return kb / 1024;
}

/** Wait until the app goes quiet (< pct % of one core over `win` ms); returns ms until then. */
export async function waitIdle(pid, { win = 400, pct = 4, max = 120000 } = {}) {
  const t = now();
  let prev = sumCpu(cpuByKind(pid));
  let prevT = now();
  while (now() - t < max) {
    await sleep(win);
    const c = sumCpu(cpuByKind(pid));
    const ct = now();
    if (((c - prev) / ((ct - prevT) / 1000)) * 100 < pct) return prevT - t;
    prev = c;
    prevT = ct;
  }
  return null;
}

/** Average CPU % of one core over `ms`, total and per kind. */
export async function idleCpu(pid, ms) {
  const a = cpuByKind(pid);
  await sleep(ms);
  const b = cpuByKind(pid);
  const o = {};
  for (const k of Object.keys(a)) o[k] = ((b[k] - a[k]) / (ms / 1000)) * 100;
  o.total = Object.values(o).reduce((x, y) => x + y, 0);
  return o;
}

// ---------- launching ----------

async function freePort() {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

const live = new Set();
process.on("exit", () => {
  for (const c of live) {
    try {
      c.kill("SIGKILL");
    } catch { /* gone */ }
  }
});

/**
 * Restore state: `sessions` sessions over two workspaces, each with 200 KB
 * of saved output, the first or last one selected.
 */
function restoreState(stateDir, sessions, select) {
  const ws = [{ id: "ws-a", name: "alpha" }, { id: "ws-b", name: "beta" }];
  const line = "\x1b[32mok\x1b[0m  compiled src/module/file.ts in 12ms \x1b[2m(cached)\x1b[0m\r\n";
  const scroll = line.repeat(Math.floor(200_000 / line.length));
  const list = [];
  for (let i = 0; i < sessions; i++) {
    list.push({ id: randomUUID(), workspaceId: ws[i % 2].id, name: `s${i}`, topic: `s${i}`, summary: "", output: scroll, cwd: stateDir });
  }
  const target = select === "last" ? list[list.length - 1] : list[0];
  writeFileSync(join(stateDir, "state.json"), JSON.stringify({
    windows: [{ id: "main", name: "main", workspaces: ws, sessions: list, selectedWorkspaceId: target.workspaceId, selectedSessionId: target.id }],
  }));
  return target.id;
}

let loopsPerMs;
/** How many iterations of a `while ((i<N)); do ((i++)); done` loop /bin/bash runs per ms of CPU. */
function bashLoopsPerMs() {
  if (loopsPerMs) return loopsPerMs;
  const n = 300000;
  const t = now();
  execFileSync("/bin/bash", ["--noprofile", "--norc", "-c", `i=0; while ((i<${n})); do ((i++)); done`]);
  loopsPerMs = n / Math.max(1, now() - t - 8); // minus the process start
  return loopsPerMs;
}

/**
 * Launch the app and wait for its first prompt. Returns timing marks (ms
 * from spawn): health (Rust up, control server listening), window (webview
 * window exists), shell (selected session's PTY spawned), prompt (its first
 * prompt reached Rust), allShells (every restored session spawned).
 */
export async function launch({ restore = 0, select = "first", trace = false, bannerKb = 0, rcCpuMs = 0, config = "" } = {}) {
  const runsDir = join(tmpdir(), "axn-term-perf");
  mkdirSync(runsDir, { recursive: true });
  const stateDir = mkdtempSync(join(runsDir, "s-"));
  const binDir = join(stateDir, "bin");
  mkdirSync(binDir);
  // Plain bash with a fixed prompt: keeps the user's dotfiles out of timings.
  if (bannerKb > 0 || rcCpuMs > 0) {
    // A shell that prints `bannerKb` KB of coloured lines before its first
    // prompt — what a restored session's start-up looks like (rc output, a
    // resumed agent redrawing its history).
    // `rcCpuMs`: CPU burnt in the rc before the first prompt (what a heavy
    // .zshrc — nvm, completions, prompt themes — costs every login shell).
    const burn = rcCpuMs > 0
      ? `i=0; while ((i < ${Math.round(rcCpuMs * bashLoopsPerMs())})); do ((i++)); done\n`
      : "";
    writeFileSync(join(binDir, "rc"),
      burn + (bannerKb > 0
        ? `yes "$(printf '\\033[32mok\\033[0m  compiled src/module/file.ts in 12ms \\033[2m(cached)\\033[0m')" | head -n ${Math.ceil((bannerKb * 1024) / 70)}\n`
        : ""));
    writeFileSync(join(binDir, "axn-login-shell"),
      `#!/bin/sh\nexec env PS1='AXNREADY$ ' /bin/bash --noprofile --rcfile "${join(binDir, "rc")}" "$@"\n`, { mode: 0o755 });
  } else {
    writeFileSync(join(binDir, "axn-login-shell"),
      `#!/bin/sh\nexec env PS1='AXNREADY$ ' /bin/bash --noprofile --norc "$@"\n`, { mode: 0o755 });
  }
  if (config) writeFileSync(join(stateDir, "config.yaml"), config);
  const target = restore > 0 ? restoreState(stateDir, restore, select) : undefined;
  const traceFile = trace ? join(stateDir, "perf-trace.jsonl") : undefined;

  const port = await freePort();
  const token = randomBytes(24).toString("hex");
  const base = `http://127.0.0.1:${port}`;
  const rc = (path, init = {}) =>
    fetch(base + path, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` } });
  const webkitBefore = IS_DARWIN ? snapshotWebKit() : undefined;
  const logFd = openSync(join(stateDir, "axn-term.log"), "a");
  const spawnEpoch = Date.now();
  const t0 = now();
  const child = spawn(binaryPath(), [], {
    env: {
      ...process.env,
      AXN_TERM_STATE_DIR: stateDir,
      AXN_TERM_REMOTE_CONTROL_PORT: String(port),
      AXN_TERM_REMOTE_CONTROL_TOKEN: token,
      PATH: `${binDir}:${process.env.PATH}`,
      SHELL: join(binDir, "axn-login-shell"),
      WEBKIT_DISABLE_DMABUF_RENDERER: "1",
      ...(traceFile ? { AXN_TERM_PERF_TRACE: traceFile } : {}),
    },
    stdio: ["ignore", logFd, logFd],
  });
  if (webkitBefore) webkitBaseline.set(child.pid, webkitBefore);
  live.add(child);
  let exited = false;
  child.on("exit", () => {
    exited = true;
    live.delete(child);
  });

  const marks = {};
  const deadline = t0 + 60000;
  const until = async (name, fn) => {
    while (now() < deadline) {
      if (exited) throw new Error(`axn-term exited before '${name}' — see ${join(stateDir, "axn-term.log")}`);
      try {
        const v = await fn();
        if (v) {
          marks[name] = now() - t0;
          return v;
        }
      } catch { /* not yet */ }
      await sleep(5);
    }
    throw new Error(`timeout waiting for '${name}'`);
  };
  const app = { child, pid: child.pid, rc, marks, stateDir, traceFile, spawnEpoch, t0, isExited: () => exited };
  try {
    await until("health", async () => (await fetch(base + "/health", { signal: AbortSignal.timeout(500) })).ok);
    await until("window", async () => (await (await rc("/windows")).json()).length > 0);
    app.sid = await until("shell", async () => {
      const ids = await (await rc("/sessions")).json();
      return target ? ids.find((i) => i === target) : ids[0];
    });
    app.output = async () => {
      const t = await (await rc(`/sessions/${app.sid}`)).text();
      try {
        return JSON.parse(t).output ?? "";
      } catch {
        return "";
      }
    };
    await until("prompt", async () => (await app.output()).includes("AXNREADY$"));
    if (restore > 0) {
      await until("allShells", async () => (await (await rc("/sessions")).json()).length >= restore);
    }
  } catch (e) {
    await close(app);
    throw e;
  }
  return app;
}

/** Type into the selected session's PTY (remote-control write). */
export async function write(app, text) {
  await app.rc(`/sessions/${app.sid}/write`, { method: "POST", body: JSON.stringify({ text }) });
}

/** Poll the Rust-side output tail until it contains `marker`; ms waited, or null. */
export async function waitForOutput(app, marker, max = 180000) {
  const t = now();
  while (now() - t < max) {
    if ((await app.output()).includes(marker)) return now() - t;
    await sleep(20);
  }
  return null;
}

export async function close(app) {
  try {
    await app.rc("/close", { method: "POST" });
  } catch { /* already gone */ }
  const t = now();
  while (!app.isExited() && now() - t < 15000) await sleep(50);
  if (!app.isExited()) {
    app.child.kill("SIGKILL");
    await sleep(300);
  }
  rmSync(app.stateDir, { recursive: true, force: true });
}

export function readTrace(app) {
  if (!app.traceFile || !existsSync(app.traceFile)) return [];
  return readFileSync(app.traceFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function fileSize(p) {
  try {
    return statSync(p).size;
  } catch {
    return null;
  }
}
