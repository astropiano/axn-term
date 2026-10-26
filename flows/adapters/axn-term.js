import { spawn, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
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
      ...process.env,
      AXN_TERM_STATE_DIR: stateDir,
      AXN_TERM_REMOTE_CONTROL_PORT: env.AXN_TERM_REMOTE_CONTROL_PORT,
      AXN_TERM_REMOTE_CONTROL_TOKEN: env.AXN_TERM_REMOTE_CONTROL_TOKEN,
      LOG_LEVEL: "debug",
      PATH: `${binDir}:${process.env.PATH}`,
      // Agent hook installs write here instead of the user's ~/.claude etc.
      ...(env.AXN_TERM_AGENT_CONFIG_ROOT ? { AXN_TERM_AGENT_CONFIG_ROOT: env.AXN_TERM_AGENT_CONFIG_ROOT } : {}),
      ...(existsSync(shellShim) ? { SHELL: shellShim } : {}),
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
  return sessionId;
}

async function closeApp(env) {
  const stateDir = env.AXN_TERM_STATE_DIR;
  const child = procs.get(stateDir);
  await closeRemoteApp(env);
  if (child) {
    await waitForProcessExit(child);
    procs.delete(stateDir);
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
    workspaces: [{ id: workspaceId1, name: "axn-term" }],
    sessions: [devinSession],
    selectedWorkspaceId: workspaceId1,
    selectedSessionId: sessionId,
  };

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
  if (env.AXN_TERM_USE_REAL_DEVIN === "true" && !env.AXN_TERM_DEVIN_SESSION) {
    throw new Error("Set AXN_TERM_DEVIN_SESSION to an available real Devin session before running this flow");
  }
  const variant = env.AXN_TERM_TEST_VARIANT ?? "single";
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
  if (variant === "claude") {
    plugins += `claude:
  enabled: true
  restore-session: true
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

  const devinSessionName = env.AXN_TERM_DEVIN_SESSION ?? "green-aurora";
  const state = buildInitialState(stateDir, sessionCwd, variant, devinSessionName);
  writeFileSync(join(stateDir, "state.json"), JSON.stringify(state, null, 2));

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

export async function run(step, env) {
  const action = step.args?.action ?? "help";

  switch (action) {
    case "prepare":
      return await prepare(env);

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

    // `axn-mr-review <url>` typed in the repo session must fetch the MR head
    // from the bare origin, create worktree wt/mr-5, open a session there and
    // auto-run the workflow's headless probe (check `inspect:probe` → ok).
    case "mrReview": {
      const id = env.AXN_TERM_SESSION_ID;
      const url =
        env.AXN_TERM_MR_URL ?? "https://gitlab.com/group/repo/-/merge_requests/5";
      await sendCommand(env, id, `axn-mr-review ${url}`);
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
      await sendCommand(env, id, "axn-workflow-start harden");
      await waitForState(env, () => binding().state === "build" && /^[0-9a-f]{16}$/.test(binding().token ?? ""));
      const token = binding().token;
      await sendCommand(env, id, "axn-workflow-run token-env");
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

    case "close": {
      await closeApp(env);
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
    const isPrepare = (step.args?.action ?? "") === "prepare";
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
