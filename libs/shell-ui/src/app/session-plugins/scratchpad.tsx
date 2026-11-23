import { useCallback, useEffect, useRef, useState } from 'react';
import { fieldClass } from '../chromeStyles';
import { ContextMenu, menuItemClass } from '../../ContextMenu';
import { PanelHeader, PanelHeaderButton, PanelHeaderSpacer } from '../PanelHeader';
import { PanelSearch } from '../SessionPanel';
import { RailItem } from '../RailItem';
import { ScratchpadCleanupModal } from '../ScratchpadCleanupModal';
import { FileText, NotebookPen, RefreshCw, Trash2 } from 'lucide-react';
import { relativeAgo } from './relativeTime';
import {
  dedupeEntries,
  filterEntries,
  groupByRepo,
  repoNames,
  trashScript,
  type DraftEntry,
} from './scratchpadDrafts';
import type {
  PluginApi,
  RepoMenuItem,
  SessionIdentifier,
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
  /** Draft folders this entry contributes: repo-relative, or absolute (`/…`, `~/…`). */
  dirs: string[];
}

/** Absolute (`/…`) and home (`~`, `~/…`) folders stay as written; relative ones lose stray slashes. */
function normalizeDir(raw: string): string {
  const d = raw.trim();
  if (d === '~' || d.startsWith('~/')) return d.replace(/\/+$/, '') || '~';
  if (d.startsWith('/')) return d.replace(/\/+$/, '') || '/';
  return d.replace(/^\/+|\/+$/g, '');
}

/** Whether a configured draft folder is absolute rather than inside the repo. */
export const isAbsoluteDir = (dir: string): boolean => dir.startsWith('/');

/** A draft folder as an absolute path: absolute dirs as they are, others under the repo root. */
export function dirPath(loc: Pick<ScratchpadLocation, 'repoRoot'>, dir: string): string {
  return isAbsoluteDir(dir) ? dir : `${loc.repoRoot}/${dir}`;
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
      .map((d) => normalizeDir(d))
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
  /** The project: the remote repo name, else the checkout folder name. Groups the view and fills `{repo}`. */
  project: string;
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
  recentDraftHours?: number;
  showCurrentDrafts?: boolean;
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
  const project = remoteRepoName(remote) || baseName(repoRoot);
  const configured = dirsForRepo(patternsOf(ctx), names).map((d) => d.split('{repo}').join(project));
  if (!configured.length) return null;
  const home = configured.some((d) => d === '~' || d.startsWith('~/'))
    ? (await ctx.exec('printf %s "$HOME"', repoRoot).catch(() => '')).trim()
    : '';
  // `~` expands to the home folder; without one the entry is unusable, so drop it.
  const dirs = configured
    .map((d) => (d === '~' || d.startsWith('~/') ? (home ? `${home}${d.slice(1)}` : '') : d))
    .filter(Boolean);
  if (!dirs.length) return null;
  const existing: string[] = [];
  for (const dir of dirs) {
    const stat = await ctx.statPath(dir, repoRoot).catch(() => null);
    if (stat?.isDir) existing.push(dir);
  }
  return {
    repoRoot,
    repoName: names[0] ?? baseName(repoRoot),
    project,
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
  modifiedAt?: number;
}

export function draftMatchesIdentifier(name: string, identifier: string): boolean {
  const escaped = identifier.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escaped.length > 0 && new RegExp(`(^|[^A-Za-z0-9])${escaped}(?=$|[^A-Za-z0-9])`, 'i').test(name);
}

export function currentDrafts(
  drafts: DraftFile[],
  identifiers: SessionIdentifier[],
  recentHours: number,
  now = Date.now(),
): DraftFile[] {
  if (identifiers.length === 0 || !Number.isFinite(recentHours) || recentHours <= 0) return [];
  const cutoff = now - recentHours * 60 * 60 * 1000;
  return drafts
    .filter(
      (draft) =>
        draft.modifiedAt !== undefined &&
        draft.modifiedAt >= cutoff &&
        identifiers.some((identifier) => draftMatchesIdentifier(draft.name, identifier.value)),
    )
    .sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0));
}

/**
 * The drafts in the location's existing folders. `modified` decides which
 * files get their modification time (one `stat` each): none by default,
 * every file with `true`, or only those a predicate accepts — so a refresh
 * that only needs the files of one ticket never stats the rest of the folder.
 */
