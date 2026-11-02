import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ClipboardCopy,
  FileText,
  FolderOpen,
  NotebookPen,
  RefreshCw,
  X,
} from 'lucide-react';
import type {
  PluginApi,
  RepoMenuItem,
  SessionViewContext,
  SessionViewPlugin,
} from './plugin';
import type { ShellSession } from '../../types';
import { shellQuote } from '../../shellQuote';
import { shellServices } from '../../services';
import { pickOrCreate } from '../pickerHost';
import { slugify } from './worktrees';
import { splitHead } from './awesomeList';

type Ctx = SessionViewContext & PluginApi;

// ---------------------------------------------------------------------------
// Pattern config — plugins.yaml `scratchpad.patterns`
//
//   *: .local-drafts, drafts          — every repo looks in these folders
//   axn-term|tassistant: .ai, notes   — repos whose name matches the regex also
//                                     look in these folders
//   .drafts                           — no repo part: applies to all repos
//
// Entries are `;`- or newline-separated `repo-regex: dir, dir, …` pairs. The
// regex is matched case-insensitively against both the checkout's directory
// name (e.g. `axn-term-feat-foo` for a worktree) and the remote's repo name
// (e.g. `axn-term`), so one entry covers a repo and all its worktrees.
// ---------------------------------------------------------------------------

export interface ScratchPattern {
  /** The repo matcher as written (regex source, `*` = all repos). */
  repo: string;
  re: RegExp;
  /** Repo-relative draft folders this entry contributes. */
  dirs: string[];
}

export function parsePatterns(raw: unknown): ScratchPattern[] {
  const text = typeof raw === 'string' ? raw : '';
  const out: ScratchPattern[] = [];
  for (const part of text.split(/[;\n]/)) {
    const entry = part.trim();
    if (!entry) continue;
    const ci = entry.indexOf(':');
    const repo = (ci === -1 ? '*' : entry.slice(0, ci)).trim() || '*';
    const dirs = (ci === -1 ? entry : entry.slice(ci + 1))
      .split(',')
      .map((d) => d.trim().replace(/^\/+|\/+$/g, ''))
      .filter(Boolean);
    if (!dirs.length) continue;
    try {
      out.push({ repo, dirs, re: new RegExp(repo === '*' ? '.*' : repo, 'i') });
    } catch {
      // malformed regex — skip the entry
    }
  }
  return out;
}

/** Ordered, deduped draft dirs for a repo — the union of all matching patterns. */
export function dirsForRepo(patterns: ScratchPattern[], names: string[]): string[] {
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const p of patterns) {
    if (!names.some((n) => p.re.test(n))) continue;
    for (const d of p.dirs) {
      if (!seen.has(d)) {
        seen.add(d);
        dirs.push(d);
      }
    }
  }
  return dirs;
}

function baseName(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() ?? path;
}

/** Repo name from a remote URL (`git@h:g/r.git`, `https://h/g/r` → `r`). */
export function remoteRepoName(remote: string): string {
  const trimmed = remote.trim().replace(/\/+$/, '').replace(/\.git$/, '');
  return trimmed.split(/[/:]/).filter(Boolean).pop() ?? '';
}

// ---------------------------------------------------------------------------
// Resolution — which folders are the scratchpad for this session's repo
// ---------------------------------------------------------------------------

export interface ScratchpadLocation {
  repoRoot: string;
  /** Primary name — the checkout dir basename (a worktree's own name). */
  repoName: string;
  /** Names patterns match against: checkout basename + remote repo name. */
  names: string[];
  /** All configured dirs for this repo (repo-relative, deduped, ordered). */
  dirs: string[];
  /** Configured dirs that already exist on disk. */
  existing: string[];
  /** Dir new drafts go into — first existing, else first configured. */
  primary: string;
}

interface ScratchpadSettings {
  patterns?: string;
  defaultExt?: string;
  gitignoreDrafts?: boolean;
}

function settingsOf(ctx: Ctx): ScratchpadSettings {
  return (ctx.pluginSettings ?? {}) as ScratchpadSettings;
}

function patternsOf(ctx: Ctx): ScratchPattern[] {
  return parsePatterns(settingsOf(ctx).patterns);
}

/**
 * The repo the scratchpad belongs to: the session's detected repo first,
 * then the live cwd's toplevel, then the workspace's anchor folder.
 */
