import { spawn, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const procs = new Map();
// Conversation id the fake claude prints in its exit hint.
const FAKE_CLAUDE_ID = "7f3c2a10-5b9e-4d21-8c6f-0a1b2c3d4e5f";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function baseUrl(env) {
  const port = env.AXN_TERM_REMOTE_CONTROL_PORT;
  return `http://127.0.0.1:${port}`;
}

/**
 * fetch() against the app's remote-control server. The server requires the
 * per-run bearer token (AXN_TERM_REMOTE_CONTROL_TOKEN, generated in
 * prepare) on every endpoint but /health.
 */
function rc(env, path, init = {}) {
  return fetch(`${baseUrl(env)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.AXN_TERM_REMOTE_CONTROL_TOKEN}`,
      ...(init.headers ?? {}),
    },
  });
}

/** Last `count` lines of the app log in the state dir, for error reports. */
function logTail(env, count = 30) {
  const path = join(env.AXN_TERM_STATE_DIR, "axn-term.log");
  try {
    const lines = readFileSync(path, "utf8").trimEnd().split("\n").slice(-count);
    return `last ${lines.length} lines of ${path}:\n${lines.join("\n")}`;
  } catch (error) {
    return `no log at ${path}: ${error.message}`;
  }
}

/**
 * Fail when the app log shows a React error boundary: the window then shows
 * the crash screen, not the app. `logPath` overrides the state-dir log.
 */
export function assertNoErrorBoundary(env, where, logPath) {
  const path = logPath ?? join(env.AXN_TERM_STATE_DIR, "axn-term.log");
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  const at = text.indexOf("[error-boundary]");
  if (at < 0) return;
  const lineStart = text.lastIndexOf("\n", at) + 1;
  const excerpt = text.slice(lineStart).split("\n").slice(0, 8).join("\n");
  throw new Error(`axn-term hit its error boundary (${where}) — see ${path}:\n${excerpt}`);
}

async function waitForHealth(env, child, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // A crashed app would otherwise surface only as an opaque
    // "fetch failed" once the timeout ran out.
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      const how = child.signalCode ? `signal ${child.signalCode}` : `exit code ${child.exitCode}`;
      throw new Error(`axn-term exited before becoming healthy (${how}); ${logTail(env)}`);
    }
    try {
      const res = await rc(env, "/health", { signal: AbortSignal.timeout(1500) });
      if (res.ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`axn-term remote control server did not become ready; ${logTail(env)}`);
}

async function getSessions(env) {
  const res = await rc(env, "/sessions");
  if (!res.ok) throw new Error(`GET /sessions failed: ${res.status}`);
  return res.json();
}

async function getWindows(env) {
  const res = await rc(env, "/windows");
  if (!res.ok) throw new Error(`GET /windows failed: ${res.status}`);
  return res.json();
}

function getExpectedWindowCount(env) {
  const statePath = join(env.AXN_TERM_STATE_DIR, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  return (state.windows ?? []).length;
}

async function waitForWindowCount(env, expected, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const windows = await getWindows(env);
    if (windows.length >= expected) return windows;
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${expected} windows`);
}

async function getSessionOutput(env, sessionId) {
  const res = await rc(env, `/sessions/${sessionId}`);
  if (!res.ok) throw new Error(`GET /sessions/${sessionId} failed: ${res.status}`);
  // A not-yet-spawned PTY answers 200 with plain text ("session x not
  // found") — treat it as empty output so callers can keep polling.
  const data = await res.json().catch(() => null);
  return data?.output ?? "";
}

async function writeToSession(env, sessionId, text) {
  const res = await rc(env, `/sessions/${sessionId}/write`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`POST /sessions/${sessionId}/write failed: ${res.status}`);
}

/**
 * Submit a whole input line through the frontend's hidden/plugin command
 * dispatch (axn-*, plugin commands) — unlike /write this is not raw PTY
 * input.
 */
async function sendCommand(env, sessionId, line) {
  const res = await rc(env, `/sessions/${sessionId}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ line }),
  });
  if (!res.ok) throw new Error(`POST /sessions/${sessionId}/command failed: ${res.status}`);
}

async function closeRemoteApp(env) {
  const res = await rc(env, "/close", { method: "POST" });
  if (!res.ok) throw new Error(`POST /close failed: ${res.status}`);
}

async function createRemoteWindow(env) {
  const res = await rc(env, "/windows", { method: "POST" });
  if (!res.ok) throw new Error(`POST /windows failed: ${res.status}`);
  const data = await res.json();
  return data.id;
}

async function closeRemoteWindow(env, windowId) {
  const res = await rc(env, `/windows/${windowId}`, { method: "POST" });
  if (!res.ok) throw new Error(`POST /windows/${windowId} failed: ${res.status}`);
}

async function waitForOutput(env, sessionId, predicate, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const output = await getSessionOutput(env, sessionId);
    if (predicate(output)) return output;
    await sleep(250);
  }
  throw new Error("timeout waiting for output");
}

async function waitForProcessExit(child, timeoutMs = 120000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    if (child.exitCode !== 0) throw new Error(`axn-term exited unexpectedly: ${child.signalCode ?? child.exitCode}`);
    return child.exitCode;
  }
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting for axn-term process exit")), timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(t);
      if (code === 0) resolve(code);
      else reject(new Error(`axn-term exited unexpectedly: ${signal ?? code}`));
    });
  });
}

function getTargetSessionId(env) {
  const statePath = join(env.AXN_TERM_STATE_DIR, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  for (const w of state.windows ?? []) {
    const selectedId = w.selectedSessionId;
    if (selectedId) return selectedId;
    for (const s of w.sessions ?? []) {
      if (s.pluginState?.devin?.devinSessionName) return s.id;
    }
  }
  return undefined;
}

/**
 * A flow started from inside a Claude Code session inherits that session's
 * CLAUDE_CODE_* / CLAUDECODE variables. A real claude launched in the app then
 * believes it is a child session: it writes no transcript and prints no
 * resume hint — nothing like the user's own terminals. Drop them.
 */
function withoutParentAgentEnv(source) {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => key !== "CLAUDECODE" && !key.startsWith("CLAUDE_CODE_") && key !== "CLAUDE_PID"),
  );
}

async function startApp(env) {
  const stateDir = env.AXN_TERM_STATE_DIR;
  if (!stateDir) throw new Error("AXN_TERM_STATE_DIR not set");

  let binary = env.AXN_TERM_BINARY && isAbsolute(env.AXN_TERM_BINARY)
    ? resolve(env.AXN_TERM_BINARY)
    : resolve(__dirname, "../..", env.AXN_TERM_BINARY ?? "target/release/axn-term");
  // A bare binary cannot host WKWebView on macOS — the web content process
  // dies at window creation and the frontend never runs. Prefer the bundled
  // .app binary from the same target dir when one exists.
  if (process.platform === "darwin" && existsSync(binary)) {
    const bundled = join(
      dirname(binary),
      "bundle/macos/axn-term.app/Contents/MacOS/axn-term",
    );
    if (existsSync(bundled)) binary = bundled;
  }
  if (!existsSync(binary)) throw new Error(`axn-term binary not found: ${binary}`);

  const binDir = join(stateDir, "bin");
  const shellShim = join(binDir, "axn-login-shell");
  // Spawn detached with output going to a log file: when the flow runner
  // executes each step in its own subprocess (AXN_STEP protocol), the app
  // must keep running after the step's process exits.
  const logFd = openSync(join(stateDir, "axn-term.log"), "a");
  const child = spawn(binary, [], {
    env: {
      ...withoutParentAgentEnv(process.env),
      AXN_TERM_STATE_DIR: stateDir,
      AXN_TERM_REMOTE_CONTROL_PORT: env.AXN_TERM_REMOTE_CONTROL_PORT,
      AXN_TERM_REMOTE_CONTROL_TOKEN: env.AXN_TERM_REMOTE_CONTROL_TOKEN,
      LOG_LEVEL: "debug",
      PATH: `${binDir}:${process.env.PATH}`,
      // Agent hook installs write here instead of the user's ~/.claude etc.
      ...(env.AXN_TERM_AGENT_CONFIG_ROOT ? { AXN_TERM_AGENT_CONFIG_ROOT: env.AXN_TERM_AGENT_CONFIG_ROOT } : {}),
      ...(env.AXN_TERM_SHELL_PATH
        ? { SHELL: env.AXN_TERM_SHELL_PATH }
        : existsSync(shellShim) ? { SHELL: shellShim } : {}),
      ...(env.AXN_TERM_INPUTRC ? { INPUTRC: env.AXN_TERM_INPUTRC } : {}),
      // startTestDisplay: run on the private X server instead of the user's
      // desktop (GTK would pick Wayland first while WAYLAND_DISPLAY is set).
      // The X server has no GPU buffers for WebKit's DMA-BUF renderer.
      ...(env.AXN_TERM_TEST_DISPLAY ? { ...testDisplayEnv(env), WEBKIT_DISABLE_DMABUF_RENDERER: "1" } : {}),
    },
    stdio: ["ignore", logFd, logFd],
    detached: true,
  });
  child.unref();
  procs.set(stateDir, child);

  await waitForHealth(env, child);

  const expectedWindows = getExpectedWindowCount(env);
  await waitForWindowCount(env, expectedWindows);

  const target = env.AXN_TERM_SESSION_ID ?? getTargetSessionId(env);
  const start = Date.now();
  let sessionId;
  while (Date.now() - start < 60000) {
    const sessions = await getSessions(env);
    if (target) {
      sessionId = sessions.find((id) => id === target);
    } else {
      sessionId = sessions[0];
    }
    if (sessionId) break;
    // A crashed frontend never creates sessions; fail now, not after 60 s.
    try {
      assertNoErrorBoundary(env, "app start");
    } catch (error) {
      try { process.kill(-child.pid); } catch { /* already gone */ }
      throw error;
    }
    if (Date.now() - start > 5000 && (Date.now() - start) % 3000 < 200) {
      process.stderr.write(`[axnTerm] waiting for session, target=${target}, have=${JSON.stringify(sessions)}\n`);
    }
    await sleep(200);
  }
  if (!sessionId) {
    // The frontend creates the sessions. A plain `cargo build` binary loads
    // the Vite dev URL instead of embedded assets, so without `pnpm dev`
    // running no frontend ever starts and the session list stays empty.
    throw new Error(
      `no axn-term session appeared (target=${target}) — is ${binary} a \`tauri build\` binary ` +
        `(plain cargo builds load the dev server URL)? ${logTail(env)}`,
    );
  }

  // Give the new window(s) a moment to mount their listeners so remote events
  // like close-now / close-window are actually received.
  await sleep(1000);
  env.AXN_TERM_SESSION_ID = sessionId;
  assertNoErrorBoundary(env, "app start");
  return sessionId;
}

async function closeApp(env) {
  const stateDir = env.AXN_TERM_STATE_DIR;
  const child = procs.get(stateDir);
  await closeRemoteApp(env);
  if (child) {
    await waitForProcessExit(child);
    procs.delete(stateDir);
    assertNoErrorBoundary(env, "app close");
    return;
  }
  // Subprocess mode: the app was started by an earlier step's process, so its
  // child handle is not in this process. Wait until the remote-control server
  // stops answering, which means the app has exited.
  const start = Date.now();
  while (Date.now() - start < 30000) {
    try {
      await rc(env, "/health", { signal: AbortSignal.timeout(1000) });
    } catch {
      assertNoErrorBoundary(env, "app close");
      return;
    }
    await sleep(200);
  }
  throw new Error("axn-term did not exit after /close");
}

// The command a git-inspect "Talk about this" tab persists — `devin --
// "<prompt>"` seeded interactively, then a login shell keeps the tab usable.
function talkSeedCommand() {
  const prompt = "Talk about commit abc123 — explain the diff";
  const b64 = Buffer.from(prompt, "utf8").toString("base64");
  return `devin -- "$(printf %s '${b64}' | base64 -d)"; exec "\${SHELL:-sh}" -l`;
}

