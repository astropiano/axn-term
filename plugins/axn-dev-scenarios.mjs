// axn-term external plugin: shows axn-dev scenarios that are running for the
// repository the session's cwd belongs to.
//
// Install:
//   mkdir -p ~/.axn-term/plugins
//   cp plugins/axn-dev-scenarios.mjs ~/.axn-term/plugins/
//   # enable in ~/.axn-term/plugins.yaml:
//   #   axn-dev-scenarios:
//   #     enabled: true
//
// External plugins get the standard ctx API: session, updateSession,
// writeToSession, updatePluginState, pluginState, pluginSettings,
// waitForSessionOutput and exec(command, cwd?). `render` may return a plain
// string (JSX is not available in .mjs modules).

const REFRESH_MS = 60_000;
const timers = new Map(); // sessionId -> interval handle

// Built via fromCharCode so the file itself contains no raw escape bytes.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI = new RegExp(
  `${ESC}(?:\\[[0-9;?]*[ -/]*[@-~]|\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)|[@-Z\\\\-_]|\\([A-Za-z0-9]|\\)[A-Za-z0-9])`,
  'g',
);
const RUNNING = /\u25CF\s*running|\brunning\b/i;
const SECTION_HEADER = /^\s{0,2}([A-Za-z0-9_.-]+):\s*$/;
const WORKTREE = /\[worktree:[^\]]*?@\s*([^\]]+)\]/;

function baseName(path) {
  return (path ?? '').replace(/\/+$/, '').split('/').pop() ?? '';
}

/** Parse `axn-dev list` output for scenarios running under the given repo. */
function runningForRepo(listText, repoName) {
  const running = [];
  let inProject = false;
  let currentRepo = null;
  for (const rawLine of listText.split('\n')) {
    const line = rawLine.replace(ANSI, '');
    if (/^Global scenarios:/.test(line)) {
      inProject = false;
      continue;
    }
    if (/^Project scenarios:/.test(line)) {
      inProject = true;
      continue;
    }
    const header = SECTION_HEADER.exec(line);
    if (inProject && header) {
      currentRepo = header[1];
      continue;
    }
    if (!RUNNING.test(line)) continue;
    const worktree = WORKTREE.exec(line);
    const inRepoSection = inProject && currentRepo === repoName;
    const inWorktree = worktree && baseName(worktree[1].trim()) === repoName;
    if (inRepoSection || inWorktree) {
      const name = line.trim().split(/\s+/)[0];
      if (name) running.push(name);
    }
  }
  return running;
}

async function refresh(ctx) {
  const cwd = ctx.session.cwd;
  if (!cwd) return;
  try {
    const root = (await ctx.exec('git rev-parse --show-toplevel 2>/dev/null', cwd)).trim();
    if (!root) return;
    const repo = baseName(root);
    const list = await ctx.exec('axn-dev list 2>/dev/null', cwd);
    const running = runningForRepo(list, repo);
    ctx.updatePluginState({ running, repo });
  } catch {
    // git/axn-dev unavailable or not a repo — leave the last state in place.
  }
}

export default {
  id: 'axn-dev-scenarios',
  title: 'axn-dev scenarios',
  stateKey: 'axn-dev-scenarios',
  settingsKey: 'axn-dev-scenarios',

  render(ctx) {
    const state = ctx.pluginState ?? {};
    const running = Array.isArray(state.running) ? state.running : [];
    if (running.length === 0) return null;
    return `● axn-dev (${state.repo ?? 'repo'}): ${running.join(', ')} running`;
  },

  onSessionOpen(ctx) {
    if (timers.has(ctx.session.id)) return;
    void refresh(ctx);
    timers.set(
      ctx.session.id,
      setInterval(() => void refresh(ctx), REFRESH_MS),
    );
  },

  onClose(ctx) {
    const timer = timers.get(ctx.session.id);
    if (timer) {
      clearInterval(timer);
      timers.delete(ctx.session.id);
    }
  },
};