export async function listDrafts(
  ctx: Ctx,
  loc: ScratchpadLocation,
  modified: boolean | ((name: string) => boolean) = false,
): Promise<DraftFile[]> {
  const wants = typeof modified === 'function' ? modified : () => modified;
  const out: DraftFile[] = [];
  for (const dir of loc.existing) {
    const entries = await ctx.listDir(dirPath(loc, dir), loc.repoRoot).catch(() => null);
    const files = (entries ?? []).filter((e) => e.isFile && e.name !== '.gitignore');
    out.push(
      ...(await Promise.all(
        files.map(async (e): Promise<DraftFile> => {
          const path = `${dirPath(loc, dir)}/${e.name}`;
          const modifiedAt = wants(e.name)
            ? (await ctx.statPath(path).catch(() => null))?.modifiedAt
            : undefined;
          return { dir, name: e.name, path, modifiedAt };
        }),
      )),
    );
  }
  return out;
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
    await ctx.mkdir(dirPath(loc, loc.primary), loc.repoRoot);
    // Only in-repo folders need hiding from git; an absolute folder is outside it.
    if (settingsOf(ctx).gitignoreDrafts !== false && !isAbsoluteDir(loc.primary)) {
      await ctx
        .writeFile(`${loc.primary}/.gitignore`, '*\n', loc.repoRoot)
        .catch(() => {});
    }
  }
  const path = `${dirPath(loc, loc.primary)}/${name}`;
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
    `Scratchpad: drafts and working notes for this repo live in ${list} (repo-relative unless absolute, gitignored when in the repo).`,
    `Check them for existing notes before starting work; write plans and notes as \`<topic>.md\` files in \`${loc.primary}/\`.`,
  ];
}

function agentHintPrompt(loc: ScratchpadLocation): string {
  return `My drafts and working notes for this repo live in ${loc.primary}/ (relative to the repo root unless absolute). Check it for existing notes before starting work, and store working notes there. `;
}

// ---------------------------------------------------------------------------
// Per-session state — the repo's configured dirs, for the context-menu rows
// (sessionMenuItems is synchronous and cannot resolve the repo on the spot)
// ---------------------------------------------------------------------------

interface ScratchpadState {
  dirs?: string[];
  currentDrafts?: DraftFile[];
}

function stateOf(ctx: Ctx): ScratchpadState {
  return (ctx.pluginState ?? {}) as ScratchpadState;
}

const refreshTimers = new Map<string, number>();
const pollTimers = new Map<string, number>();
const closedSessions = new Set<string>();
const REFRESH_DELAY_MS = 800;
const CURRENT_DRAFTS_REFRESH_MS = 30_000;

async function refreshDirs(ctx: Ctx): Promise<void> {
  try {
    const loc = await resolveScratchpad(ctx);
    const next = loc?.dirs ?? [];
    const identifiers = ctx.getSessionIdentifiers();
    const drafts = loc && identifiers.length
      ? currentDrafts(
          await listDrafts(ctx, loc, (name) =>
            identifiers.some((identifier) => draftMatchesIdentifier(name, identifier.value)),
          ),
          identifiers,
          settingsOf(ctx).recentDraftHours ?? 0.5,
        )
      : [];
    const state = stateOf(ctx);
    if (
      JSON.stringify(state.dirs ?? []) !== JSON.stringify(next) ||
      JSON.stringify(state.currentDrafts ?? []) !== JSON.stringify(drafts)
    ) {
      ctx.updatePluginState({ dirs: next, currentDrafts: drafts });
    }
  } finally {
    if (!closedSessions.has(ctx.session.id)) {
      armTimer(pollTimers, ctx, CURRENT_DRAFTS_REFRESH_MS, () => void refreshDirs(ctx));
    }
  }
}

function armTimer(
  timers: Map<string, number>,
  ctx: Ctx,
  delay: number,
  callback: () => void,
): void {
  const id = ctx.session.id;
  const existing = timers.get(id);
  if (existing !== undefined) window.clearTimeout(existing);
  timers.set(
    id,
    window.setTimeout(() => {
      timers.delete(id);
      callback();
    }, delay),
  );
}