function buildInitialState(stateDir, cwd, variant, devinSessionName) {
  const sessionId = randomUUID();
  const workspaceId1 = `ws-${sessionId.slice(0, 8)}`;
  const workspaceId2 = `ws-${sessionId.slice(9, 17)}`;
  const devinSession = {
    id: sessionId,
    workspaceId: workspaceId1,
    name: "devin",
    topic: "devin",
    summary: "restore test",
    // Retained scrollback from a previous devin run, capped at 200k chars.
    // The stale resume hint must never be picked up as the current name —
    // only output produced after the current process' exit is valid.
    output:
      " devin -r historical-session\n resumes this session · devin -r lists recent sessions\n" +
      "x".repeat(200_000),
    cwd,
    pluginState: {
      devin: {
        devinSessionName: devinSessionName ?? "green-aurora",
        devinSessionCwd: cwd,
        // devin was running when the app last closed — restore requires it.
        devinActive: true,
      },
    },
  };

  if (variant === "shell" || variant === "input" || variant === "git-restore") {
    // Just a shell at its prompt — for flows that type into the terminal.
    devinSession.name = "shell";
    devinSession.topic = "shell";
    devinSession.pluginState = undefined;
    devinSession.output = "";
  }

  if (variant === "claude-title") {
    // A plain shell for REAL claude: the flow launches it, names the
    // conversation with /rename and exits — the resume record must carry
    // that name although claude clears its terminal title on exit. A stable
    // scratch folder, so claude's trust prompt is answered once, not per run.
    const flowCwd = join(tmpdir(), "axn-term-flow-claude");
    mkdirSync(flowCwd, { recursive: true });
    devinSession.name = "shell";
    devinSession.topic = "shell";
    devinSession.cwd = flowCwd;
    devinSession.pluginState = undefined;
    devinSession.output = "";
  }

  if (variant === "worktrees" || variant === "mr-review") {
    // A plain shell session in a real git repo — the worktrees plugin's
    // playground. No devin/pluginState; the nudge test drives a fake devin
    // via /sessions/<id>/write later.
    devinSession.name = "main";
    devinSession.topic = "main";
    devinSession.pluginState = undefined;
    devinSession.output = "";
  }

  if (variant === "claude") {
    // A plain shell session that previously ran claude in another
    // conversation — the flow launches a fresh `claude`, which must
    // invalidate the stale id, and the close-time capture must record the
    // new one. The retained scrollback carries a stale hint that must never
    // be picked up.
    devinSession.name = "claude";
    devinSession.topic = "claude";
    devinSession.output =
      "Resume this session with:\nclaude --resume historical-claude-id\n" + "x".repeat(200_000);
    devinSession.pluginState = {
      claude: { claudeSeen: true, claudeCwd: cwd, claudeResumeId: "historical-claude-id" },
    };
  }

  if (variant === "hardening") {
    // A plain shell plus an interactive sub-shell tab (active, so it spawns
    // at start) — both later run the fake hook-emitting claude.
    devinSession.name = "harden";
    devinSession.topic = "harden";
    devinSession.pluginState = undefined;
    devinSession.output = "";
    devinSession.editors = [{ id: "hook-tab", path: "", kind: "shell", cwd, label: "tab agent" }];
    devinSession.activeTab = "hook-tab";
  }

  if (variant === "talk-tab") {
    // A session with a git-inspect "talk" sub-shell tab — the tab is active
    // so it spawns immediately on app start. No session-level devin state:
    // the tab's resume bookkeeping lives on the editor record itself.
    devinSession.pluginState = undefined;
    devinSession.output = "";
    devinSession.editors = [
      {
        id: "talk-tab-1",
        path: "",
        kind: "shell",
        command: talkSeedCommand(),
        cwd,
        label: "devin: talk test",
        agent: "devin",
      },
    ];
    devinSession.activeTab = "talk-tab-1";
  }

  const mainWindow = {
    id: "main",
    name: "main",
    workspaces: [
      { id: workspaceId1, name: "axn-term" },
      // An empty second workspace: a target for dragging the session row.
      ...(variant === "shell" ? [{ id: workspaceId2, name: "extra" }] : []),
    ],
    sessions: [devinSession],
    selectedWorkspaceId: workspaceId1,
    selectedSessionId: sessionId,
  };

  if (variant === "broadcast") {
    // Two bare shells in one workspace — the multiselect/broadcast set.
    devinSession.name = "one";
    devinSession.topic = "one";
    devinSession.pluginState = undefined;
    devinSession.output = "";
    mainWindow.sessions.push({
      id: randomUUID(),
      workspaceId: workspaceId1,
      name: "two",
      topic: "two",
      output: "",
      cwd,
    });
  }

  if (variant === "second-workspace") {
    const extraWorkspace = { id: workspaceId2, name: "extra" };
    devinSession.workspaceId = workspaceId2;
    mainWindow.workspaces = [
      { id: workspaceId1, name: "first" },
      extraWorkspace,
    ];
    mainWindow.sessions = [devinSession];
    mainWindow.selectedWorkspaceId = workspaceId2;
    mainWindow.selectedSessionId = sessionId;
  }

  if (variant === "multi-window") {
    return {
      windows: [
        mainWindow,
        {
          id: "extra",
          name: "extra",
          workspaces: [{ id: workspaceId2, name: "extra" }],
          sessions: [],
          selectedWorkspaceId: workspaceId2,
          selectedSessionId: undefined,
        },
      ],
    };
  }

  return { windows: [mainWindow] };
}

async function prepare(env) {
  if (env.AXN_TERM_USE_REAL_DEVIN === "true" && !env.AXN_TERM_DEVIN_SESSION && !env.AXN_TERM_DEVIN_SESSIONS
      && (env.AXN_TERM_TEST_VARIANT ?? "single") !== "shell") {
    throw new Error("Set AXN_TERM_DEVIN_SESSION to an available real Devin session before running this flow");
  }
  const variant = env.AXN_TERM_TEST_VARIANT ?? "single";
  delete env.AXN_TERM_SHELL_PATH;
  delete env.AXN_TERM_INPUTRC;
  // A flow run inside axn-term inherits the app's own AXN_TERM_STATE_DIR
  // (~/.axn-term) — writing the test state.json/plugins.yaml there would
  // clobber the user's real config. An explicit state dir must be new.
  if (env.AXN_TERM_STATE_DIR && existsSync(env.AXN_TERM_STATE_DIR)) {
    throw new Error(
      `AXN_TERM_STATE_DIR=${env.AXN_TERM_STATE_DIR} already exists — refusing to overwrite it ` +
        "(unset it, e.g. `env -u AXN_TERM_STATE_DIR axn-dev flow …`, to use a temp dir)",
    );
  }
  const stateDir = env.AXN_TERM_STATE_DIR ?? mkdtempSync(join("/tmp", "axn-term-restore-"));
  if (env.AXN_TERM_STATE_DIR) mkdirSync(stateDir, { recursive: true });
  env.AXN_TERM_STATE_DIR = stateDir;
  env.AXN_TERM_TEST_VARIANT = variant;

  const port = env.AXN_TERM_REMOTE_CONTROL_PORT ?? (await findFreePort());
  env.AXN_TERM_REMOTE_CONTROL_PORT = String(port);
  // The app refuses to start its remote-control server without a token.
  env.AXN_TERM_REMOTE_CONTROL_TOKEN = randomBytes(32).toString("hex");

  const binDir = join(stateDir, "bin");
  const cwdDir = join(stateDir, "cwd");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(cwdDir, { recursive: true });
  // A marker file so `axn-broadcast ls` output is verifiable in both PTYs.
  const bcastMark = `bcast-mark-${randomBytes(3).toString("hex")}.txt`;
  writeFileSync(join(cwdDir, bcastMark), "mark\n");
  env.AXN_TERM_BCAST_MARK = bcastMark;

  const useRealDevin = env.AXN_TERM_USE_REAL_DEVIN === "true";
  if (!useRealDevin) {
    const fakeDevin = join(binDir, "devin");
    // A /bin/sh script: foreground-process detection unwraps interpreter
    // argv (`sh /path/devin` → "devin"), while a python3 script reports
    // "Python" on macOS and the devin plugin would never see it as devin.
    writeFileSync(
      fakeDevin,
      `#!/bin/sh
# Real devin prints a short resume banner at start; the two-line resume
# hint is printed ONLY when the session ends (Ctrl-C or /exit) — never at
# startup.
case "$1" in
  -r) echo "Resuming devin session: \${2:-unknown}" ;;
  -c|--continue) echo "Continuing devin session: gray-party" ;;
  -p) echo "explanation text"; exit 0 ;;
  --) echo "SEEDED TALK SESSION" ;;
  # Like a real TUI, devin queries the terminal's colors at start — then
  # exits fast, before the raw-mode gate can release xterm's reply. The
  # reply must be dropped at the bare shell, never echoed as text.
  --osc-exit) printf '\\033]10;?\\007\\033]11;?\\007\\033]12;?\\007'; echo "devin interactive"; exit 0 ;;
  # Same queries and stays alive — like real devin a raw-mode reader sends
  # ESC]10;? ESC]11;? ESC[c and stops at the DA1 answer (its sentinel);
  # a color reply arriving after it is printed as typed input. Run as a
  # child, not exec'd, so the foreground comm stays "devin".
  --osc) python3 "$(dirname "$0")/devin-osc-probe.py"; echo "devin interactive" ;;
  *) echo "devin interactive" ;;
esac

stop() {
  # The session the user ends in may differ from the launch name (an
  # in-devin session switch); devin reports the final session on exit.
  echo " devin -r gray-party"
  echo " resumes this session · devin -r lists recent sessions"
  exit 0
}
trap stop INT

while IFS= read -r line; do
  [ "$(printf '%s' "$line" | tr -d '\\r')" = "/exit" ] && stop
done
`,
      { mode: 0o755 },
    );
    // devin's startup color probe, captured from devin in a PTY: OSC 10/11
    // queries followed by DA1. Replies before the DA1 answer are consumed;
    // anything after it lands in devin's input field as text — the leak a
    // DA1 reply overtaking an OSC reply (async alive probe) produced.
    writeFileSync(
      join(binDir, "devin-osc-probe.py"),
      String.raw`import os, re, select, sys, termios, time, tty
fd = sys.stdin.fileno()
saved = termios.tcgetattr(fd)
tty.setraw(fd)
try:
    os.write(sys.stdout.fileno(), b"\x1b]10;?\x07\x1b]11;?\x07\x1b[c")
    buf = b""
    deadline = time.time() + 3
    while time.time() < deadline and not re.search(rb"\x1b\[\?[\d;]*c", buf):
        if select.select([fd], [], [], 0.05)[0]:
            buf += os.read(fd, 4096)
    parts = re.split(rb"\x1b\[\?[\d;]*c", buf, maxsplit=1)
    answered = b"11;rgb:" in parts[0]
    late = parts[1] if len(parts) > 1 else b""
    end = time.time() + 2
    while time.time() < end:
        if select.select([fd], [], [], 0.05)[0]:
            late += os.read(fd, 4096)
finally:
    termios.tcsetattr(fd, termios.TCSADRAIN, saved)
typed = re.sub(rb"[\x00-\x1f]", b"", late.replace(b"\x1b]", b"")).decode(errors="replace")
if typed:
    print("devin input: " + typed)
print("devin colors: " + ("answered" if answered else "missing"))
`,
    );
  }

  if (variant === "claude" && !env.AXN_TERM_CLAUDE_SESSION) {
    // Fake Claude Code. Real claude exits on the SECOND Ctrl-C ("Press
    // Ctrl-C again to exit") and only then prints its resume hint — the
    // exact shape below was captured from claude 2.1.303 in a PTY. A
    // /bin/sh script so foreground detection reports "claude".
    writeFileSync(
      join(binDir, "claude"),
      `#!/bin/sh
case "$1" in
  --resume|-r) echo "Resuming claude conversation: \${2:-unknown}" ;;
  -c|--continue) echo "Continuing claude conversation" ;;
  *) echo "claude interactive" ;;
esac
presses=0
interrupt() {
  presses=$((presses + 1))
  if [ "$presses" -ge 2 ]; then
    printf '\nResume this session with:\nclaude --resume ${FAKE_CLAUDE_ID}\n'
    exit 0
  fi
  echo "Press Ctrl-C again to exit"
}
trap interrupt INT
while :; do sleep 1; done
`,
      { mode: 0o755 },
    );
  }

  if (variant === "hardening") {
    // Fake Claude Code that fires real hooks through the installed
    // agent-hook.sh: a permission request immediately followed by a
    // "needs your permission" notification — one poll window apart at most.
    const configRoot = join(stateDir, "home");
    mkdirSync(configRoot, { recursive: true });
    env.AXN_TERM_AGENT_CONFIG_ROOT = configRoot;
    writeFileSync(
      join(binDir, "claude"),
      `#!/bin/sh
hook="$AXN_TERM_AGENT_CONFIG_ROOT/.axn-term/agent-hook.sh"
i=0
while [ ! -x "$hook" ] && [ $i -lt 150 ]; do sleep 0.1; i=$((i+1)); done
echo "fake claude up (hook: $hook)"
printf '{"hook_event_name":"UserPromptSubmit"}' | "$hook" claude UserPromptSubmit
sleep 4
printf '{"hook_event_name":"PermissionRequest","tool_name":"Bash"}' | "$hook" claude PermissionRequest
printf '{"hook_event_name":"Notification","message":"Claude needs your permission to use Bash"}' | "$hook" claude Notification
echo "⏺ Update Todos"
echo "  ☒ write the parser"
echo "  ☐ wire the tab"
echo "fake claude waiting for approval"
while :; do sleep 1; done
`,
      { mode: 0o755 },
    );
    // Two sandboxed plugins trying the same exec — only the one declaring
    // the permission may run it.
    for (const [id, permissions] of [["perm-none", undefined], ["perm-exec", ["exec"]]]) {
      const dir = join(stateDir, "plugins", id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "plugin.json"),
        JSON.stringify({ id, title: id, version: "0.1.0", ...(permissions ? { permissions } : {}) }),
      );
      writeFileSync(
        join(dir, "plugin.mjs"),
        `axn.on('sessionOpen', async ({ sessionId }) => {
  let result;
  try { result = 'ok:' + String(await axn.session(sessionId).exec('echo hi')).trim(); }
  catch (e) { result = 'err:' + ((e && e.message) || e); }
  await axn.session(sessionId).updateState({ result });
});
`,
      );
    }
  }

  if (variant === "input") {
    // A sandboxed plugin with an async 'line' hook: every submitted line
    // waits for its pass-through answer.
    const dir = join(stateDir, "plugins", "line-hook");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "plugin.json"),
      JSON.stringify({ id: "line-hook", title: "line-hook", version: "0.1.0", permissions: ["terminal-input"] }),
    );
    writeFileSync(
      join(dir, "plugin.mjs"),
      `axn.on('sessionOpen', ({ sessionId }) => axn.session(sessionId).updateState({ ready: true }));
axn.on('line', async ({ sessionId, line }) => {
  await axn.session(sessionId).updateState({ ready: true, lastLine: line });
  return undefined;
});
`,
    );
    // Bash without bracketed paste: a paste arrives as plain text plus \r.
    // SHELL=/bin/bash so the app sees its own shell as idle (process name
    // equals the shell name) and tracks typed lines.
    if (!existsSync("/bin/bash")) throw new Error("the input variant needs /bin/bash");
    env.AXN_TERM_SHELL_PATH = "/bin/bash";
    env.AXN_TERM_INPUTRC = join(stateDir, "inputrc");
    writeFileSync(env.AXN_TERM_INPUTRC, "set enable-bracketed-paste off\n");
  }

  // A $SHELL shim: command sub-shells (`sh -c <command>`) run with the
  // PATH captured by login_shell_path() — `$SHELL -l -i -c env` — not the
  // app's own env PATH, so the fake `devin` would otherwise be invisible.
  // The shim answers that probe with the flow's bin dir prepended and
  // delegates everything else to the real login shell.
  const realShell = process.env.SHELL && existsSync(process.env.SHELL)
    ? process.env.SHELL
    : "/bin/zsh";
  const isZsh = realShell.endsWith("zsh");
  let shimBody = `#!/bin/sh
if [ "$1" = "-l" ] && [ "$2" = "-i" ] && [ "$3" = "-c" ] && [ "$4" = "env" ]; then
  __env="$(${realShell} -l -i -c env </dev/null 2>/dev/null)"
  printf '%s\n' "$__env" | grep -v '^PATH='
  printf '%s\n' "$__env" | grep '^PATH=' | tail -n 1 | sed 's|^PATH=|PATH=${binDir}:|'
  exit 0
fi
`;
  if (isZsh) {
    // Profiles rebuild PATH (e.g. .zshrc prepends ~/.local/bin), which would
    // shadow the fake binaries — route startup through a proxy ZDOTDIR that
    // re-sources the user's real dotfiles and then re-prepends the bin dir.
    const zdotDir = join(stateDir, "zdot");
    mkdirSync(zdotDir, { recursive: true });
    for (const f of [".zshenv", ".zprofile", ".zlogin"]) {
      writeFileSync(join(zdotDir, f), `[ -f "$HOME/${f}" ] && . "$HOME/${f}"\ntrue\n`);
    }
    writeFileSync(
      join(zdotDir, ".zshrc"),
      `[ -f "$HOME/.zshrc" ] && . "$HOME/.zshrc"\nexport PATH="${binDir}:$PATH"\n`,
    );
    shimBody += `exec env ZDOTDIR="${zdotDir}" ${realShell} "$@"
`;
  } else {
    shimBody += `exec env PATH="${binDir}:$PATH" ${realShell} "$@"
`;
  }
  writeFileSync(join(binDir, "axn-login-shell"), shimBody, { mode: 0o755 });

  let plugins = `devin:
  restore-session: true
`;
  if (variant === "worktrees" || variant === "mr-review") {
    plugins += `worktrees:
  enabled: true
`;
  }
  if (variant === "mr-review") {
    plugins += `dev-workflow:
  enabled: true
  workflows:
    mr-review:
      title: MR review
      start: inspect
      vars:
        mr: { kind: mr, required: true }
      states: [inspect, done]
      steps:
        inspect:
          probe:
            command: "echo reviewed MR_IID=$MR_IID in $PWD"
            run-in: headless
            auto: true
          diff:
            command: "axn-git origin/main"
            auto: true
`;
  }
  if (variant === "input") {
    plugins += `line-hook:
  enabled: true
`;
  }
  if (variant === "claude") {
    plugins += `claude:
  enabled: true
  restore-session: true
`;
  }
  if (variant === "claude-title") {
    plugins += `claude:
  enabled: true
`;
  }
  if (variant === "hardening") {
    plugins += `claude:
  enabled: true
  install-hooks: true
perm-none:
  enabled: true
perm-exec:
  enabled: true
dev-workflow:
  enabled: true
  workflows:
    harden:
      title: Harden
      start: build
      states: [build, review]
      steps:
        build:
          token-env:
            command: "sh -c 'echo token-env=$AXN_WORKFLOW_TOKEN'"
`;
  }
  writeFileSync(join(stateDir, "plugins.yaml"), plugins);

  // The worktrees/mr-review variants need a real repository as the session
  // cwd — the plugins' git execs run against it.
  let sessionCwd = env.AXN_TERM_DEVIN_CWD ?? cwdDir;
  if (variant === "worktrees" || variant === "mr-review") {
    const repoDir = join(stateDir, "repo");
    mkdirSync(repoDir, { recursive: true });
    const git = (args) =>
      execFileSync("git", args, { cwd: repoDir, stdio: "pipe" }).toString();
    git(["init", "-b", "main"]);
    git(["config", "user.email", "flow@axn-term.test"]);
    git(["config", "user.name", "axn-term flow"]);
    writeFileSync(join(repoDir, "README.md"), "worktrees flow test\n");
    git(["add", "."]);
    git(["commit", "-m", "init"]);
    if (variant === "mr-review") {
      // A bare origin carrying the fake MR head ref the review action fetches.
      const originDir = join(stateDir, "origin.git");
      execFileSync("git", ["init", "--bare", originDir], { stdio: "pipe" });
      git(["remote", "add", "origin", originDir]);
      git(["push", "origin", "HEAD:refs/merge-requests/5/head"]);
      // The target branch too — the review worktree needs `origin/main` as
      // the git tab's compare base (`axn-git origin/main`).
      git(["push", "origin", "HEAD:refs/heads/main"]);
    }
    env.AXN_TERM_REPO_DIR = repoDir;
    sessionCwd = repoDir;
  }

  if (variant === "git-restore") {
    // A Next.js-style bracket path: as a pathspec "app/[id]/page.tsx" also
    // matches app/d/page.tsx. Deleted vs. edited, both unstaged.
    const repoDir = join(stateDir, "repo");
    mkdirSync(join(repoDir, "app", "[id]"), { recursive: true });
    mkdirSync(join(repoDir, "app", "d"), { recursive: true });
    const git = (args) => execFileSync("git", args, { cwd: repoDir, stdio: "pipe" }).toString();
    git(["init", "-b", "main"]);
    git(["config", "user.email", "flow@axn-term.test"]);
    git(["config", "user.name", "axn-term flow"]);
    writeFileSync(join(repoDir, "app", "[id]", "page.tsx"), "export default 'id page';\n");
    writeFileSync(join(repoDir, "app", "d", "page.tsx"), "export default 'd page';\n");
    git(["add", "."]);
    git(["commit", "-m", "init"]);
    rmSync(join(repoDir, "app", "[id]", "page.tsx"));
    writeFileSync(join(repoDir, "app", "d", "page.tsx"), "export default 'd page, EDITED';\n");
    env.AXN_TERM_REPO_DIR = repoDir;
    sessionCwd = repoDir;
  }

  const devinSessionName = env.AXN_TERM_DEVIN_SESSION ?? "green-aurora";
  const state = buildInitialState(stateDir, sessionCwd, variant, devinSessionName);
  if (variant === "devin-storm") {
    // Many devin-active sessions restored at once — the concurrent
    // spawn/probe load is what can stretch a gated OSC report's
    // alive-probe past its fail-open, so the reply lands after the
    // asker's DA1 sentinel as typed `10;rgb:…` inside devin. A single
    // restored devin never reproduces this.
    const names = (env.AXN_TERM_DEVIN_SESSIONS ?? devinSessionName)
      .split(",").map((n) => n.trim()).filter(Boolean);
    const count = Number(env.AXN_TERM_DEVIN_STORM_COUNT ?? 10);
    const w = state.windows[0];
    const wsId = w.workspaces[0].id;
    w.sessions = Array.from({ length: count }, (_, i) => ({
      id: randomUUID(),
      workspaceId: wsId,
      name: `devin-${i + 1}`,
      topic: `devin-${i + 1}`,
      output: "",
      cwd: sessionCwd,
      pluginState: {
        devin: {
          devinSessionName: names[i % names.length],
          devinSessionCwd: sessionCwd,
          devinActive: true,
        },
      },
    }));
    w.selectedSessionId = w.sessions[0].id;
  }
  writeFileSync(join(stateDir, "state.json"), JSON.stringify(state, null, 2));
  const [ws1, ws2] = state.windows[0].workspaces;
  env.AXN_TERM_WORKSPACE_1 = ws1?.id ?? "";
  env.AXN_TERM_WORKSPACE_2 = ws2?.id ?? "";

  return `state dir prepared: ${stateDir}, variant: ${variant}`;
}