async function resolveRepoRoot(ctx: Ctx): Promise<string | null> {
  const root = ctx.getSession().repo?.root;
  if (root) return root;
  const cwd = await ctx.getCwd();
  if (cwd) {
    const top = await ctx
      .exec('git rev-parse --show-toplevel', cwd)
      .catch(() => '');
    if (top) return top;
  }
  const folder = ctx.getWorkspace?.()?.defaultFolder;
  if (folder) {
    const top = await ctx
      .exec('git rev-parse --show-toplevel', folder)
      .catch(() => '');
    if (top) return top;
  }
  return null;
}

/**
 * Resolve the session's scratchpad: its repo, the configured dirs matching
 * the repo's names, which of them exist, and where new drafts go. `null`
 * outside a repo or when no pattern matches the repo's names.
 */
export async function resolveScratchpad(ctx: Ctx): Promise<ScratchpadLocation | null> {
  const repoRoot = await resolveRepoRoot(ctx);
  if (!repoRoot) return null;
  const remote =
    ctx.getSession().repo?.remote ??
    (await ctx.exec('git remote get-url origin', repoRoot).catch(() => ''));
  const names = [
    ...new Set([baseName(repoRoot), remoteRepoName(remote)].filter(Boolean)),
  ];
  const dirs = dirsForRepo(patternsOf(ctx), names);
  if (!dirs.length) return null;
  const existing: string[] = [];
  for (const dir of dirs) {
    const stat = await ctx.statPath(dir, repoRoot).catch(() => null);
    if (stat?.isDir) existing.push(dir);
  }
  return {
    repoRoot,
    repoName: names[0] ?? baseName(repoRoot),
    names,
    dirs,
    existing,
    primary: existing[0] ?? dirs[0],
  };
}

// ---------------------------------------------------------------------------
// Drafts — plain files inside the scratchpad dirs (filesystem-as-context: an
// agent reads/writes them with its own tools; the plugin only has to say
// where they are)
// ---------------------------------------------------------------------------

export interface DraftFile {
  /** Repo-relative dir holding the file. */
  dir: string;
  name: string;
  /** Absolute path. */
  path: string;
}