/** Output settles → the session may have cd'd to another repo → re-resolve. */
function scheduleRefresh(ctx: Ctx): void {
  const id = ctx.session.id;
  if (closedSessions.has(id)) return;
  armTimer(refreshTimers, ctx, REFRESH_DELAY_MS, () => void refreshDirs(ctx));
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
  ctx.openBrowser(dirPath(loc, target));
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
      return echoLine(dirPath(loc, loc.primary));
    case 'browse':
      ctx.openBrowser(dirPath(loc, loc.primary));
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
        `scratchpad: ${dirPath(loc, loc.primary)}${loc.existing.length > 1 ? ` (+${loc.existing.length - 1} more)` : ''}`,
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
// Full-area view — drafts across every open session's repo, by repo name
// ---------------------------------------------------------------------------

type OpenKind = 'editor' | 'preview';

export function ScratchpadView({
  sessions,
  sessionApi,
  selectSession,
}: {
  sessions: ShellSession[];
  sessionApi: (sessionId: string) => Ctx | undefined;
  selectSession: (sessionId: string) => void;
}) {
  const [entries, setEntries] = useState<DraftEntry[] | null>(null);
  const [query, setQuery] = useState('');
  const [repo, setRepo] = useState<string | null>(null);
  const [cleanup, setCleanup] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; entry: DraftEntry } | null>(null);
  const sessionApiRef = useRef(sessionApi);
  sessionApiRef.current = sessionApi;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const sessionsKey = sessions.map((s) => `${s.id}:${s.repo?.root ?? ''}`).join('|');

  const load = useCallback(async () => {
    const seen = new Set<string>();
    const found: DraftEntry[] = [];
    for (const s of sessionsRef.current) {
      const api = sessionApiRef.current(s.id);
      if (!api) continue;
      const loc = await resolveScratchpad(api);
      if (!loc || seen.has(loc.repoRoot)) continue;
      seen.add(loc.repoRoot);
      for (const d of await listDrafts(api, loc, true)) {
        found.push({
          repo: loc.project,
          dir: d.dir,
          inRepo: !isAbsoluteDir(d.dir),
          name: d.name,
          path: d.path,
          modifiedAt: d.modifiedAt,
          sessionId: s.id,
        });
      }
    }
    setEntries(dedupeEntries(found));
  }, []);

  useEffect(() => {
    void load();
  }, [load, sessionsKey]);

  const repos = entries ? repoNames(entries) : [];
  // The repo filter is only offered — and only applied — when there is a choice.
  const activeRepo = repos.length > 1 && repo !== null && repos.includes(repo) ? repo : null;
  const visible = entries ? filterEntries(entries, query, activeRepo) : [];
  const groups = groupByRepo(visible);
  const now = Date.now();

  const open = (entry: DraftEntry, kind: OpenKind) => {
    sessionApi(entry.sessionId)?.openTab({ path: entry.path, kind });
    selectSession(entry.sessionId);
  };

  const trash = async (picked: DraftEntry[]) => {
    const api = picked.length ? sessionApi(picked[0].sessionId) : undefined;
    if (!api) throw new Error('No session available to run the cleanup.');
    await api.exec(trashScript(picked.map((e) => e.path)));
    setCleanup(false);
    await load();
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg)]">
      <PanelHeader
        icon={<NotebookPen />}
        title="Scratchpad"
        meta={
          <span className="text-[11px] text-[var(--text-secondary)]">
            {entries?.length ?? 0} draft{entries?.length === 1 ? '' : 's'}
          </span>
        }
      >
        <div className="flex min-w-0 max-w-sm flex-1 pl-2">
          <PanelSearch value={query} onChange={setQuery} placeholder="Filter drafts…" />
        </div>
        {repos.length > 1 && (
          <select
            value={activeRepo ?? ''}
            onChange={(e) => setRepo(e.target.value || null)}
            aria-label="Repo"
            className={fieldClass}
          >
            <option value="">All</option>
            {repos.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        )}
        <PanelHeaderSpacer />
        <PanelHeaderButton title="Refresh" onClick={() => void load()}>
          <RefreshCw className="h-3.5 w-3.5" />
        </PanelHeaderButton>
        <PanelHeaderButton title="Clean up old drafts…" onClick={() => setCleanup(true)}>
          <Trash2 className="h-3.5 w-3.5" />
        </PanelHeaderButton>
      </PanelHeader>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {entries === null ? (
          <div className="px-2 py-3 text-xs italic text-[var(--text-secondary)]">
            Scanning session repos…
          </div>
        ) : entries.length === 0 ? (
          <div className="px-2 py-3 text-xs italic text-[var(--text-secondary)]">
            No drafts — create one from a session's menu or with `axn-scratch new &lt;name&gt;`.
          </div>
        ) : groups.length === 0 ? (
          <div className="px-2 py-3 text-xs italic text-[var(--text-secondary)]">
            No draft matches the filter.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {groups.map((g) => (
              <div key={g.repo}>
                <div className="mb-1 px-2 text-xs font-semibold text-[var(--text-primary)]">
                  {g.repo}
                  <span className="ml-2 font-normal text-[var(--text-tertiary)]">
                    {g.entries.length}
                  </span>
                </div>
                {g.entries.map((f) => (
                  <button
                    key={f.path}
                    type="button"
                    onClick={() => open(f, 'editor')}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({ x: e.clientX, y: e.clientY, entry: f });
                    }}
                    data-tip={f.path}
                    className="flex w-full items-center gap-2 rounded py-1 pl-4 pr-2 text-left transition hover:bg-[var(--surface)]"
                  >
                    <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--text-primary)]">
                      {f.name}
                    </span>
                    <span className="shrink-0 rounded bg-[var(--fill-1)] px-1 text-[10px] text-[var(--text-secondary)]">
                      {f.inRepo ? f.dir : 'central'}
                    </span>
                    <span className="w-14 shrink-0 text-right text-[11px] text-[var(--text-tertiary)]">
                      {f.modifiedAt !== undefined ? relativeAgo(f.modifiedAt, now) : ''}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {(
            [
              ['Open preview', () => open(menu.entry, 'preview')],
              ['Open in editor', () => open(menu.entry, 'editor')],
              ...(shellServices()?.revealPath
                ? ([['Reveal', () => shellServices()?.revealPath?.(menu.entry.path)]] as const)
                : []),
              ['Copy path', () => void shellServices()?.copyText(menu.entry.path)],
            ] as const
          ).map(([label, run]) => (
            <button
              key={label}
              type="button"
              className={menuItemClass}
              onClick={() => {
                setMenu(null);
                run();
              }}
            >
              {label}
            </button>
          ))}
        </ContextMenu>
      )}

      {cleanup && entries && (
        <ScratchpadCleanupModal
          entries={activeRepo ? entries.filter((e) => e.repo === activeRepo) : entries}
          scope={activeRepo ?? 'all repos'}
          onCancel={() => setCleanup(false)}
          onConfirm={trash}
        />
      )}
    </div>
  );
}

function CurrentDrafts({ ctx }: { ctx: Ctx }) {
  const drafts = stateOf(ctx).currentDrafts ?? [];
  if (drafts.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] text-[var(--text-secondary)]">current drafts</span>
      {drafts.map((draft) => (
        <button
          key={draft.path}
          type="button"
          onClick={() => ctx.openTab({ path: draft.path, kind: 'preview' })}
          data-tip={draft.path}
          className="flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-left text-[11px] text-[var(--accent)] hover:bg-[var(--surface)] hover:underline"
        >
          <FileText className="h-3 w-3 shrink-0" />
          <span className="min-w-0 truncate">{draft.name}</span>
        </button>
      ))}
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
    {
      key: 'recentDraftHours',
      label: 'Recent drafts window (hours)',
      description: 'Current drafts match identifiers in filenames modified within this window. Default: 0.5 hours.',
      type: 'number',
      default: 0.5,
    },
    {
      key: 'showCurrentDrafts',
      label: 'Show current drafts in session cards',
      description: 'Shows recent identifier-matching drafts as preview buttons on the selected session card.',
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
    closedSessions.delete(ctx.session.id);
    void refreshDirs(ctx);
  },
  onOutput: (ctx) => {
    scheduleRefresh(ctx);
  },
  onClose: (ctx) => {
    closedSessions.add(ctx.session.id);
    for (const timers of [refreshTimers, pollTimers]) {
      const timer = timers.get(ctx.session.id);
      if (timer !== undefined) window.clearTimeout(timer);
      timers.delete(ctx.session.id);
    }
  },
  renderRail: ({ viewActive, toggleView }) => (
    <RailItem title="Scratchpad" onClick={toggleView} active={viewActive}>
      <NotebookPen />
    </RailItem>
  ),
  renderView: ({ sessions, sessionApi, selectSession }) => (
    <ScratchpadView sessions={sessions} sessionApi={sessionApi} selectSession={selectSession} />
  ),
  sessionFields: [
    {
      id: 'currentDrafts',
      label: 'Current drafts',
      kind: 'block',
      zone: 'selected',
      search: (ctx) => {
        if (settingsOf(ctx).showCurrentDrafts === false) return null;
        return (stateOf(ctx).currentDrafts ?? []).map((draft) => draft.name);
      },
      value: (ctx) =>
        settingsOf(ctx).showCurrentDrafts === false ? null : <CurrentDrafts ctx={ctx} />,
    },
  ],
};