async function readRestoredState(env) {
  const path = join(env.AXN_TERM_STATE_DIR, "state.json");
  const raw = readFileSync(path, "utf8");
  const state = JSON.parse(raw);
  const windows = state.windows ?? [];
  const session = windows.flatMap((w) => w.sessions ?? [])
    .find((s) => s.id === env.AXN_TERM_SESSION_ID);
  if (!session) throw new Error("target session missing from saved state");
  const devinName = session.pluginState?.devin?.devinSessionName ?? "none";
  const devinCwd = session.pluginState?.devin?.devinSessionCwd ?? "";
  const single = windows.length === 1 ? ", single window" : "";
  return {
    name: devinName,
    windows: windows.length,
    cwd: devinCwd,
    summary: `restored: ${devinName}, windows: ${windows.length}${single}, cwd: ${devinCwd}`,
  };
}

function readStateFile(env) {
  const path = join(env.AXN_TERM_STATE_DIR, "state.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

/** The persisted agent "talk" shell tab (kind 'shell' with `agent` set). */
function findShellTab(env) {
  const state = readStateFile(env);
  for (const w of state.windows ?? []) {
    for (const s of w.sessions ?? []) {
      const tab = (s.editors ?? []).find((e) => e.kind === "shell" && e.agent);
      if (tab) return tab;
    }
  }
  throw new Error("no agent shell tab in state.json");
}

/** Poll state.json until `predicate(state)` holds. */
async function waitForState(env, predicate, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const state = readStateFile(env);
      if (predicate(state)) return state;
    } catch {
      /* state.json mid-write, or not saved yet */
    }
    await sleep(250);
  }
  throw new Error("timeout waiting for state.json");
}

/** Poll state.json until the shell tab satisfies `predicate`. */
async function waitForTabField(env, predicate, timeoutMs = 30000) {
  let found;
  await waitForState(env, (state) => {
    const tab = (state.windows ?? [])
      .flatMap((w) => w.sessions ?? [])
      .flatMap((s) => s.editors ?? [])
      .find((e) => e.kind === "shell" && e.agent);
    if (!tab || !predicate(tab)) return false;
    found = tab;
    return true;
  }, timeoutMs);
  return found;
}

// ---- File drop (real XDND drag on a private X server) ----------------------
// A drop is OS input: neither the remote-control API nor a synthetic DOM event
// can fake it (only a real drop makes the webview open the file). The flow
// runs the app on its own X server — Xvfb when installed, else a rootful
// Xwayland window — and drives it with XTEST through x11drive.py, so the
// user's desktop never sees the input.

// 1×1 PNG.
const DROP_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
// A space in the name: the pasted path must arrive shell-quoted.
const DROP_IMAGE_NAME = "drop image.png";

/** Terminal output with escape sequences removed (shells highlight pasted text). */
function plainOutput(output) {
  return output.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g, "");
}

function testDisplayEnv(env) {
  return { ...process.env, DISPLAY: env.AXN_TERM_TEST_DISPLAY, WAYLAND_DISPLAY: "", GDK_BACKEND: "x11", NO_AT_BRIDGE: "1" };
}

function x11drive(env, args, timeout) {
  return execFileSync("python3", [join(__dirname, "x11drive.py"), ...args], {
    env: testDisplayEnv(env),
    encoding: "utf8",
    ...(timeout ? { timeout } : {}),
  });
}

/** Read the test display's CLIPBOARD as a pasting app would see it. */
function clipboardRead(env, timeoutMs = 15000) {
  try {
    return x11drive(env, ["get"], timeoutMs);
  } catch {
    return undefined;
  }
}

/** Geometry of the mapped top-level window titled `name`. */
function findX11Window(env, name) {
  const line = x11drive(env, ["find", name]).trim().split("\n")[0];
  if (!line) return undefined;
  const [id, x, y, w, h] = line.split(" ").map(Number);
  return { id, x, y, w, h };
}

async function waitForX11Window(env, name, timeoutMs = 15000) {
  const start = Date.now();
  for (;;) {
    const win = findX11Window(env, name);
    if (win) return win;
    if (Date.now() - start > timeoutMs) throw new Error(`no '${name}' window on the test display`);
    await sleep(200);
  }
}