export async function listDrafts(
  ctx: Ctx,
  loc: ScratchpadLocation,
): Promise<DraftFile[]> {
  const out: DraftFile[] = [];
  for (const dir of loc.existing) {
    const entries = await ctx.listDir(dir, loc.repoRoot).catch(() => null);
    for (const e of entries ?? []) {
      if (e.isFile && e.name !== '.gitignore') {
        out.push({ dir, name: e.name, path: `${loc.repoRoot}/${dir}/${e.name}` });
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Filename for a draft title — slug + extension (`notes.txt` keeps `.txt`). */
export function draftFileName(raw: string, ext: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return `draft-${stamp()}.${ext}`;
  const dot = trimmed.lastIndexOf('.');
  if (dot > 0 && /\.[a-z0-9]{1,8}$/i.test(trimmed.slice(dot))) {
    const stem = slugify(trimmed.slice(0, dot)) || 'draft';
    return `${stem}${trimmed.slice(dot).toLowerCase()}`;
  }
  return `${slugify(trimmed) || 'draft'}.${ext}`;
}

/**
 * Create (or find) a draft file: makes the primary dir when missing — seeding
 * a `*` .gitignore so the drafts folder is self-ignoring and never pollutes
 * `git status` — then creates `<name>.<ext>` with a title heading when the
 * file does not exist yet. Resolves the absolute path.
 */
async function createDraft(
  ctx: Ctx,
  loc: ScratchpadLocation,
  rawName: string,
): Promise<string> {
  const ext = (settingsOf(ctx).defaultExt ?? 'md').replace(/^\./, '') || 'md';
  const name = draftFileName(rawName, ext);
  if (!loc.existing.includes(loc.primary)) {
    await ctx.mkdir(loc.primary, loc.repoRoot);
    if (settingsOf(ctx).gitignoreDrafts !== false) {
      await ctx
        .writeFile(`${loc.primary}/.gitignore`, '*\n', loc.repoRoot)
        .catch(() => {});
    }
  }
  const path = `${loc.repoRoot}/${loc.primary}/${name}`;
  if (!(await ctx.statPath(path).catch(() => null))) {
    await ctx.writeFile(path, `# ${rawName.trim() || name}\n\n`).catch(() => {});
  }
  return path;
}

/** Match `open <arg>` against drafts: 1-based index, filename, or name sans ext. */
export function findDraft(drafts: DraftFile[], arg: string): DraftFile | undefined {
  const needle = arg.trim().replace(/^["']|["']$/g, '');
  if (/^\d+$/.test(needle)) return drafts[Number(needle) - 1];
  return drafts.find(
    (f) => f.name === needle || f.name.replace(/\.[^.]+$/, '') === needle,
  );
}

// ---------------------------------------------------------------------------
// Agent discoverability — a short instruction block the user can paste into
// AGENTS.md/CLAUDE.md (`axn-scratch hint` / "Copy agent hint"), or push into
// a running agent's input line ("Tell agent about scratchpad")
// ---------------------------------------------------------------------------

export function agentHintLines(loc: ScratchpadLocation): string[] {
  const list = loc.dirs.map((d) => `\`${d}/\``).join(', ');
  return [
    `Scratchpad: drafts and working notes for this repo live in ${list} (repo-relative, gitignored).`,
    `Check them for existing notes before starting work; write plans and notes as \`<topic>.md\` files in \`${loc.primary}/\`.`,
  ];
}

function agentHintPrompt(loc: ScratchpadLocation): string {
  return `My drafts and working notes for this repo live in ${loc.primary}/ (repo-relative). Check it for existing notes before starting work, and store working notes there. `;
}

// ---------------------------------------------------------------------------
// Per-session state — the repo's configured dirs, for the context-menu rows
// (sessionMenuItems is synchronous and cannot resolve the repo on the spot)
// ---------------------------------------------------------------------------

interface ScratchpadState {
  dirs?: string[];
}

function stateOf(ctx: Ctx): ScratchpadState {
  return (ctx.pluginState ?? {}) as ScratchpadState;
}

const refreshTimers = new Map<string, number>();
const REFRESH_DELAY_MS = 800;

async function refreshDirs(ctx: Ctx): Promise<void> {
  const loc = await resolveScratchpad(ctx);
  const next = loc?.dirs ?? [];
  if (JSON.stringify(stateOf(ctx).dirs ?? []) !== JSON.stringify(next)) {
    ctx.updatePluginState({ dirs: next });
  }
}

/** Output settles → the session may have cd'd to another repo → re-resolve. */
function scheduleRefresh(ctx: Ctx): void {
  const id = ctx.session.id;
  const existing = refreshTimers.get(id);
  if (existing !== undefined) window.clearTimeout(existing);
  refreshTimers.set(
    id,
    window.setTimeout(() => {
      refreshTimers.delete(id);
      void refreshDirs(ctx);
    }, REFRESH_DELAY_MS),
  );
}

// ---------------------------------------------------------------------------
// Shared actions — session menu + strip + commands
// ---------------------------------------------------------------------------

const AGENT_RE = /claude|devin|codex|agy|antigravity|vibe/i;

async function draftPicker(ctx: Ctx): Promise<void> {
  const loc = await resolveScratchpad(ctx);
  if (!loc) {
    ctx.setBanner({
      level: 'error',
      message:
        'scratchpad: not inside a git repo, or no pattern matches it (Settings → Plugins → scratchpad)',
    });
    return;
  }
  const drafts = await listDrafts(ctx, loc);
  const pick = await pickOrCreate({
    title: `${loc.repoName} scratchpad — ${loc.primary}/`,
    placeholder: 'Draft name…',
    items: drafts.map((f) => ({
      key: f.path,
      label: f.name,
      group: `${f.dir}/`,
    })),
    createLabel: (q) => `New draft "${q}"`,
  });
  if (!pick) return;
  const path = pick.created ? await createDraft(ctx, loc, pick.key) : pick.key;
  ctx.openTab({ path, kind: 'editor' });
}

async function openFolder(ctx: Ctx, dir?: string): Promise<void> {
  const loc = await resolveScratchpad(ctx);
  if (!loc) {
    ctx.setBanner({ level: 'error', message: 'scratchpad: no matching folder configured' });
    return;
  }
  const target = dir && loc.dirs.includes(dir) ? dir : loc.primary;
  ctx.openBrowser(`${loc.repoRoot}/${target}`);
}

async function copyHint(ctx: Ctx): Promise<void> {
  const loc = await resolveScratchpad(ctx);
  if (!loc) return;
  void shellServices()?.copyText(agentHintLines(loc).join('\n'));
}

async function sendHint(ctx: Ctx): Promise<void> {
  const loc = await resolveScratchpad(ctx);
  if (!loc) return;
  // No trailing newline — the hint lands in the agent's input buffer and the
  // user reviews/submits it.
  await ctx.writeToSession(agentHintPrompt(loc));
}

// ---------------------------------------------------------------------------
// `axn-scratch` / `axn-draft` — shell-facing surface. Prints real paths into
// the scrollback so an agent reading the terminal learns where drafts live
// and can use its own file tools on them.
// ---------------------------------------------------------------------------

const echoLine = (s: string) => `echo ${shellQuote(s)}`;
const printLines = (lines: string[]) =>
  `printf '%s\\n' ${lines.map(shellQuote).join(' ')}`;

export async function runScratch(
  ctx: Ctx,
  arg: string | undefined,
): Promise<string | false> {
  const loc = await resolveScratchpad(ctx);
  if (!loc) {
    return echoLine(
      'axn-scratch: not inside a git repo, or no pattern matches it (Settings → Plugins → scratchpad)',
    );
  }
  const [sub, rest] = splitHead(arg ?? '');
  switch (sub) {
    case 'dir':
      return echoLine(`${loc.repoRoot}/${loc.primary}`);
    case 'browse':
      ctx.openBrowser(`${loc.repoRoot}/${loc.primary}`);
      return false;
    case 'hint':
      return printLines(agentHintLines(loc));
    case 'tell':
      await sendHint(ctx);
      return false;
    case 'new':
    case 'create': {
      const path = await createDraft(ctx, loc, rest);
      ctx.openTab({ path, kind: 'editor' });
      return echoLine(`scratchpad: ${path}`);
    }
    case 'open': {
      if (!rest) return echoLine('usage: axn-scratch open <name|n>');
      const drafts = await listDrafts(ctx, loc);
      const hit = findDraft(drafts, rest);
      if (!hit) {
        return echoLine(
          drafts.length
            ? `axn-scratch: no draft '${rest}' — see \`axn-scratch ls\``
            : 'axn-scratch: no drafts yet — `axn-scratch new <name>` creates one',
        );
      }
      ctx.openTab({ path: hit.path, kind: 'editor' });
      return false;
    }
    case 'ls':
    case 'list':
    case '': {
      const drafts = await listDrafts(ctx, loc);
      return printLines([
        `scratchpad: ${loc.repoRoot}/${loc.primary}${loc.existing.length > 1 ? ` (+${loc.existing.length - 1} more)` : ''}`,
        ...(drafts.length
          ? drafts.map((f, i) => `  ${i + 1}. ${f.name}${loc.existing.length > 1 ? `  (${f.dir})` : ''}`)
          : ['  (no drafts — `axn-scratch new <name>` creates one)']),
      ]);
    }
    default: {
      // Bare name: open the draft when it exists, create it otherwise.
      const drafts = await listDrafts(ctx, loc);
      const hit = findDraft(drafts, arg ?? '');
      if (hit) {
        ctx.openTab({ path: hit.path, kind: 'editor' });
        return false;
      }
      const path = await createDraft(ctx, loc, arg ?? '');
      ctx.openTab({ path, kind: 'editor' });
      return echoLine(`scratchpad: ${path}`);
    }
  }
}

async function completeScratchArg(ctx: Ctx, argPrefix: string): Promise<string[]> {
  const subs = ['ls', 'new', 'open', 'dir', 'browse', 'hint', 'tell'];
  const loc = await resolveScratchpad(ctx).catch(() => null);
  const drafts = loc ? await listDrafts(ctx, loc).catch(() => []) : [];
  const names = (drafts ?? []).map((f) => f.name);
  const openMatch = /^open\s+([\s\S]*)$/.exec(argPrefix);
  if (openMatch) {
    const p = openMatch[1].trimStart().toLowerCase();
    return names
      .filter((n) => n.toLowerCase().startsWith(p))
      .map((n) => `open ${n.includes(' ') ? `"${n}"` : n}`);
  }
  const p = argPrefix.trim().toLowerCase();
  return [...subs, ...names]
    .filter((c) => c.toLowerCase().startsWith(p))
    .map((c) => (c.includes(' ') ? `"${c}"` : c));
}

// ---------------------------------------------------------------------------
// Full-area view — drafts across every open session's repo
// ---------------------------------------------------------------------------

interface RepoGroup {
  loc: ScratchpadLocation;
  drafts: DraftFile[];
}

function ScratchpadView({
  sessions,
  sessionApi,
  openTab,
  close,
}: {
  sessions: ShellSession[];
  sessionApi: (sessionId: string) => Ctx | undefined;
  openTab?: (tab: { path: string; kind: 'editor' | 'browser' | 'preview' }) => void;
  close: () => void;
}) {
  const [groups, setGroups] = useState<RepoGroup[] | null>(null);
  const sessionApiRef = useRef(sessionApi);
  sessionApiRef.current = sessionApi;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const sessionsKey = sessions.map((s) => `${s.id}:${s.repo?.root ?? ''}`).join('|');

  const load = useCallback(async () => {
    const seen = new Set<string>();
    const out: RepoGroup[] = [];
    for (const s of sessionsRef.current) {
      const api = sessionApiRef.current(s.id);
      if (!api) continue;
      const loc = await resolveScratchpad(api);
      if (!loc || seen.has(loc.repoRoot)) continue;
      seen.add(loc.repoRoot);
      out.push({ loc, drafts: await listDrafts(api, loc) });
    }
    setGroups(out);
  }, []);

  useEffect(() => {
    void load();
  }, [load, sessionsKey]);

  const total = groups?.reduce((n, g) => n + g.drafts.length, 0) ?? 0;
  const rowBtn =
    'flex shrink-0 items-center justify-center rounded p-0.5 text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]';

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg)]">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-secondary)] px-3">
        <NotebookPen className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-primary)]">
          scratchpad
        </span>
        <span className="text-[10px] text-[var(--text-secondary)]">
          {total} draft{total === 1 ? '' : 's'} · {groups?.length ?? 0} repo
          {groups?.length === 1 ? '' : 's'}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => void load()}
          data-tip="Refresh"
          aria-label="Refresh"
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-secondary)] transition hover:bg-[var(--surface)] hover:text-[var(--text-primary)]"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={close}
          data-tip="Close"
          aria-label="Close"
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-secondary)] transition hover:bg-[var(--surface)] hover:text-[var(--text-primary)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {groups === null ? (
          <div className="px-2 py-3 text-[11px] italic text-[var(--text-secondary)]">
            Scanning session repos…
          </div>
        ) : groups.length === 0 ? (
          <div className="px-2 py-3 text-[11px] italic text-[var(--text-secondary)]">
            No drafts — create one from a session's menu or with `axn-scratch new &lt;name&gt;`.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {groups.map((g) => (
              <div key={g.loc.repoRoot}>
                <div className="mb-1 flex items-center gap-2 px-2">
                  <span className="text-[11px] font-semibold text-[var(--text-primary)]">
                    {g.loc.repoName}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-[var(--text-secondary)]">
                    {g.loc.repoRoot}
                  </span>
                  <button
                    type="button"
                    className={rowBtn}
                    data-tip="Copy the AGENTS.md/CLAUDE.md hint for this repo"
                    aria-label="Copy agent hint"
                    onClick={() =>
                      void shellServices()?.copyText(agentHintLines(g.loc).join('\n'))
                    }
                  >
                    <ClipboardCopy className="h-3 w-3" />
                  </button>
                </div>
                {g.loc.dirs.map((dir) => {
                  const files = g.drafts.filter((f) => f.dir === dir);
                  const exists = g.loc.existing.includes(dir);
                  return (
                    <div key={dir}>
                      <button
                        type="button"
                        disabled={!exists}
                        onClick={() =>
                          openTab?.({ path: `${g.loc.repoRoot}/${dir}`, kind: 'browser' })
                        }
                        className="flex w-full items-center gap-2 rounded px-2 py-1 text-left transition enabled:hover:bg-[var(--surface)] disabled:opacity-50"
                        data-tip={exists ? `${g.loc.repoRoot}/${dir}` : `${dir}/ — not created yet`}
                      >
                        <FolderOpen className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />
                        <span className="font-mono text-[11px] text-[var(--text-primary)]">
                          {dir}/
                        </span>
                        {!exists && (
                          <span className="rounded bg-[var(--orange)]/15 px-1 text-[9px] text-[var(--orange)]">
                            not created
                          </span>
                        )}
                      </button>
                      {files.map((f) => (
                        <button
                          key={f.path}
                          type="button"
                          onClick={() => openTab?.({ path: f.path, kind: 'editor' })}
                          data-tip={f.path}
                          className="flex w-full items-center gap-2 rounded py-1 pl-7 pr-2 text-left transition hover:bg-[var(--surface)]"
                        >
                          <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />
                          <span className="min-w-0 truncate font-mono text-[11px] text-[var(--text-primary)]">
                            {f.name}
                          </span>
                        </button>
                      ))}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

export const scratchpadPlugin: SessionViewPlugin = {
  id: 'scratchpad',
  title: 'scratchpad',
  version: '0.1.0',
  settingsKey: 'scratchpad',
  stateKey: 'scratchpad',
  hostsTabs: true,
  defaultEnabled: false,
  settings: [
    {
      key: 'patterns',
      label: 'Draft folder patterns',
      description:
        '`;`-separated `<repo-regex>: <dir>, <dir>` entries, e.g. `*: .local-drafts, drafts; axn-term: .ai, notes`. `*` (or no repo part) matches all repos; the regex is matched against the checkout dir name and the remote repo name. Empty: the plugin does nothing.',
      type: 'string',
      default: '',
    },
    {
      key: 'defaultExt',
      label: 'Default draft extension',
      description: 'Extension for drafts created without one (e.g. md, txt).',
      type: 'string',
      default: 'md',
    },
    {
      key: 'gitignoreDrafts',
      label: 'Auto-gitignore draft folders',
      description:
        'When the plugin creates a draft folder it seeds a `*` .gitignore, so drafts never pollute `git status`.',
      type: 'boolean',
      default: true,
    },
  ],
  commands: [
    {
      name: 'axn-scratch',
      takesArg: true,
      completeArg: completeScratchArg,
      run: (ctx, arg) => runScratch(ctx, arg),
    },
    {
      name: 'axn-draft',
      takesArg: true,
      completeArg: completeScratchArg,
      run: (ctx, arg) => runScratch(ctx, arg),
    },
  ],
  sessionMenuItems: (ctx) => {
    const dirs = stateOf(ctx).dirs ?? [];
    const items: RepoMenuItem[] = dirs.length
      ? dirs
          .slice(0, 6)
          .map((dir) => ({
            label: `Open ${dir}/`,
            onClick: () => void openFolder(ctx, dir),
          }))
      : [{ label: 'Open drafts', onClick: () => void openFolder(ctx) }];
    items.push(
      { label: 'New or open draft…', onClick: () => void draftPicker(ctx) },
      { label: 'Copy agent hint', onClick: () => void copyHint(ctx) },
    );
    if (ctx.session.agentInput || AGENT_RE.test(ctx.session.process ?? '')) {
      items.push({
        label: 'Tell agent about scratchpad',
        onClick: () => void sendHint(ctx),
      });
    }
    return items;
  },
  onSessionOpen: (ctx) => {
    void refreshDirs(ctx);
  },
  onOutput: (ctx) => {
    scheduleRefresh(ctx);
  },
  onClose: (ctx) => {
    const timer = refreshTimers.get(ctx.session.id);
    if (timer !== undefined) window.clearTimeout(timer);
    refreshTimers.delete(ctx.session.id);
  },
  renderRail: ({ viewActive, toggleView }) => (
    <button
      type="button"
      onClick={toggleView}
      data-tip="scratchpad — repo drafts & notes"
      className={`flex flex-col items-center gap-0.5 rounded px-1 py-0.5 transition ${
        viewActive
          ? 'bg-[var(--surface)] text-[var(--accent)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--surface)] hover:text-[var(--text-primary)]'
      }`}
    >
      <NotebookPen className="h-3.5 w-3.5" />
    </button>
  ),
  renderView: ({ sessions, sessionApi, openTab, close }) => (
    <ScratchpadView
      sessions={sessions}
      sessionApi={sessionApi}
      openTab={openTab}
      close={close}
    />
  ),
};