function onPath(cmd) {
  try {
    execFileSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function startTestDisplay(env) {
  if (process.platform !== "linux") throw new Error("the file-drop flow needs Linux/X11");
  let n = 90;
  while (existsSync(`/tmp/.X11-unix/X${n}`) || existsSync(`/tmp/.X${n}-lock`)) n++;
  const display = `:${n}`;
  let server;
  if (onPath("Xvfb")) server = ["Xvfb", [display, "-screen", "0", "1400x900x24"]];
  else if (onPath("Xwayland") && process.env.WAYLAND_DISPLAY) {
    server = ["Xwayland", [display, "-geometry", "1400x900"]];
  } else throw new Error("the file-drop flow needs Xvfb, or Xwayland inside a Wayland session");
  const logFd = openSync(join(env.AXN_TERM_STATE_DIR, "x-server.log"), "a");
  const child = spawn(server[0], server[1], { stdio: ["ignore", logFd, logFd], detached: true });
  child.unref();
  env.AXN_TERM_TEST_DISPLAY = display;
  env.AXN_TERM_TEST_DISPLAY_PID = String(child.pid);
  const start = Date.now();
  while (!existsSync(`/tmp/.X11-unix/X${n}`)) {
    if (Date.now() - start > 10000) throw new Error(`${server[0]} did not start on ${display}`);
    await sleep(100);
  }

  // A file-manager stand-in offering the image as text/uri-list — only
  // flows with drop steps need it.
  if (env.AXN_TERM_DRAG_SOURCE !== "off") {
    const image = join(env.AXN_TERM_STATE_DIR, "drop", DROP_IMAGE_NAME);
    mkdirSync(dirname(image), { recursive: true });
    writeFileSync(image, DROP_PNG);
    const sourceLog = openSync(join(env.AXN_TERM_STATE_DIR, "drag-source.log"), "a");
    const source = spawn("python3", [join(__dirname, "x11drive.py"), "source", image, "1150", "50"], {
      env: testDisplayEnv(env),
      stdio: ["ignore", sourceLog, sourceLog],
      detached: true,
    });
    source.unref();
    env.AXN_TERM_DRAG_SOURCE_PID = String(source.pid);
    env.AXN_TERM_DROP_IMAGE = image;
    await waitForX11Window(env, "drag-source");
  }
  return `test display ${display} (${server[0]})`;
}

function stopTestDisplay(env) {
  for (const key of ["AXN_TERM_DRAG_SOURCE_PID", "AXN_TERM_CLIP_OWNER_PID", "AXN_TERM_TEST_DISPLAY_PID"]) {
    const pid = Number(env[key]);
    if (pid) {
      try {
        process.kill(pid);
      } catch { /* already gone */ }
    }
    delete env[key];
  }
  delete env.AXN_TERM_TEST_DISPLAY;
}

/**
 * Print a unique mark in the session and return a reader for the output after
 * it. The remote-control buffer is capped, so offsets into it shift.
 */
async function outputAfterMark(env, id) {
  const mark = `drop-mark-${randomBytes(4).toString("hex")}`;
  // The typed line never contains the mark itself, only its output does.
  await writeToSession(env, id, `printf '%s-%s\\n' drop-mark ${mark.slice("drop-mark-".length)}\r`);
  const after = async () => {
    const output = plainOutput(await getSessionOutput(env, id));
    const at = output.lastIndexOf(`${mark}\r\n`);
    return at < 0 ? undefined : output.slice(at + mark.length + 2);
  };
  const start = Date.now();
  while ((await after()) === undefined) {
    if (Date.now() - start > 10000) throw new Error("the shell never printed the output mark");
    await sleep(200);
  }
  return after;
}

/** Drag the image from the drag source to a point in the axn-term window (fractions of its size). */
async function dragImageTo(env, fx, fy) {
  const src = await waitForX11Window(env, "drag-source");
  const app = await waitForX11Window(env, "axn-term");
  const to = [app.x + app.w * fx, app.y + app.h * fy].map((v) => String(Math.round(v)));
  x11drive(env, ["drag", String(src.x + src.w / 2), String(src.y + src.h / 2), ...to]);
}

/**
 * Drop beside the terminal (on the session panel): nothing may reach the
 * prompt, and the webview must not open the image in place of the app.
 */
async function dropBesideTerminal(env) {
  const id = env.AXN_TERM_SESSION_ID;
  const after = await outputAfterMark(env, id);
  await dragImageTo(env, 0.15, 0.8);
  await sleep(1500);
  const typed = await after();
  if (typed.includes("image.png")) {
    throw new Error(`a drop beside the terminal reached the prompt: ${JSON.stringify(typed)}`);
  }
  // A replaced page runs no frontend command; a live one types this line.
  await sendCommand(env, id, "echo app-still-$((40 + 2))");
  const start = Date.now();
  while (!(await after()).includes("app-still-42")) {
    if (Date.now() - start > 10000) {
      throw new Error("the app stopped answering after the drop — the webview opened the image");
    }
    await sleep(250);
  }
  return "drop beside the terminal ignored";
}

/**
 * Drop the image onto the terminal behind a typed `wc -c `, then run the
 * line: the shell must count the image's bytes, which proves the pasted path
 * is the file's and is quoted correctly.
 */
async function dropOnTerminal(env) {
  const id = env.AXN_TERM_SESSION_ID;
  const image = env.AXN_TERM_DROP_IMAGE;
  const since = await outputAfterMark(env, id);
  await writeToSession(env, id, "wc -c ");
  await dragImageTo(env, 0.7, 0.5);
  const start = Date.now();
  while (!(await since()).includes(DROP_IMAGE_NAME)) {
    if (Date.now() - start > 10000) {
      throw new Error(`the dropped image's path never reached the prompt: ${JSON.stringify(await since())}`);
    }
    await sleep(250);
  }
  await writeToSession(env, id, "\r");
  const expected = `${DROP_PNG.length} ${image}`;
  const ranAt = Date.now();
  while (!(await since()).includes(expected)) {
    if (Date.now() - ranAt > 10000) {
      throw new Error(`expected '${expected}' from the pasted line, got ${JSON.stringify(await since())}`);
    }
    await sleep(250);
  }
  return `dropped image pasted as its path: ${image}`;
}

/**
 * The app's own drags must keep working beside the native file-drop handler
 * (Linux): drag the session row onto the "extra" workspace with the mouse —
 * a real HTML5 drag inside WebKitGTK — and the session must move there.
 */
async function dragSessionToWorkspace(env) {
  const id = env.AXN_TERM_SESSION_ID;
  const app = await waitForX11Window(env, "axn-term");
  if (!env.AXN_TERM_WORKSPACE_2) throw new Error("the variant has no second workspace to drag to");
  // Default 800x600 window: the session row is the first card under the
  // "axn-term" workspace, "extra" (empty, "no sessions") is below it.
  const row = [app.x + 180, app.y + 125];
  const extra = [app.x + 110, app.y + 220];
  x11drive(env, ["drag", ...row, ...extra].map(String));
  const workspaceOf = (state) =>
    (state.windows ?? []).flatMap((w) => w.sessions ?? []).find((s) => s.id === id)?.workspaceId;
  const before = env.AXN_TERM_WORKSPACE_1;
  try {
    await waitForState(env, (state) => workspaceOf(state) === env.AXN_TERM_WORKSPACE_2, 10000);
  } catch {
    throw new Error(`the session stayed in workspace ${before} after the drag`);
  }
  return "session row dragged to another workspace";
}

/**
 * Press the window's close button (WM_DELETE_WINDOW) and confirm the dialog
 * with Enter: the app must exit. A window whose page was replaced never
 * answers the close button.
 */
async function closeWithWindowButton(env) {
  const app = await waitForX11Window(env, "axn-term");
  x11drive(env, ["close", String(app.id)]);
  await sleep(1000);
  // No window manager hands out keyboard focus: click the dialog's backdrop
  // (below the dialog, which does nothing) before pressing Enter.
  x11drive(env, ["click", String(Math.round(app.x + app.w / 2)), String(Math.round(app.y + app.h * 0.9))]);
  await sleep(200);
  x11drive(env, ["key", "Return"]);
  const start = Date.now();
  while (Date.now() - start < 15000) {
    try {
      await rc(env, "/health", { signal: AbortSignal.timeout(1000) });
    } catch {
      return "window closed by its close button";
    }
    await sleep(200);
  }
  throw new Error("the window did not close after its close button was pressed");
}

// ---- Context-menu clipboard (real right-click on the test display) -------
// Copy/Paste in AppContextMenu must reach the real system clipboard: Copy
// goes through the Tauri clipboard_write_text command, Paste reads it back.
// The private X server deliberately runs no clipboard manager, so on X11
// copied text that the app stops serving is simply gone — the failure this
// flow catches. The menu is DOM, so its rows are clicked at their offsets:
// w-48 (192px), p-1, ~28px rows — Copy, Paste, Select all — and placeMenu
// opens it at the click point when it fits.
const MENU_DX = 40;
const MENU_ROW = { copy: 18, paste: 46, selectAll: 74 };

async function rightClickInTerminal(env) {
  const app = await waitForX11Window(env, "axn-term");
  // Well inside the terminal area: clear of the session panel, and the menu
  // fits below-right of the point.
  const x = Math.round(app.x + app.w * 0.7);
  const y = Math.round(app.y + app.h * 0.45);
  x11drive(env, ["click", String(x), String(y), "3"]);
  return { x, y };
}

/**
 * Print a marker in the shell, select the buffer via the menu's "Select
 * all", then copy it with a second right-click → "Copy". The X11 CLIPBOARD
 * must then contain the marker.
 */
async function copyViaContextMenu(env) {
  const id = env.AXN_TERM_SESSION_ID;
  const mark = `clip-copy-${randomBytes(4).toString("hex")}`;
  // printf: the typed line itself never contains the mark.
  await writeToSession(env, id, `clear; printf '%s-%s\\n' clip-copy ${mark.slice("clip-copy-".length)}\r`);
  await waitForOutput(env, id, (out) => out.includes(mark));
  await sleep(800); // let the paint settle before clicking

  const { x, y } = await rightClickInTerminal(env);
  await sleep(400);
  x11drive(env, ["click", String(x + MENU_DX), String(y + MENU_ROW.selectAll)]);
  await sleep(500);
  await rightClickInTerminal(env);
  await sleep(400);
  x11drive(env, ["click", String(x + MENU_DX), String(y + MENU_ROW.copy)]);
  await sleep(600);

  const clip = clipboardRead(env);
  if (!clip?.includes(mark)) {
    throw new Error(
      `context-menu Copy never reached the X11 clipboard (wanted ${JSON.stringify(mark)}; ` +
        `CLIPBOARD is ${clip === undefined ? "unserved" : JSON.stringify(clip.slice(0, 200))})`,
    );
  }
  return "context menu Copy put the selection on the X11 clipboard";
}

/**
 * Own the X11 clipboard with an `echo` line like another app would, then
 * right-click → "Paste" in the terminal: the line lands at the prompt and
 * runs, proving clipboard_read_text + term.paste work end to end.
 */
async function pasteViaContextMenu(env) {
  const id = env.AXN_TERM_SESSION_ID;
  const mark = `clip-paste-${randomBytes(4).toString("hex")}`;
  const line = `echo ${mark}-$((40 + 2))`; // prints mark-42
  // A GTK process owning CLIPBOARD+PRIMARY with the line — no clipboard
  // manager on the test display, so it must serve requests itself.
  const owner = spawn("python3", [join(__dirname, "x11drive.py"), "clipboard", line], {
    env: testDisplayEnv(env),
    stdio: "ignore",
    detached: true,
  });
  owner.unref();
  env.AXN_TERM_CLIP_OWNER_PID = String(owner.pid);
  const after = await outputAfterMark(env, id);
  try {
    const start = Date.now();
    while (clipboardRead(env) !== line) {
      if (Date.now() - start > 10000) throw new Error("the test clipboard owner never served its text");
      await sleep(200);
    }

    const { x, y } = await rightClickInTerminal(env);
    await sleep(400);
    x11drive(env, ["click", String(x + MENU_DX), String(y + MENU_ROW.paste)]);

    const pastedAt = Date.now();
    while (!(await after()).includes(line)) {
      if (Date.now() - pastedAt > 10000) {
        throw new Error(`the clipboard line never reached the prompt: ${JSON.stringify((await after())?.slice(-200))}`);
      }
      await sleep(250);
    }
    x11drive(env, ["key", "Return"]);
    const ranAt = Date.now();
    while (!(await after()).includes(`${mark}-42`)) {
      if (Date.now() - ranAt > 10000) throw new Error("the pasted line never ran");
      await sleep(250);
    }
    return "context menu Paste pasted the X11 clipboard at the prompt";
  } finally {
    if (env.AXN_TERM_CLIP_OWNER_PID) {
      try { process.kill(Number(env.AXN_TERM_CLIP_OWNER_PID)); } catch { /* already gone */ }
      delete env.AXN_TERM_CLIP_OWNER_PID;
    }
  }
}

// ---- Regression checks (flows/axn-term-regressions.xml) ---------------------

/** The frontend answers a /command line (only a mounted app does) and no crash was logged. */
/**
 * OSC color-report regression: a program querying terminal colors then
 * exiting fast (devin --osc-exit) must not leak the xterm reply into the
 * shell prompt — and a subsequent axn-* line must still be intercepted.
 */
/**
 * Same OSC leak check against the REAL devin binary: its startup color
 * queries (and any re-query on resume/restore) must never echo a reply
 * into its own input or the shell after exit.
 */
/**
 * Real devin's workspace-trust prompt ("trust this folder?") blocks a fresh
 * session until answered — the flow accepts it: wait briefly for trust UI,
 * then Enter (the default "proceed" row). No-op when the folder is already
 * trusted, so this is the general way to drive a real coding agent.
 */
/**
 * Strip caret-form kernel echoes (`^[]11;rgb:…^[\`) — the line discipline's
 * echo of our reply on a cooked+echo tty; real terminals show it identically
 * and devin's TUI repaints over it. What remains bare (`11;rgb:` without the
 * `^[]` introducer) is reply text rendered as typed input — the real leak.
 */
function stripCaretEcho(out) {
  return out.replace(/\^\[\](?:10|11|12);rgb:[0-9a-fA-F/]+(?:\^\[\\|\^G)/g, "");
}

async function devinTrustIfPrompted(env, id) {
  // Answer devin's interactive prompts (workspace trust, `devin -r`
  // resume-directory picker) until none appear — each match consumes output
  // so the loop only fires on NEW prompts. Enter accepts the default row.
  const marker = /\u2191\u2193 select|✓ Trust|Resume this session|trust this (folder|directory|workspace)|proceed\b/i;
  let seen = 0, answered = 0;
  for (let i = 0; i < 8; i++) {
    let out = "";
    const t0 = Date.now();
    let hit = false;
    while (Date.now() - t0 < 15000) {
      out = await getSessionOutput(env, id);
      if (marker.test(out.slice(seen))) { hit = true; break; }
      await sleep(400);
    }
    seen = out.length;
    if (!hit) return answered > 0;
    await writeToSession(env, id, "\r");
    answered++;
    await sleep(1000);
  }
  return answered > 0;
}

/**
 * OSC leak check on the RESTORE path: the seeded state marks devin active,
 * so the app itself relaunches `devin -r <name>` on open — queries answered
 * while the session reattaches must not echo into devin's input.
 */
async function oscRestoreDevin(env) {
  const id = env.AXN_TERM_SESSION_ID;
  // The app injects the resume itself — no typed launch. Prove devin is
  // foreground, then watch for leaked replies through the gate window.
  await waitForState(env, (st) => {
    const s = (st.windows ?? []).flatMap((w) => w.sessions ?? []).find((x) => x.id === id);
    return s && s.process === "devin";
  }, 30000).catch(async () => {
    const tail = (await getSessionOutput(env, id)).slice(-300);
    throw new Error(`restored devin never became foreground; tail: ${JSON.stringify(tail)}`);
  });
  await devinTrustIfPrompted(env, id);
  await sleep(8000);
  const out = stripCaretEcho(await getSessionOutput(env, id));
  const leak = /\d+;rgb:|;rgb:/.exec(out);
  if (leak) {
    throw new Error(`OSC report leaked on devin restore: ${JSON.stringify(out.slice(Math.max(0, leak.index - 120), leak.index + 80))}`);
  }
  return "restored devin: no OSC leak";
}

/**
 * OSC leak check on the STORM restore path: many devin-active sessions are
 * injected at once, so PTY spawn and the alive-probe IPC compete — the load
 * that lets a gated report outlive the asker's deadline and land as typed
 * `10;rgb:…` inside devin. Every restored session is checked, not just the
 * selected one.
 */
async function oscDevinStorm(env) {
  const state = JSON.parse(readFileSync(join(env.AXN_TERM_STATE_DIR, "state.json"), "utf8"));
  const ids = state.windows
    .flatMap((w) => w.sessions ?? [])
    .filter((s) => s.pluginState?.devin?.devinActive)
    .map((s) => s.id);
  if (ids.length === 0) throw new Error("no devin-active sessions in the seeded state");
  await Promise.all(ids.map((id) =>
    waitForState(env, (st) => {
      const s = (st.windows ?? []).flatMap((w) => w.sessions ?? []).find((x) => x.id === id);
      return s && s.process === "devin";
    }, 90000).catch(async () => {
      const tail = (await getSessionOutput(env, id)).slice(-300);
      throw new Error(`restored devin ${id.slice(0, 8)} never became foreground; tail: ${JSON.stringify(tail)}`);
    }),
  ));
  await Promise.all(ids.map((id) => devinTrustIfPrompted(env, id)));
  await sleep(10000);
  const leaks = [];
  for (const id of ids) {
    const out = stripCaretEcho(await getSessionOutput(env, id));
    const leak = /\d+;rgb:|;rgb:/.exec(out);
    if (leak) {
      leaks.push(`${id.slice(0, 8)}: ${JSON.stringify(out.slice(Math.max(0, leak.index - 100), leak.index + 80))}`);
    }
  }
  if (leaks.length) {
    throw new Error(`OSC report leaked in ${leaks.length}/${ids.length} restored devin sessions — ${leaks.join(" | ")}`);
  }
  return `devin storm (${ids.length} restored sessions): no OSC leak`;
}

async function oscRealDevin(env) {
  const id = env.AXN_TERM_SESSION_ID;
  // Wait for an idle shell before typing — a `devin\r` written during
  // session bring-up is lost.
  await waitForState(env, (st) => {
    const s = (st.windows ?? []).flatMap((w) => w.sessions ?? []).find((x) => x.id === id);
    return s && (!s.process || /^(zsh|bash|sh|fish|dash)$/.test(s.process));
  }, 15000).catch(() => {
    throw new Error("the session never reported an idle shell before launching devin");
  });
  const launch = env.AXN_TERM_DEVIN_SESSION ? `devin -r ${env.AXN_TERM_DEVIN_SESSION}` : "devin";
  await writeToSession(env, id, `${launch}\r`);
  // Prove devin is actually foreground — a failed -r in the wrong cwd
  // would silently fall back to the shell and pass the rgb check vacuously.
  await waitForState(env, (st) => {
    const s = (st.windows ?? []).flatMap((w) => w.sessions ?? []).find((x) => x.id === id);
    return s && s.process === "devin";
  }, 20000).catch(async () => {
    const tail = (await getSessionOutput(env, id)).slice(-300);
    throw new Error(`real devin never became the foreground process; tail: ${JSON.stringify(tail)}`);
  });
  // TUI start + color queries + the raw-gate window.
  await devinTrustIfPrompted(env, id);
  await sleep(8000);
  const during = stripCaretEcho(await getSessionOutput(env, id));
  const leak = /\d+;rgb:|;rgb:/.exec(during);
  if (leak) {
    throw new Error(`OSC report leaked inside real devin: ${JSON.stringify(during.slice(Math.max(0, leak.index - 120), leak.index + 80))}`);
  }
  await writeToSession(env, id, "/exit\r");
  await sleep(2500);
  const after = stripCaretEcho(await getSessionOutput(env, id));
  const late = /\d+;rgb:|;rgb:/.exec(after);
  if (late) {
    throw new Error(`OSC report leaked at the shell after devin exited: ${JSON.stringify(after.slice(Math.max(0, late.index - 120), late.index + 80))}`);
  }
  return "real devin: no OSC leak";
}

async function oscCheck(env) {
  const id = env.AXN_TERM_SESSION_ID;
  await writeToSession(env, id, "devin --osc-exit\r");
  await waitForOutput(env, id, (o) => o.includes("devin interactive"), 20000);
  // Back at a bare shell: a direct query from the prompt is the second
  // leak path — the reply answers nobody and must be dropped too. The
  // desktop reports the shell's own comm (zsh, bash, …) as `process` when
  // the shell itself is foreground — that is the idle state.
  await waitForState(env, (st) => {
    const s = (st.windows ?? []).flatMap((w) => w.sessions ?? []).find((x) => x.id === id);
    return s && (!s.process || /^(zsh|bash|sh|fish|dash)$/.test(s.process));
  }, 15000).catch(() => {
    throw new Error("the session never returned to an idle shell after devin --osc-exit");
  });
  await writeToSession(env, id, "printf '\\033]11;?\\007'\r");
  // Any reply released into the cooked tty lands within a moment — give it
  // the raw-gate window plus slack, then look for the echo.
  await sleep(2000);
  const out = await getSessionOutput(env, id);
  const leak = /\d+;rgb:|;rgb:/.exec(out);
  if (leak) {
    throw new Error(`OSC color report leaked into the shell: ${JSON.stringify(out.slice(Math.max(0, leak.index - 80), leak.index + 80))}`);
  }
  // The report must not have poisoned the input buffer: a plain shell
  // line still executes (stray reply bytes would have corrupted it).
  const tag = `OSCINPUT_${Math.random().toString(36).slice(2, 8)}`;
  await writeToSession(env, id, `echo ${tag}-$((6*7))\r`);
  await waitForOutput(env, id, (o) => o.includes(`${tag}-42`), 15000)
    .catch(async () => {
      const tail = (await getSessionOutput(env, id)).slice(-300);
      throw new Error(`the input line was poisoned by an OSC reply; tail: ${JSON.stringify(tail)}`);
    });
  // And hidden-command dispatch still works — axn-session opens a session.
  const before = (await getSessions(env)).length;
  await sendCommand(env, id, "axn-session . --background");
  await waitForState(env, (st) =>
    (st.windows ?? []).flatMap((w) => w.sessions ?? []).length > before, 15000)
    .catch(async () => {
      const tail = (await getSessionOutput(env, id)).slice(-300);
      throw new Error(`axn-session was not dispatched after the OSC replies; tail: ${JSON.stringify(tail)}`);
    });
  // Alive raw reader with devin's DA1 sentinel: the color replies must
  // reach it before the DA1 answer — one arriving after it is typed text.
  await writeToSession(env, id, "devin --osc\r");
  // Wait for the probe's own marker — "devin interactive" also appears in
  // the earlier --osc-exit leg's output.
  await waitForOutput(env, id, (o) => o.includes("devin colors:"), 20000);
  const live = stripCaretEcho(await getSessionOutput(env, id));
  if (/\d+;rgb:|;rgb:/.test(live)) {
    throw new Error("OSC report arrived after the DA1 sentinel — typed into a still-running devin's input");
  }
  if (!live.includes("devin colors: answered")) {
    throw new Error(`devin's color query got no reply before its DA1 sentinel; tail: ${JSON.stringify(live.slice(-400))}`);
  }
  await writeToSession(env, id, "/exit\r");
  return "no OSC leak, input clean, axn-session dispatched";
}

async function checkAlive(env) {
  const id = env.AXN_TERM_SESSION_ID;
  const tag = randomBytes(3).toString("hex");
  await sendCommand(env, id, `echo alive-${tag}-$((40 + 2))`);
  try {
    await waitForOutput(env, id, (s) => s.includes(`alive-${tag}-42`), 20000);
  } catch {
    throw new Error(`the frontend did not run a /command line; ${logTail(env)}`);
  }
  assertNoErrorBoundary(env, "running app");
  return "frontend alive, no error boundary";
}

/** Print AXN_TERM_FLOOD_BYTES (default 8 MB) in the session; the shell reports how long it took. */
async function floodOutput(env) {
  const id = env.AXN_TERM_SESSION_ID;
  const bytes = Number(env.AXN_TERM_FLOOD_BYTES ?? 8000000);
  const tag = `FLOOD_${randomBytes(3).toString("hex")}_MS`;
  // The echoed command line shows "$((", only the result has digits after the tag.
  await writeToSession(
    env,
    id,
    `s=$(date +%s%N); head -c ${bytes} /dev/zero | tr '\\0' x; echo; echo ${tag} $(( ($(date +%s%N)-s)/1000000 ))\r`,
  );
  const re = new RegExp(`${tag} (\\d+)`);
  let out;
  try {
    out = await waitForOutput(env, id, (o) => re.test(o), 120000);
  } catch {
    throw new Error(`the ${bytes}-byte flood did not finish within 120 s`);
  }
  return Number(re.exec(out)[1]);
}

async function floodBaseline(env) {
  const ms = await floodOutput(env);
  env.AXN_TERM_FLOOD_BASELINE_MS = String(ms);
  return `baseline flood: ${ms} ms`;
}

/**
 * A closed window must not keep throttling PTY output. Limit: 8 s
 * (AXN_TERM_FLOOD_MAX_MS) or 5x the baseline on a slow machine.
 */
async function floodAfterClose(env) {
  const ms = await floodOutput(env);
  const baseline = Number(env.AXN_TERM_FLOOD_BASELINE_MS ?? 0);
  const limit = Math.max(Number(env.AXN_TERM_FLOOD_MAX_MS ?? 8000), 5 * baseline);
  const summary = `flood after closed window: ${ms} ms (baseline ${baseline} ms, limit ${limit} ms)`;
  if (ms > limit) throw new Error(`output throttled — ${summary}`);
  return summary;
}

function linePluginState(env) {
  const id = env.AXN_TERM_SESSION_ID;
  return (readStateFile(env).windows ?? []).flatMap((w) => w.sessions ?? [])
    .find((s) => s.id === id)?.pluginState?.["line-hook"] ?? {};
}

/** Click the terminal so it has keyboard focus (no window manager hands it out). */
async function focusTerminal(env) {
  const app = await waitForX11Window(env, "axn-term");
  x11drive(env, ["click", String(Math.round(app.x + app.w * 0.7)), String(Math.round(app.y + app.h * 0.5))]);
  await sleep(300);
}

/**
 * Paste "echo PASTE_OK_$((40+2))" plus newline with Shift+Insert while a
 * plugin's async line hook is active: the shell must run it exactly once.
 */
async function pasteLine(env) {
  const id = env.AXN_TERM_SESSION_ID;
  try {
    await waitForState(env, () => linePluginState(env).ready === true, 30000);
  } catch {
    throw new Error(`the line-hook plugin never loaded; ${logTail(env)}`);
  }
  // Hidden-command tracking only runs while the shell itself is foreground.
  await waitForState(env, (st) => {
    const s = (st.windows ?? []).flatMap((w) => w.sessions ?? []).find((x) => x.id === id);
    return s && !s.process;
  }, 15000).catch(() => {
    throw new Error("the session never reported an idle shell");
  });
  const after = await outputAfterMark(env, id);
  // With bracketed paste on, the hook never sees the pasted line: no test.
  const raw = await getSessionOutput(env, id);
  if (raw.slice(raw.lastIndexOf("drop-mark-")).includes("\x1b[?2004h")) {
    throw new Error("the session's bash still turns on bracketed paste (INPUTRC overridden?)");
  }
  const clipLog = openSync(join(env.AXN_TERM_STATE_DIR, "clipboard.log"), "a");
  const clip = spawn("python3", [join(__dirname, "x11drive.py"), "clipboard", "echo PASTE_OK_$((40+2))\n"], {
    env: testDisplayEnv(env),
    stdio: ["ignore", clipLog, clipLog],
  });
  try {
    await sleep(700);
    await focusTerminal(env);
    x11drive(env, ["key", "Shift_L+Insert"]);
    const ran = () => after().then((o) => (o.match(/PASTE_OK_42/g) ?? []).length);
    const start = Date.now();
    while ((await ran()) === 0) {
      if (Date.now() - start > 10000) {
        const hooked = linePluginState(env).lastLine ?? "(none)";
        throw new Error(
          `the pasted line never ran (line hook saw: ${JSON.stringify(hooked)}); terminal after the paste: ${JSON.stringify(await after())}`,
        );
      }
      await sleep(250);
    }
    await sleep(1500);
    const runs = await ran();
    if (runs !== 1) throw new Error(`the pasted line ran ${runs} times`);
    const hooked = linePluginState(env).lastLine ?? "";
    if (!hooked.includes("PASTE_OK_")) {
      throw new Error(`the async line hook did not see the pasted line (saw ${JSON.stringify(hooked)})`);
    }
    return "pasted line ran once through the async line hook";
  } finally {
    clip.kill();
  }
}

/**
 * Open an unreadable file with typed `axn-edit`, press Ctrl+S in the editor:
 * the file must keep its contents. The file lives under $HOME (the fs scope).
 */
async function editorReadFail(env) {
  const id = env.AXN_TERM_SESSION_ID;
  const dir = mkdtempSync(join(homedir(), ".cache", "axn-term-flow-"));
  const file = join(dir, `locked-${randomBytes(3).toString("hex")}.txt`);
  writeFileSync(file, "KEEP ME\n");
  // Write-only: the read fails, a write would still truncate it.
  chmodSync(file, 0o200);
  try {
    await waitForState(env, (st) => {
      const s = (st.windows ?? []).flatMap((w) => w.sessions ?? []).find((x) => x.id === id);
      return s && !s.process;
    }, 15000).catch(() => {
      throw new Error("the session never reported an idle shell");
    });
    await focusTerminal(env);
    x11drive(env, ["type", `axn-edit ${file}`]);
    x11drive(env, ["key", "Return"]);
    try {
      await waitForState(env, (st) =>
        (st.windows ?? []).flatMap((w) => w.sessions ?? []).find((x) => x.id === id)?.editors
          ?.some((e) => e.path === file), 15000);
    } catch {
      throw new Error(`typed axn-edit did not open an editor tab; ${logTail(env)}`);
    }
    await sleep(2000);
    // Click into the editor body, then save.
    await focusTerminal(env);
    x11drive(env, ["key", "Control_L+s"]);
    await sleep(2500);
    chmodSync(file, 0o600);
    const now = readFileSync(file, "utf8");
    if (now !== "KEEP ME\n") throw new Error(`Ctrl+S after a failed read overwrote the file with ${JSON.stringify(now)}`);
    return "unreadable file kept its contents after Ctrl+S";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Open Git Inspect for the session's repo. */
async function openGitInspect(env) {
  const id = env.AXN_TERM_SESSION_ID;
  await sendCommand(env, id, "axn-git");
  await waitForState(env, (st) =>
    (st.windows ?? []).flatMap((w) => w.sessions ?? []).find((x) => x.id === id)?.editors
      ?.some((e) => e.kind === "git"), 15000);
  // Let the status list load.
  await sleep(2500);
  return "git inspect open";
}

/**
 * Git Inspect: right-click the deleted app/[id]/page.tsx, pick "Restore
 * deleted file". The file must come back and the edited app/d/page.tsx keep
 * its change.
 */
async function gitRestoreDeleted(env) {
  const repo = env.AXN_TERM_REPO_DIR;
  const app = await waitForX11Window(env, "axn-term");
  // Default 800x600 window: the first unstaged row is "D app/[id]/page.tsx".
  const row = [app.x + 400, app.y + 121];
  x11drive(env, ["click", ...row, 3].map(String));
  await sleep(800);
  // The menu opens at the pointer: title, Stage, Restore deleted file, Copy path.
  x11drive(env, ["click", String(row[0] + 60), String(row[1] + 67)]);
  const restored = join(repo, "app", "[id]", "page.tsx");
  const start = Date.now();
  while (!existsSync(restored)) {
    if (Date.now() - start > 10000) {
      throw new Error("app/[id]/page.tsx was not restored — the row or menu click missed");
    }
    await sleep(200);
  }
  await sleep(500);
  const edited = readFileSync(join(repo, "app", "d", "page.tsx"), "utf8");
  if (!edited.includes("EDITED")) {
    throw new Error(`restoring app/[id]/page.tsx also reset app/d/page.tsx (now ${JSON.stringify(edited)})`);
  }
  return "deleted file restored, app/d/page.tsx kept its edit";
}

/**
 * Broadcast fan-out: mark both seeded shells (axn-broadcast-add), list
 * targets (axn-broadcasts), send `axn-broadcast ls` and verify the marker
 * file lands in BOTH PTYs, then axn-focus the second session and verify
 * the window's selected session moved — the flow-level go-to-session.
 */
async function broadcastCheck(env) {
  const st = await waitForState(env, (s) => (s.windows?.[0]?.sessions ?? []).length >= 2, 30000);
  const [s1, s2] = st.windows[0].sessions;
  const mark = env.AXN_TERM_BCAST_MARK;

  // Both sessions must be at an idle shell for the hidden-command path.
  for (const s of [s1, s2]) {
    await waitForState(
      env,
      (cur) => cur.windows?.[0]?.sessions?.find((x) => x.id === s.id && !x.process),
      20000,
    ).catch(() => {
      throw new Error(`session ${s.name} never reported an idle shell`);
    });
  }

  // Sessions spawn lazily — plugin-style views mount only for the selected
  // session (or a broadcast tile), so s2 has no PTY yet. 'go to session'
  // first: `axn-session select` mounts s2's view, which spawns its PTY —
  // and verifies the real navigation command while at it.
  await sendCommand(env, s1.id, `axn-session select ${s2.id}`);
  await waitForState(
    env,
    (cur) => cur.windows?.[0]?.selectedSessionId === s2.id,
    15000,
  ).catch(() => {
    throw new Error(`axn-session select did not focus session '${s2.name}'; ${logTail(env)}`);
  });

  await sendCommand(env, s1.id, "axn-broadcast-add");
  // Auto-naming may have already replaced the seeded name — address the
  // second session by id, not 'two'.
  await sendCommand(env, s1.id, `axn-broadcast-add ${s2.id}`);
  // The 'sent to N sessions' feedback echoes into s1 — the real proof is
  // the marker file reaching s2's PTY below.
  await sendCommand(env, s1.id, "axn-broadcasts");
  try {
    await waitForOutput(env, s1.id, (o) => o.includes("sent to") || /\* |^ /m.test(o), 15000);
  } catch {
    throw new Error(`axn-broadcasts produced no listing; ${logTail(env)}`);
  }

  // Marking mounts each target's tile view, which spawns its PTY — probe
  // each session's shell until it answers before broadcasting into it.
  for (const s of [s1, s2]) {
    const probe = `PROBE_${randomBytes(3).toString("hex")}`;
    let live = false;
    for (let attempt = 0; attempt < 10 && !live; attempt++) {
      await writeToSession(env, s.id, `echo ${probe}\r`).catch(() => {});
      try {
        await waitForOutput(env, s.id, (o) => o.includes(probe), 8000);
        live = true;
      } catch {
        // PTY not spawned yet — the tile mount races the broadcast setup.
      }
    }
    if (!live) {
      throw new Error(`session '${s.name}' (${s.id}) PTY never came up; ${logTail(env)}`);
    }
  }

  await sendCommand(env, s1.id, "axn-broadcast ls");
  for (const s of [s1, s2]) {
    try {
      await waitForOutput(env, s.id, (o) => o.includes(mark), 15000);
    } catch {
      const oneOut = (await getSessionOutput(env, s1.id)).slice(-400);
      const twoOut = (await getSessionOutput(env, s2.id)).slice(-400);
      throw new Error(
        `broadcast ls never reached session '${s.name}' (${s.id})` +
          `\n--- one tail ---\n${oneOut}\n--- two tail ---\n${twoOut}`,
      );
    }
  }

  // Real mouse click on session two's tile — 'go to session' unmarks it
  // and focuses it, so the window selection must move to s2.
  let app;
  try {
    app = findX11Window(env, "axn-term");
  } catch {
    app = undefined;
  }
  if (app) {
    // Real XTEST click at session two's tile center — hits the (not yet
    // hovered) 'go to session' button, which unmarks + focuses it.
    const cx = Math.round(app.x + app.w * 0.75);
    const cy = Math.round(app.y + app.h * 0.55);
    x11drive(env, ["click", String(cx), String(cy)]);
    await waitForState(
      env,
      (cur) => cur.windows?.[0]?.selectedSessionId === s2.id,
      15000,
    ).catch(() => {
      throw new Error(`tile click did not focus session '${s2.name}'; ${logTail(env)}`);
    });
  } else {
    // No test display (native macOS run): no synthetic pointer — the
    // interactive check is the PTY write above, which already passed.
    console.log("skipping tile click — no X11 test display");
  }

  // 'go to session' via the real command path: `axn-session select` calls
  // the same goToSession the tile button does — focus moves to s2 AND s2
  // becomes the only selection (s1 leaves the broadcast set).
  const mark2 = `bcast2-${randomBytes(3).toString("hex")}`;
  writeFileSync(join(env.AXN_TERM_STATE_DIR, "cwd", `${mark2}.txt`), "m\n");
  await sendCommand(env, s1.id, `axn-session select ${s2.id}`);
  await waitForState(
    env,
    (cur) => cur.windows?.[0]?.selectedSessionId === s2.id,
    15000,
  ).catch(() => {
    throw new Error(`axn-session select did not focus session '${s2.name}'; ${logTail(env)}`);
  });
  // Only s2 may still be selected: a broadcast now must reach s2's PTY and
  // must NOT reach s1's.
  await sendCommand(env, s1.id, "axn-broadcast ls");
  try {
    await waitForOutput(env, s2.id, (o) => o.includes(mark2), 15000);
  } catch {
    throw new Error(`broadcast after select never reached session '${s2.name}'; ${logTail(env)}`);
  }
  const out1 = await getSessionOutput(env, s1.id);
  if (out1.includes(mark2)) {
    throw new Error(
      `axn-session select left '${s1.name}' selected — it still receives broadcast lines`,
    );
  }

  assertNoErrorBoundary(env, "broadcast flow");
  return `broadcast ok: ls reached ${s1.name} + ${s2.name}, select ${s2.name} leaves it the only target`;
}

/**
 * Start real claude in the session, answer its trust prompt, name the
 * conversation with /rename (and optionally send one tiny prompt to haiku so
 * the conversation has content), then wait until the plugin has seen the name.
 */
async function runClaudeTitled(env, withPrompt) {
  const id = env.AXN_TERM_SESSION_ID;
  const title = `axn-flow-${randomBytes(3).toString("hex")}`;
  try {
    const before = (await getSessionOutput(env, id)).length;
    const fresh = async () => (await getSessionOutput(env, id)).slice(before);
    await writeToSession(env, id, "claude --model haiku\r");
    let trusted = false;
    const deadline = Date.now() + 45000;
    for (;;) {
      if (Date.now() > deadline) throw new Error(`claude never became ready; ${(await fresh()).slice(-400)}`);
      const out = await fresh();
      // The TUI positions words with cursor moves, so match the text without escapes.
      const text = out.replace(/\x1b\[[0-9;?<>]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
      if (!trusted && /Yes,?\s*I\s*trust/.test(text)) {
        // The prompt defaults to "No, exit" — move down, confirm.
        await sleep(500);
        await writeToSession(env, id, "\x1b[B");
        await sleep(500);
        await writeToSession(env, id, "\r");
        trusted = true;
      }
      // claude sets its title (✳ Claude Code) once the TUI is up.
      if (/\x1b\]0;[^\x07]*Claude Code/.test(out)) break;
      await sleep(500);
    }
    // Type the command, let the input settle, submit separately (a combined
    // write is taken as pasted text by some TUIs).
    await writeToSession(env, id, `/rename ${title}`);
    await sleep(1000);
    await writeToSession(env, id, "\r");
    await waitForState(
      env,
      (state) =>
        (state.windows ?? [])
          .flatMap((w) => w.sessions ?? [])
          .find((s) => s.id === id)?.pluginState?.claude?.seenTitle === title,
      30000,
    ).catch(() => {
      throw new Error(`plugin never saw the title '${title}' while claude ran`);
    });
    if (withPrompt) {
      await sleep(1000);
      await writeToSession(env, id, "Reply with exactly: ok");
      await sleep(1000);
      await writeToSession(env, id, "\r");
      // claude animates its title glyph while it works (◐…) and shows ✳ when
      // idle again: wait for a busy title, then an idle one.
      const titles = (out) => [...out.matchAll(/\x1b\]0;([^\x07\x1b]*)(?:\x07|\x1b\\)/g)].map((m) => m[1]);
      const done = Date.now() + 90000;
      let busy = false;
      for (;;) {
        if (Date.now() > done) throw new Error("claude never finished answering");
        const t = titles(await fresh()).filter(Boolean).pop() ?? "";
        if (t && !t.startsWith("✳")) busy = true;
        else if (busy && t.startsWith("✳")) break;
        await sleep(1000);
      }
    }
  } catch (error) {
    await closeApp(env);
    throw new Error(`${error.message}; ${logTail(env)}`);
  }
  env.AXN_TERM_CLAUDE_TITLE = title;
  env.AXN_TERM_EXPECT_RECORD = withPrompt ? "true" : "false";
  return `claude titled: ${title}${withPrompt ? " (with a conversation)" : " (empty)"}`;
}

export async function run(step, env) {
  const action = step.args?.action ?? "help";

  switch (action) {
    case "prepare":
      return await prepare(env);

    case "prepareHmr": {
      const result = await prepare(env);
      // axn-term-hmr reads its checkout from <state>/dev-hmr.json and spawns
      // vite in <repo>/apps/desktop at launch — seed it with this repo.
      const repo = env.AXN_HMR_REPO ?? resolve(__dirname, "../..");
      if (!existsSync(join(repo, "node_modules"))) {
        throw new Error(`${repo} has no node_modules — run 'pnpm install' there first`);
      }
      writeFileSync(join(env.AXN_TERM_STATE_DIR, "dev-hmr.json"), JSON.stringify({ repo }));
      // Dev mode ignores state.json (in-memory shell state) — the seeded
      // devin session id never appears in /sessions. Reset it to one empty
      // window so expected-window-count is satisfied and no target id is
      // waited on; the vite frontend's fresh session is the real assertion.
      writeFileSync(
        join(env.AXN_TERM_STATE_DIR, "state.json"),
        JSON.stringify({ windows: [{ id: "w-0", sessions: [] }] }),
      );
      return `${result}; dev-hmr.json → ${repo}`;
    }

    case "verifyHmr": {
      // The frontend runs on http://localhost:<port>. A session in /sessions
      // means create_session reached the PTY layer — i.e. the vite origin is
      // treated as local and the whole IPC surface works.
      const viteUrl = `http://localhost:${env.AXN_HMR_PORT ?? "5914"}`;
      const deadline = Date.now() + 120000;
      let viteUp = false;
      while (Date.now() < deadline) {
        try {
          const res = await fetch(viteUrl, { signal: AbortSignal.timeout(1500) });
          if (res.ok) { viteUp = true; break; }
        } catch {}
        await sleep(500);
      }
      if (!viteUp) throw new Error(`vite never came up at ${viteUrl}; ${logTail(env)}`);
      const sessions = await getSessions(env);
      if (!sessions.length) {
        throw new Error(`vite up but no session — IPC still denied on the vite origin; ${logTail(env)}`);
      }
      // Full round-trip: write_to_pty must pass the same gate.
      const id = env.AXN_TERM_SESSION_ID ?? sessions[0];
      await writeToSession(env, id, "echo HMR_OK_$((6*7))\n");
      await waitForOutput(env, id, (s) => s.includes("HMR_OK_42"), 30000);
      assertNoErrorBoundary(env, "verifyHmr");
      return `hmr verified: vite at ${viteUrl}, ${sessions.length} session(s), pty write ok`;
    }

    case "start": {
      const id = await startApp(env);
      return `app started, session=${id}`;
    }

    case "runDevin": {
      const id = env.AXN_TERM_SESSION_ID;
      const waitFor = env.AXN_TERM_DEVIN_WAIT_FOR ?? "Resuming devin session:";
      try {
        await waitForOutput(env, id, (s) => {
          if (s.includes('"session_locked"')) throw new Error("Devin session is already open in another process");
          return s.includes(waitFor);
        });
        // The close-time capture only runs when the session is flagged as a
        // devin session — that flag comes from a ~1 s foreground-process
        // poll, so make sure it has seen devin before the flow proceeds to
        // close.
        await waitForState(env, (state) =>
          /devin/i.test(
            (state.windows ?? [])
              .flatMap((w) => w.sessions ?? [])
              .find((s) => s.id === id)?.process ?? "",
          ),
          15000,
        );
      } catch (error) {
        await closeApp(env);
        throw error;
      }
      return "devin running";
    }

    case "createWindow": {
      const newId = await createRemoteWindow(env);
      const start = Date.now();
      while (Date.now() - start < 10000) {
        const windows = await getWindows(env);
        if (windows.includes(newId)) {
          env.AXN_TERM_EXTRA_WINDOW_ID = newId;
          break;
        }
        await sleep(200);
      }
      // Give the new window's React app time to mount its listeners.
      await sleep(1500);
      return `window created: ${newId}`;
    }

    case "closeWindow": {
      const windowId = env.AXN_TERM_EXTRA_WINDOW_ID;
      if (!windowId) throw new Error("no extra window to close");
      await closeRemoteWindow(env, windowId);
      const start = Date.now();
      while (Date.now() - start < 10000) {
        const windows = await getWindows(env);
        if (!windows.includes(windowId)) break;
        await sleep(200);
      }
      return `window closed: ${windowId}`;
    }

    // Submit `axn-worktree <name>` through the command dispatch — the
    // worktrees plugin must create the worktree + branch and open a session
    // rooted at it, stamped with pluginState.worktrees.worktree.
    case "createWorktree": {
      const id = env.AXN_TERM_SESSION_ID;
      env.AXN_TERM_MAIN_SESSION_ID = id;
      const name = env.AXN_TERM_WORKTREE_NAME ?? "flowtest";
      const repoDir = env.AXN_TERM_REPO_DIR;
      if (!repoDir) throw new Error("AXN_TERM_REPO_DIR not set — prepare with variant=worktrees");
      await sendCommand(env, id, `axn-worktree ${name}`);
      const state = await waitForState(
        env,
        (s) =>
          (s.windows ?? [])
            .flatMap((w) => w.sessions ?? [])
            .some((sess) => sess.pluginState?.worktrees?.worktree?.branch === `wt/${name}`),
        45000,
      );
      const sess = state.windows
        .flatMap((w) => w.sessions ?? [])
        .find((s) => s.pluginState?.worktrees?.worktree?.branch === `wt/${name}`);
      const wt = sess.pluginState.worktrees.worktree;
      // /var/... is a symlink to /private/var/... on macOS — git answers
      // canonical paths, so compare canonicalized.
      if (wt.repoRoot !== realpathSync(repoDir)) {
        throw new Error(`repoRoot mismatch: ${wt.repoRoot} != ${repoDir}`);
      }
      if (!existsSync(wt.path)) throw new Error(`worktree dir missing: ${wt.path}`);
      const list = execFileSync("git", ["-C", repoDir, "worktree", "list", "--porcelain"]).toString();
      const listed = list
        .split("\n")
        .filter((l) => l.startsWith("worktree "))
        .map((l) => l.slice("worktree ".length));
      if (!listed.some((p) => realpathSync(p) === realpathSync(wt.path))) {
        throw new Error(`git does not list ${wt.path}:\n${list}`);
      }
      const branches = execFileSync("git", ["-C", repoDir, "branch", "--list", `wt/${name}`]).toString();
      if (!branches.includes(`wt/${name}`)) throw new Error(`branch wt/${name} missing`);
      if (realpathSync(sess.cwd) !== realpathSync(wt.path)) {
        throw new Error(`session cwd ${sess.cwd} != worktree ${wt.path}`);
      }
      return `worktree created: ${wt.path}, branch ${wt.branch}, session=${sess.id}`;
    }

    // Launch the fake devin in the MAIN session (still in the primary
    // checkout) — the plugin must raise its isolation warning banner. devin
    // blocks on stdin; each \r echoes through the PTY so the plugin's
    // onOutput re-evaluates until the foreground-process poll reports it.
    case "nudgeWorktree": {
      const id = env.AXN_TERM_MAIN_SESSION_ID ?? env.AXN_TERM_SESSION_ID;
      await writeToSession(env, id, "devin\r");
      const start = Date.now();
      while (Date.now() - start < 45000) {
        const state = readStateFile(env);
        const sess = (state.windows ?? [])
          .flatMap((w) => w.sessions ?? [])
          .find((s) => s.id === id);
        const banner = sess?.pluginState?.worktrees?.banner;
        if (banner?.level === "warning" && banner.message?.includes("main checkout")) {
          return `isolation banner: ${banner.message}`;
        }
        await writeToSession(env, id, "\r").catch(() => {});
        await sleep(400);
      }
      throw new Error("no isolation banner within 45s");
    }

    // `axn-workflow start mr-review <url>` typed in the repo session must fetch the MR head
    // from the bare origin, create worktree wt/mr-5, open a session there and
    // auto-run the workflow's headless probe (check `inspect:probe` → ok).
    case "mrReview": {
      const id = env.AXN_TERM_SESSION_ID;
      const url =
        env.AXN_TERM_MR_URL ?? "https://gitlab.com/group/repo/-/merge_requests/5";
      await sendCommand(env, id, `axn-workflow start mr-review ${url}`);
      const state = await waitForState(
        env,
        (s) =>
          (s.windows ?? [])
            .flatMap((w) => w.sessions ?? [])
            .some(
              (sess) =>
                sess.pluginState?.["dev-workflow"]?.vars?.mr_iid === "5" &&
                sess.pluginState?.["dev-workflow"]?.checks?.["inspect:probe"]
                  ?.status === "ok" &&
                sess.pluginState?.["dev-workflow"]?.checks?.["inspect:diff"]
                  ?.status === "done",
            ),
        45000,
      );
      const sess = state.windows
        .flatMap((w) => w.sessions ?? [])
        .find((s) => s.pluginState?.["dev-workflow"]?.vars?.mr_iid === "5");
      const vars = sess.pluginState["dev-workflow"].vars;
      const wt = sess.pluginState?.worktrees?.worktree;
      if (!wt) throw new Error("review session has no worktrees state");
      if (wt.branch !== "wt/mr-5") throw new Error(`branch ${wt.branch} != wt/mr-5`);
      if (!existsSync(wt.path)) throw new Error(`worktree dir missing: ${wt.path}`);
      if (realpathSync(sess.cwd) !== realpathSync(wt.path)) {
        throw new Error(`session cwd ${sess.cwd} != worktree ${wt.path}`);
      }
      const head = execFileSync("git", ["-C", wt.path, "rev-parse", "HEAD"], {
        stdio: "pipe",
      }).toString().trim();
      const repoHead = execFileSync(
        "git", ["-C", env.AXN_TERM_REPO_DIR, "rev-parse", "HEAD"], { stdio: "pipe" },
      ).toString().trim();
      if (head !== repoHead) throw new Error("worktree HEAD != origin MR head");
      // The `axn-git origin/main` auto step must have opened a git tab whose
      // persisted compare base is the fetched target ref.
      const gitTab = (sess.editors ?? []).find(
        (t) => t.kind === "git" && t.base === "origin/main",
      );
      if (!gitTab) {
        throw new Error(
          `no git tab with base=origin/main (editors: ${JSON.stringify(sess.editors ?? [])})`,
        );
      }
      return `review session ${sess.id} in ${wt.path} (${wt.branch}), vars mr_iid=${vars.mr_iid} mr_url=${vars.mr_url}, probe ok, compare tab ok`;
    }

    // dev-workflow markers need the binding token: a tokenless marker
    // printed by anything in the terminal must not move the workflow.
    case "hardenWorkflow": {
      const id = env.AXN_TERM_SESSION_ID;
      const binding = () =>
        (readStateFile(env).windows ?? []).flatMap((w) => w.sessions ?? [])
          .find((s) => s.id === id)?.pluginState?.["dev-workflow"] ?? {};
      await sendCommand(env, id, "axn-workflow start harden");
      await waitForState(env, () => binding().state === "build" && /^[0-9a-f]{16}$/.test(binding().token ?? ""));
      const token = binding().token;
      await sendCommand(env, id, "axn-workflow run token-env");
      await waitForOutput(env, id, (out) => out.includes(`token-env=${token}`));
      // leading \n: the shell's title escape precedes the command's output
      await writeToSession(env, id, "printf '\\naxn-workflow-state: review\\n'\r");
      await waitForOutput(env, id, (out) => /\naxn-workflow-state: review\r?\n/.test(out));
      await sleep(3000);
      if (binding().state !== "build") throw new Error(`tokenless marker moved the workflow to ${binding().state}`);
      await writeToSession(env, id, `printf '\\naxn-workflow-state[%s]: review\\n' ${token}\r`);
      await waitForState(env, () => binding().state === "review");
      return `workflow token ${token}: env ok, tokenless marker ignored, tokened marker moved to review`;
    }

    // `axn-term session …` from inside the terminal reaches the app over
    // the control socket; a wrong secret and non-axn commands are refused.
    case "hardenControl": {
      const id = env.AXN_TERM_SESSION_ID;
      await writeToSession(env, id, `"$AXN_TERM_CLI" session summary 'set over the control socket'; echo okrc=$?\r`);
      await waitForState(env, (state) =>
        (state.windows ?? []).flatMap((w) => w.sessions ?? [])
          .find((s) => s.id === id)?.summary === "set over the control socket");
      await waitForOutput(env, id, (out) => out.includes("okrc=0"));
      await writeToSession(env, id, `AXN_TERM_PTY_SECRET=bad "$AXN_TERM_CLI" session summary nope; echo badrc=$?\r`);
      await waitForOutput(env, id, (out) => out.includes("badrc=1"));
      await writeToSession(env, id, `"$AXN_TERM_CLI" session command rm -rf x; echo cmdrc=$?\r`);
      await waitForOutput(env, id, (out) => out.includes("cmdrc=2"));
      return "control socket: summary set (rc 0), bad secret refused (rc 1), non-axn command refused (rc 2)";
    }

    case "hardenSandbox": {
      const id = env.AXN_TERM_SESSION_ID;
      let none;
      let exec;
      await waitForState(env, (state) => {
        const ps = (state.windows ?? []).flatMap((w) => w.sessions ?? []).find((s) => s.id === id)?.pluginState ?? {};
        none = ps["perm-none"]?.result;
        exec = ps["perm-exec"]?.result;
        return none !== undefined && exec !== undefined;
      });
      return `sandbox perm-none: ${none}; perm-exec: ${exec}`;
    }

    // Hook events fired back to back must not lose the permission request —
    // in the main shell and in a sub-shell tab.
    case "hardenHooks": {
      const id = env.AXN_TERM_SESSION_ID;
      const session = (state) => (state.windows ?? []).flatMap((w) => w.sessions ?? []).find((s) => s.id === id);
      await writeToSession(env, id, "claude\r");
      await writeToSession(env, "hook-tab", "claude\r");
      const state = await waitForState(env, (st) => {
        const s = session(st);
        const tab = (s?.editors ?? []).find((e) => e.id === "hook-tab");
        return s?.status === "blocked" && s?.pluginState?.claude?.attention?.level === "critical" &&
          tab?.hookStatus === "blocked" && tab?.hookAttention?.level === "critical" &&
          (tab?.tasks?.length ?? 0) > 0;
      }, 45000);
      const s = session(state);
      const tab = s.editors.find((e) => e.id === "hook-tab");
      const done = tab.tasks.filter((t) => t.done).length;
      return `hooks: session ${s.status}/${s.pluginState.claude.attention.level}, tab ${tab.hookStatus}/${tab.hookAttention.level}, tab tasks ${done}/${tab.tasks.length} (${tab.progress}%)`;
    }

    // File-drop flow (flows/axn-term-drop-image.xml). On failure the app and
    // the test display are torn down so the next flow starts clean.
    case "startTestDisplay":
      return await startTestDisplay(env);

    case "screenshot": {
      const file = step.args?.file ?? join(env.AXN_TERM_STATE_DIR, "screen.png");
      x11drive(env, ["shot", file]);
      return `screenshot: ${file}`;
    }

    case "dropBesideTerminal":
    case "dropOnTerminal":
    case "dragSessionToWorkspace":
    case "copyViaContextMenu":
    case "pasteViaContextMenu":
    case "closeWithWindowButton": {
      const steps = { dropBesideTerminal, dropOnTerminal, dragSessionToWorkspace, copyViaContextMenu, pasteViaContextMenu, closeWithWindowButton };
      try {
        return await steps[action](env);
      } catch (error) {
        await closeApp(env).catch(() => {});
        stopTestDisplay(env);
        throw error;
      } finally {
        if (action === "closeWithWindowButton") stopTestDisplay(env);
      }
    }

    case "close": {
      await closeApp(env);
      return "app closed";
    }

    case "checkAlive":
    case "broadcastCheck":
    case "oscRestoreDevin":
    case "oscDevinStorm":
    case "oscRealDevin":
    case "oscCheck":
    case "floodBaseline":
    case "floodAfterClose":
    case "pasteLine":
    case "editorReadFail":
    case "openGitInspect":
    case "gitRestoreDeleted": {
      const steps = {
        checkAlive, broadcastCheck, oscRestoreDevin, oscDevinStorm, oscRealDevin, oscCheck, floodBaseline, floodAfterClose, pasteLine, editorReadFail, openGitInspect, gitRestoreDeleted,
      };
      try {
        return await steps[action](env);
      } catch (error) {
        await closeApp(env).catch(() => {});
        stopTestDisplay(env);
        throw error;
      }
    }

    // Close the app after a test-display flow and stop the display.
    case "closeAndStopDisplay": {
      try {
        await closeApp(env);
      } finally {
        stopTestDisplay(env);
      }
      return "app closed";
    }

    // Wait for the "Talk about this" sub-shell to spawn and run the seed
    // command (`devin -- "<prompt>"`), then for the tab to persist its
    // fallback resumeCommand once the first spawn resolved.
    case "waitTalkSeed": {
      const tab = findShellTab(env);
      try {
        await waitForOutput(env, tab.id, (s) => s.includes("SEEDED TALK SESSION"), 30000);
      } catch (error) {
        await closeApp(env);
        throw error;
      }
      const seeded = await waitForTabField(
        env,
        (t) => typeof t.resumeCommand === "string" && t.resumeCommand.length > 0,
      );
      return `talk seeded, resumeCommand=${seeded.resumeCommand.split(";")[0]}`;
    }

    // Type /exit into the talk sub-shell: fake devin prints its resume hint,
    // which SubShellView must capture into the tab's resumeCommand.
    case "exitTalk": {
      const tab = findShellTab(env);
      await writeToSession(env, tab.id, "/exit\r");
      try {
        await waitForOutput(env, tab.id, (s) => s.includes("devin -r gray-party"), 30000);
      } catch (error) {
        await closeApp(env);
        throw error;
      }
      const captured = await waitForTabField(
        env,
        (t) => (t.resumeCommand ?? "").startsWith("devin -r gray-party"),
      );
      return `resume captured: ${captured.resumeCommand.split(";")[0]}`;
    }

    // Reopen the app: the talk tab must resume the recorded agent session —
    // `devin -r <name>` when a name was captured, `devin -c` otherwise —
    // and must never re-run the seed command.
    case "reopenTalk": {
      const tab = findShellTab(env);
      const rc = tab.resumeCommand ?? "";
      const expected = rc.startsWith("devin -r ")
        ? `Resuming devin session: ${rc.slice("devin -r ".length).split(";")[0].trim()}`
        : rc.startsWith("devin -c")
          ? "Continuing devin session"
          : null;
      if (!expected) throw new Error(`unexpected saved resumeCommand: ${rc}`);
      await startApp(env);
      try {
        const out = await waitForOutput(env, tab.id, (s) => s.includes(expected), 45000);
        if (out.includes("SEEDED TALK SESSION")) {
          throw new Error("talk tab re-seeded a new devin session instead of resuming");
        }
      } finally {
        await closeApp(env);
      }
      return `talk resumed via '${rc.split(";")[0]}'`;
    }

    case "reopen": {
      const saved = await readRestoredState(env);
      const expected = env.AXN_TERM_USE_REAL_DEVIN === "true" ? env.AXN_TERM_DEVIN_SESSION : "gray-party";
      if (saved.name !== expected) throw new Error(`expected captured ${expected}, got ${saved.name}`);
      await startApp(env);
      const id = env.AXN_TERM_SESSION_ID;
      const waitFor = env.AXN_TERM_DEVIN_WAIT_FOR ?? `Resuming devin session: ${expected}`;
      try {
        await waitForOutput(env, id, (s) => s.includes(waitFor));
      } finally {
        await closeApp(env);
      }
      const { summary } = await readRestoredState(env);
      return summary;
    }

    // Launch a fresh fake `claude` in the session and wait until the app
    // sees it as the foreground process — onClose only drives the graceful
    // exit while claude is foreground.
    case "runClaude": {
      const id = env.AXN_TERM_SESSION_ID;
      // Real claude (AXN_TERM_CLAUDE_SESSION): resume an existing
      // conversation — a fresh one has no transcript, so claude would print
      // no resume hint on exit — and no prompt is sent, so no model call.
      const real = env.AXN_TERM_CLAUDE_SESSION;
      try {
        await writeToSession(env, id, real ? `claude --resume ${real}\r` : "claude\r");
        if (!real) await waitForOutput(env, id, (s) => s.includes("claude interactive"));
        await waitForState(env, (state) =>
          /claude/i.test(
            (state.windows ?? [])
              .flatMap((w) => w.sessions ?? [])
              .find((s) => s.id === id)?.process ?? "",
          ),
          15000,
        );
      } catch (error) {
        await closeApp(env);
        throw error;
      }
      return "claude running";
    }

    // After close: the saved state must carry the conversation id claude
    // printed on exit (not the stale one); reopening must resume exactly it.
    case "reopenClaude": {
      const session = (readStateFile(env).windows ?? [])
        .flatMap((w) => w.sessions ?? [])
        .find((s) => s.id === env.AXN_TERM_SESSION_ID);
      const expected = env.AXN_TERM_CLAUDE_SESSION ?? FAKE_CLAUDE_ID;
      const captured = session?.pluginState?.claude?.claudeResumeId ?? "none";
      if (captured !== expected) {
        throw new Error(`expected captured claude id ${expected}, got ${captured} ${logTail(env)}`);
      }
      await startApp(env);
      try {
        // Real claude: the injected restore line itself is the evidence,
        // plus claude becoming the foreground process again.
        await waitForOutput(
          env,
          env.AXN_TERM_SESSION_ID,
          (s) => s.includes(env.AXN_TERM_CLAUDE_SESSION
            ? `claude --resume ${expected}`
            : `Resuming claude conversation: ${expected}`),
        );
        if (env.AXN_TERM_CLAUDE_SESSION) {
          await waitForState(env, (state) =>
            /claude/i.test(
              (state.windows ?? [])
                .flatMap((w) => w.sessions ?? [])
                .find((s) => s.id === env.AXN_TERM_SESSION_ID)?.process ?? "",
            ),
            20000,
          );
        }
      } finally {
        await closeApp(env);
      }
      return `claude restored: ${captured}`;
    }

    // Real claude: launch it, name the conversation with /rename and wait
    // until the plugin has seen the name — claude clears its terminal title
    // on exit, so the name must be caught while it runs. `runClaudeEmpty`
    // sends no prompt (no model call, no conversation: nothing may be
    // recorded); `runClaudeConversation` sends one tiny prompt to haiku.
    case "runClaudeEmpty":
      return await runClaudeTitled(env, false);
    case "runClaudeConversation":
      return await runClaudeTitled(env, true);

    // Leave claude with /exit. An empty conversation must leave no resume
    // record; a real one must.
    case "exitClaude": {
      const id = env.AXN_TERM_SESSION_ID;
      const expectRecord = env.AXN_TERM_EXPECT_RECORD === "true";
      const session = (state) =>
        (state.windows ?? []).flatMap((w) => w.sessions ?? []).find((x) => x.id === id);
      try {
        await writeToSession(env, id, "/exit");
        await sleep(1000);
        await writeToSession(env, id, "\r");
        await waitForState(
          env,
          (state) =>
            !/claude/i.test(session(state)?.process ?? "") &&
            (!expectRecord || !!session(state)?.pluginState?.claude?.last),
          45000,
        );
        if (!expectRecord) {
          // Past the plugin's exit-capture window, then a state flush.
          await sleep(8000);
          const last = session(readStateFile(env))?.pluginState?.claude?.last;
          if (last) throw new Error(`an empty conversation was recorded: ${JSON.stringify(last)}`);
        }
      } catch (error) {
        await closeApp(env);
        throw new Error(`claude exit: ${error.message}; ${logTail(env)}`);
      }
      return expectRecord ? "claude exited, resume record exists" : "claude exited, nothing recorded";
    }

    // The saved resume record carries the name given while claude ran, the
    // conversation id, and is in the right-click list.
    case "verifyClaudeTitle": {
      const title = env.AXN_TERM_CLAUDE_TITLE;
      const s = (readStateFile(env).windows ?? [])
        .flatMap((w) => w.sessions ?? [])
        .find((x) => x.id === env.AXN_TERM_SESSION_ID);
      const claude = s?.pluginState?.claude ?? {};
      const last = claude.last;
      if (last?.title !== title) {
        throw new Error(`resume record title is ${JSON.stringify(last?.title)}, expected '${title}': ${JSON.stringify(last)}`);
      }
      if (!/--resume \S+/.test(last.command ?? "")) {
        throw new Error(`resume record has no conversation id: ${JSON.stringify(last)}`);
      }
      if (claude.history?.[0]?.title !== title) {
        throw new Error(`history[0] is ${JSON.stringify(claude.history?.[0])}, expected title '${title}'`);
      }
      if (claude.seenTitle !== undefined) {
        throw new Error(`seenTitle should be cleared after the record, got ${JSON.stringify(claude.seenTitle)}`);
      }
      return `resume record carries '${last.title}' (${last.command})`;
    }

    // Write remote-control settings into the run's config.yaml. Runs inside
    // the temp state dir, so the real ~/.axn-term/config.yaml is untouched.
    // Values come from env: AXN_TERM_REMOTE_ISSUER / _HUB / _SESSION /
    // _CLIENT_ID / _TOKEN (all optional).
    case "remoteConfig": {
      const stateDir = env.AXN_TERM_STATE_DIR;
      if (!stateDir) throw new Error("AXN_TERM_STATE_DIR not set");
      const lines = [];
      if (env.AXN_TERM_REMOTE_ISSUER) lines.push(`remoteAuthIssuer: ${env.AXN_TERM_REMOTE_ISSUER}`);
      if (env.AXN_TERM_REMOTE_CLIENT_ID) lines.push(`remoteAuthClientId: ${env.AXN_TERM_REMOTE_CLIENT_ID}`);
      if (env.AXN_TERM_REMOTE_HUB) lines.push(`remoteAuthorityUrl: ${env.AXN_TERM_REMOTE_HUB}`);
      if (env.AXN_TERM_REMOTE_SESSION) lines.push(`remoteAuthoritySession: ${env.AXN_TERM_REMOTE_SESSION}`);
      if (env.AXN_TERM_REMOTE_TOKEN) lines.push(`remoteAuthorityToken: ${env.AXN_TERM_REMOTE_TOKEN}`);
      writeFileSync(join(stateDir, "config.yaml"), lines.join("\n") + "\n");
      // The config watch polls every ~1.5 s — give it a moment to apply.
      await sleep(2500);
      return `remote config written: ${lines.length} keys`;
    }

    // Trigger the app's real remoteAuth.signIn() (POST /remote-auth evals
    // window.__axnRemoteAuth.signIn() in the webview), then poll
    // GET /remote-auth until the device POST resolves — 'pending' means the
    // device endpoint accepted client_id (exactly what the -H quoting bug
    // broke). On 'error' we surface the app's own error text.
    case "remoteSignIn": {
      await rc(env, "/remote-auth", { method: "POST" });
      const deadline = Date.now() + 20000;
      let last;
      while (Date.now() < deadline) {
        const res = await rc(env, "/remote-auth");
        const snap = JSON.parse(await res.text());
        last = snap;
        if (snap?.state === "pending") {
          // Persist for later steps (Playwright approval + await).
          env.AXN_TERM_REMOTE_USER_CODE = snap.userCode;
          env.AXN_TERM_REMOTE_VERIFICATION_URI = snap.verificationUri;
          return `sign-in pending: user_code=${snap.userCode} uri=${snap.verificationUri}`;
        }
        if (snap?.state === "error") {
          throw new Error(`remote sign-in failed in-app: ${snap.error}`);
        }
        if (snap?.state === "signedIn") return `already signed in: ${snap.user}`;
        await sleep(500);
      }
      throw new Error(`remote sign-in never reached pending: ${JSON.stringify(last)} ${logTail(env)}`);
    }

    // Approve the pending device grant in a real headless Chromium —
    // replaces the human who would click through the verification page.
    // Uses the verification URI the remoteSignIn step captured.
    case "remoteApprove": {
      const uri = env.AXN_TERM_REMOTE_VERIFICATION_URI;
      if (!uri) throw new Error("AXN_TERM_REMOTE_VERIFICATION_URI not set — run remoteSignIn first");
      const { chromium } = await import("playwright-core");
      const { findChromium } = await import("../orchestrators/playwright.ts");
      const executablePath = env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || findChromium();
      if (!executablePath) throw new Error("no Playwright Chromium executable found");
      const browser = await chromium.launch({ executablePath, headless: true });
      try {
        const context = await browser.newContext({ ignoreHTTPSErrors: true });
        const page = await context.newPage();
        await page.goto(uri, { waitUntil: "networkidle" });
        console.log(`approve P1: ${page.url().slice(0, 100)}`);
        // 1) Device page — the user_code entry form (prefilled when the URI
        //    carries it) must be submitted first.
        const code = page.locator('input[name="device_user_code"]');
        if (await code.isVisible().catch(() => false)) {
          if (!(await code.inputValue()).trim()) {
            await code.fill(env.AXN_TERM_REMOTE_USER_CODE ?? "");
          }
          await page.locator('input[type="submit"], button[type="submit"]').first().click();
          await page.waitForLoadState("networkidle");
          console.log(`approve P2 (after code): ${page.url().slice(0, 100)}`);
        }
        // 2) Keycloak login (skipped when a session already exists).
        const user = page.locator('input[name="username"]');
        if (await user.isVisible().catch(() => false)) {
          await user.fill(env.TEST_USER ?? "demo");
          await page.locator('input[name="password"]').fill(env.TEST_PASSWORD ?? "changeme");
          await page.locator("#kc-login").click();
          await page.waitForLoadState("networkidle");
          console.log(`approve P3 (after login): ${page.url().slice(0, 100)}`);
        }
        // 3) Approval form — click the "Yes" button specifically (a generic
        //    submit selector can hit "No" first and silently deny the grant).
        await page.locator('button:has-text("Yes"), input[type="submit"][value="Yes"]').first().click();
        await page.waitForLoadState("networkidle");
        console.log(`approve P4 (after Yes): ${page.url().slice(0, 100)} — ${(await page.locator('body').innerText()).slice(0, 80)}`);
        return `device grant approved for ${env.TEST_USER ?? "demo"}`;
      } finally {
        await browser.close();
      }
    }

    // Poll GET /remote-auth for a target state (default signedIn) — used
    // after the device grant is approved in the browser.
    case "remoteAuthAwait": {
      const want = env.AXN_TERM_REMOTE_WANT ?? "signedIn";
      const deadline = Date.now() + Number(env.AXN_TERM_REMOTE_TIMEOUT ?? 30000);
      let last;
      while (Date.now() < deadline) {
        const res = await rc(env, "/remote-auth");
        const snap = JSON.parse(await res.text());
        last = snap;
        if (snap?.state === want) return `remote auth ${want}: ${snap.user ?? ""}`.trim();
        if (snap?.state === "error") throw new Error(`remote auth error: ${snap.error}`);
        await sleep(500);
      }
      throw new Error(`remote auth never reached ${want}: ${JSON.stringify(last)} ${logTail(env)}`);
    }

    default:
      throw new Error(`Unknown axn-term action: ${action}`);
  }
}

// The axn-dev flow runner can execute this file two ways:
//  - in-process: the adapter registry imports the module and calls
//    run(step, env) with a shared env object, or
//  - subprocess: each step spawns `tsx axnTerm.js` with the step JSON in
//    AXN_STEP. In that mode AXN_TERM_* env values are persisted to a temp
//    file so later steps can see what earlier steps set up.
if (process.env.AXN_STEP) {
  (async () => {
    const envFile = join(
      tmpdir(),
      `axn-term-adapter-${(process.env.AXN_FLOW_DIR ?? process.cwd()).replace(/[^a-zA-Z0-9]/g, "_")}.json`,
    );
    const step = JSON.parse(process.env.AXN_STEP);
    const env = { ...process.env };
    // 'prepare' starts a fresh run — never pick up env values persisted by a
    // previous flow (a stale AXN_TERM_STATE_DIR would point at old state).
    const isPrepare = (step.args?.action ?? "").startsWith("prepare");
    if (!isPrepare && existsSync(envFile)) {
      try {
        Object.assign(env, JSON.parse(readFileSync(envFile, "utf8")));
      } catch { /* ignore a corrupt env file */ }
    }
    try {
      const result = await run(step, env);
      if (result !== undefined && result !== null) {
        console.log(typeof result === "string" ? result : JSON.stringify(result));
      }
    } finally {
      const persisted = {};
      for (const [key, value] of Object.entries(env)) {
        if (key.startsWith("AXN_TERM_")) persisted[key] = value;
      }
      // Holds the remote-control token — keep it private to the user.
      writeFileSync(envFile, JSON.stringify(persisted, null, 2), { mode: 0o600 });
      chmodSync(envFile, 0o600);
    }
  })().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exitCode = 1;
  });
}
