import { useEffect, useSyncExternalStore } from 'react';
import {
  AlertTriangle,
  Boxes,
  FolderTree,
  GitFork,
  List,
  Loader2,
  Play,
  RefreshCw,
  Square,
  Tag,
  X,
} from 'lucide-react';
import { appRuntime } from '../appRuntime';
import type { RepoDir, RepoDirsContext } from '../repoDirectory';
import { PanelSearch } from '../SessionPanel';
import type { SessionViewPlugin } from './plugin';

// ---------------------------------------------------------------------------
// `axn-dev list` parsing — pure, unit-tested
// ---------------------------------------------------------------------------

export interface ScenarioEndpoint {
  label: string;
  url: string;
}

export interface AxnDevScenario {
  /** Stable React key — a scenario can appear once per worktree. */
  key: string;
  name: string;
  scope: 'global' | 'project';
  /** Repo group for project scenarios (the `repo:` header). */
  repo?: string;
  running: boolean;
  description: string;
  /** Tags from axn-dev.yaml — only present via `axn-dev list --json`. */
  tags: string[];
  /** Scenario directory — cwd for start/stop (inside its repo/worktree). */
  path?: string;
  worktree?: { branch: string; path: string };
  /** Resolved service URLs — only printed while the scenario runs. */
  endpoints: ScenarioEndpoint[];
  /** CPU% + memory of the running containers — only while running. */
  resources?: { cpuPercent: number; mem: string };
}

export interface ScenarioSection {
  /** 'global', or the repo name for project scenario groups. */
  label: string;
  scope: 'global' | 'project';
  scenarios: AxnDevScenario[];
}

// Same ANSI grammar ShellTerminal uses for hover text.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|][^\x07]*(?:\x07|\x1B\\)|\([A-Za-z0-9]|\)[A-Za-z0-9])/g;
const SCENARIO_LINE = /^(\s*)(\S+)\s+(● running|○ stopped)\s*(.*)$/;
const REPO_HEADER = /^\s{2}([^:]*):\s*$/;
const ENDPOINT_LINE = /^(\S+)\s+(\S+)$/;
const WORKTREE = /\[worktree:\s*(.*?)\s*@\s*([^\]]+?)\s*\]\s*$/;
const URLISH = /^\S+:\/\/\S+$|^[\w.-]+:\d+(\/\S*)?$/;

/**
 * Parse `axn-dev list` output into sections. Layout (see axn-dev-cli
 * commands/list.ts): `Global scenarios:` entries at indent 2, `Project
 * scenarios:` grouped under `  <repo>:` headers with entries at indent 4.
 * Running scenarios print their endpoints one level deeper; long
 * descriptions wrap to continuation lines at a deeper column too — the two
 * are told apart by the endpoint's URL-ish second token.
 */
export function parseAxnDevList(text: string): ScenarioSection[] {
  const sections: ScenarioSection[] = [];
  let scope: 'global' | 'project' | null = null;
  let section: ScenarioSection | null = null;
  let scenario: AxnDevScenario | null = null;
  let scenarioIndent = 0;

  for (const raw of text.replace(ANSI, '').split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const indent = raw.length - raw.trimStart().length;

    if (trimmed === 'Global scenarios:') {
      scope = 'global';
      section = { label: 'global', scope, scenarios: [] };
      sections.push(section);
      scenario = null;
      continue;
    }
    if (trimmed === 'Project scenarios:') {
      scope = 'project';
      section = null;
      scenario = null;
      continue;
    }
    const header = scope === 'project' && indent === 2 ? REPO_HEADER.exec(raw) : null;
    if (header) {
      section = { label: header[1], scope: 'project', scenarios: [] };
      sections.push(section);
      scenario = null;
      continue;
    }
    const line = SCENARIO_LINE.exec(raw);
    if (scope && section && line && indent === (scope === 'global' ? 2 : 4)) {
      const name = line[2];
      let rest = (line[4] ?? '').replace(/^—\s*/, '').trim();
      const wt = WORKTREE.exec(rest);
      const worktree = wt ? { branch: wt[1], path: wt[2] } : undefined;
      if (wt) rest = rest.slice(0, wt.index).trim();
      scenario = {
        key: `${scope}:${section.label}:${name}:${worktree?.path ?? ''}`,
        name,
        scope,
        repo: scope === 'project' ? section.label : undefined,
        running: line[3].includes('running'),
        description: rest,
        tags: [],
        worktree,
        endpoints: [],
      };
      scenarioIndent = indent;
      section.scenarios.push(scenario);
      continue;
    }
    // A deeper indent attaches to the scenario above: `label  url` endpoints
    // (running only) or a wrapped description continuation.
    if (scenario && indent > scenarioIndent) {
      const ep = ENDPOINT_LINE.exec(trimmed);
      if (ep && URLISH.test(ep[2])) {
        scenario.endpoints.push({ label: ep[1], url: ep[2] });
      } else {
        scenario.description = scenario.description
          ? `${scenario.description} ${trimmed}`
          : trimmed;
      }
    }
  }
  return sections.filter((s) => s.scenarios.length > 0);
}

/**
 * Parse `axn-dev list --json` — emits
 * `{sections:[{label, scope, scenarios:[{name, path, running, description,
 * tags, worktree?, endpoints[]}]}]}`. Returns null when the CLI is too old
 * (output isn't JSON) so the caller can fall back to text parsing.
 */
export function parseAxnDevListJson(text: string): ScenarioSection[] | null {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(ANSI, ''));
  } catch {
    return null;
  }
  if (
    typeof data !== 'object' ||
    data === null ||
    !Array.isArray((data as { sections?: unknown }).sections)
  ) {
    return null;
  }
  const out: ScenarioSection[] = [];
  for (const sec of (data as { sections: unknown[] }).sections) {
    if (typeof sec !== 'object' || sec === null) continue;
    const s = sec as {
      label?: string;
      scope?: string;
      scenarios?: unknown[];
    };
    const scope = s.scope === 'project' ? 'project' : 'global';
    const section: ScenarioSection = {
      label: s.label ?? 'global',
      scope,
      scenarios: [],
    };
    for (const raw of s.scenarios ?? []) {
      if (typeof raw !== 'object' || raw === null) continue;
      const j = raw as {
        name?: string;
        path?: string;
        running?: boolean;
        description?: string;
        tags?: unknown;
        worktree?: { branch?: string; path?: string };
        endpoints?: { label?: string; url?: string }[];
        resources?: { cpuPercent?: number; mem?: string };
      };
      if (!j.name) continue;
      const worktree = j.worktree?.branch
        ? { branch: j.worktree.branch, path: j.worktree.path ?? '' }
        : undefined;
      section.scenarios.push({
        key: `${scope}:${section.label}:${j.name}:${worktree?.path ?? ''}`,
        name: j.name,
        scope,
        repo: scope === 'project' ? section.label : undefined,
        running: j.running === true,
        description: j.description ?? '',
        tags: Array.isArray(j.tags) ? j.tags.filter((t): t is string => typeof t === 'string') : [],
        path: j.path,
        worktree,
        endpoints: (j.endpoints ?? [])
          .filter((e) => typeof e?.label === 'string' && typeof e?.url === 'string')
          .map((e) => ({ label: e.label!, url: e.url! })),
        resources:
          typeof j.resources?.cpuPercent === 'number' && typeof j.resources?.mem === 'string'
            ? { cpuPercent: j.resources.cpuPercent, mem: j.resources.mem }
            : undefined,
      });
    }
    if (section.scenarios.length > 0) out.push(section);
  }
  return out;
}

export function countScenarios(sections: ScenarioSection[]): {
  total: number;
  running: number;
} {
  let total = 0;
  let running = 0;
  for (const section of sections) {
    for (const s of section.scenarios) {
      total++;
      if (s.running) running++;
    }
  }
  return { total, running };
}

/** Serve-style tag match: `myapp` also matches `myapp/e2e`. */
export function tagMatches(tag: string, query: string): boolean {
  const t = tag.toLowerCase();
  const q = query.toLowerCase();
  return t === q || t.startsWith(`${q}/`);
}

/** Filter predicate shared by list and tree view: name/description substring or tag match. */
export function scenarioMatches(s: AxnDevScenario, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)) return true;
  return s.tags.some((t) => tagMatches(t, q));
}

// ---------------------------------------------------------------------------
// Tag tree — slash-separated segments become folders, untagged group first
// ---------------------------------------------------------------------------

export interface TagTreeNode {
  /** Folder segment ('' for the root/untagged group). */
  segment: string;
  /** Full tag path for this folder (e.g. 'myapp/e2e'). */
  path: string;
  children: TagTreeNode[];
  scenarios: AxnDevScenario[];
  /** running/total across the whole subtree. */
  running: number;
  total: number;
}

export function buildTagTree(scenarios: AxnDevScenario[]): TagTreeNode {
  const root: TagTreeNode = { segment: '', path: '', children: [], scenarios: [], running: 0, total: 0 };
  const nodes = new Map<string, TagTreeNode>([['', root]]);
  const nodeFor = (path: string): TagTreeNode => {
    const existing = nodes.get(path);
    if (existing) return existing;
    const node: TagTreeNode = {
      segment: path.slice(path.lastIndexOf('/') + 1),
      path,
      children: [],
      scenarios: [],
      running: 0,
      total: 0,
    };
    nodes.set(path, node);
    const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    nodeFor(parentPath).children.push(node);
    return node;
  };
  for (const s of scenarios) {
    const paths = s.tags.length > 0 ? s.tags : [''];
    for (const tagPath of paths) {
      const node = nodeFor(tagPath);
      node.scenarios.push(s);
      for (let p = node.path; ; p = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '') {
        const n = nodes.get(p) ?? root;
        n.total++;
        if (s.running) n.running++;
        if (!p) break;
      }
    }
  }
  const sort = (n: TagTreeNode) => {
    n.children.sort((a, b) => a.segment.localeCompare(b.segment));
    n.children.forEach(sort);
  };
  sort(root);
  return root;
}

// ---------------------------------------------------------------------------
// Overview store — one `axn-dev list` poller shared by rail + view, plus
// start/stop operation state per scenario key
// ---------------------------------------------------------------------------

export interface ScenarioOp {
  op: 'start' | 'stop';
  /** Set when the last attempt failed — the button is re-enabled. */
  error?: string;
}

export interface AxnDevOverview {
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: string;
  sections: ScenarioSection[];
  fetchedAt?: number;
  /** In-flight (or last failed) start/stop ops, keyed by scenario.key. */
  ops: Record<string, ScenarioOp>;
}

let overview: AxnDevOverview = { status: 'idle', sections: [], ops: {} };
const overviewListeners = new Set<() => void>();

function setOverview(next: AxnDevOverview) {
  overview = next;
  for (const listener of overviewListeners) listener();
}

export function useAxnDevOverview(): AxnDevOverview {
  return useSyncExternalStore(
    (listener) => {
      overviewListeners.add(listener);
      return () => overviewListeners.delete(listener);
    },
    () => overview,
  );
}

let refreshInFlight: Promise<void> | null = null;
/** Once probed, whether this CLI supports `list --json` (stays for the run). */
let jsonSupported: boolean | null = null;

async function fetchScenarios(): Promise<ScenarioSection[]> {
  const rt = appRuntime();
  if (!rt) throw new Error('no session available for axn-dev');
  if (jsonSupported !== false) {
    const out = await rt.exec('axn-dev list --json');
    const sections = parseAxnDevListJson(out);
    if (sections !== null) {
      jsonSupported = true;
      return sections;
    }
    jsonSupported = false;
  }
  return parseAxnDevList(await rt.exec('axn-dev list'));
}

export function refreshScenarios(): Promise<void> {
  refreshInFlight ??= (async () => {
    setOverview({ ...overview, status: 'loading' });
    try {
      const sections = await fetchScenarios();
      setOverview({ status: 'ready', sections, fetchedAt: Date.now(), ops: overview.ops });
    } catch (e) {
      setOverview({
        ...overview,
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/**
 * Start/stop a scenario via `axn-dev` as a child process — exec resolves on
 * clean exit and rejects on non-zero, surfacing the CLI's stderr. The op is
 * tracked per scenario so its row shows a pending state; the list refreshes
 * when it completes.
 */
export async function runScenarioOp(scenario: AxnDevScenario, op: 'start' | 'stop'): Promise<void> {
  const rt = appRuntime();
  if (!rt) return;
  const ops = { ...overview.ops, [scenario.key]: { op } };
  setOverview({ ...overview, ops });
  try {
    const flag = scenario.scope === 'global' ? '-g ' : '';
    // The scenario dir sits inside its repo/worktree — running there lets
    // axn-dev resolve project scenarios regardless of the ambient cwd.
    const cwd = scenario.worktree?.path ?? scenario.path;
    await rt.exec(`axn-dev ${op} ${flag}-s ${scenario.name}`, cwd);
    const cleared = { ...overview.ops };
    delete cleared[scenario.key];
    setOverview({ ...overview, ops: cleared });
  } catch (e) {
    setOverview({
      ...overview,
      ops: {
        ...overview.ops,
        [scenario.key]: { op, error: e instanceof Error ? e.message : String(e) },
      },
    });
  }
  void refreshScenarios();
}

// ---------------------------------------------------------------------------
// Rail teaser — running/found counter, click toggles the full view
// ---------------------------------------------------------------------------

function AxnDevRail({
  pluginSettings,
  viewActive,
  toggleView,
}: {
  pluginSettings: unknown;
  viewActive: boolean;
  toggleView: () => void;
}) {
  const data = useAxnDevOverview();
  const intervalSec =
    (pluginSettings as { refreshIntervalSeconds?: number } | undefined)
      ?.refreshIntervalSeconds ?? 30;

  useEffect(() => {
    void refreshScenarios();
    const timer = window.setInterval(
      () => void refreshScenarios(),
      Math.max(10, intervalSec) * 1000,
    );
    return () => window.clearInterval(timer);
  }, [intervalSec]);

  const { total, running } = countScenarios(data.sections);
  const runningNames = data.sections
    .flatMap((s) => s.scenarios)
    .filter((s) => s.running)
    .map((s) => s.name);

  const title =
    data.status === 'error'
      ? `axn-dev list failed\n${data.error ?? 'unknown error'}`
      : [
          `axn-dev — ${running}/${total} scenarios running`,
          runningNames.length ? `running: ${runningNames.join(', ')}` : null,
          data.status === 'loading' ? 'refreshing…' : null,
        ]
          .filter(Boolean)
          .join('\n');

  return (
    <button
      type="button"
      onClick={toggleView}
      data-tip={title}
      className={`flex flex-col items-center gap-0.5 rounded px-1 py-0.5 transition ${
        viewActive
          ? 'bg-[var(--surface)] text-[var(--accent)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--surface)] hover:text-[var(--text-primary)]'
      }`}
    >
      <Boxes className="h-3.5 w-3.5" />
      {data.status === 'error' ? (
        <AlertTriangle className="h-3 w-3 text-[var(--red)]" />
      ) : (
        <span
          className={`select-none text-[8px] font-bold leading-none ${
            running > 0 ? 'text-[var(--green)]' : ''
          }`}
          data-tip="running / found scenarios"
        >
          {running}/{total}
        </span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Full plugin view — list or tag tree, start/stop per scenario, filter
// ---------------------------------------------------------------------------

function ScenarioOpButton({ scenario, op }: { scenario: AxnDevScenario; op?: ScenarioOp }) {
  const pending = op !== undefined && !op.error;
  const start = !scenario.running;
  return (
    <button
      type="button"
      disabled={pending}
      onClick={(e) => {
        e.stopPropagation();
        void runScenarioOp(scenario, start ? 'start' : 'stop');
      }}
      data-tip={
        pending
          ? `${op.op === 'start' ? 'starting' : 'stopping'} ${scenario.name}…`
          : start
            ? `axn-dev start -s ${scenario.name}`
            : `axn-dev stop -s ${scenario.name}`
      }
      aria-label={start ? `Start ${scenario.name}` : `Stop ${scenario.name}`}
      className={`group relative flex h-5 w-5 shrink-0 items-center justify-center rounded transition disabled:opacity-50 ${
        start
          ? 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--green)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--red)]'
      }`}
    >
      {pending ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <>
          <span
            className={`text-[10px] leading-none transition group-hover:hidden ${
              scenario.running ? 'text-[var(--green)]' : 'text-[var(--text-secondary)]'
            }`}
          >
            {scenario.running ? '●' : '○'}
          </span>
          <span className="hidden items-center justify-center group-hover:flex">
            {start ? <Play className="h-3 w-3" /> : <Square className="h-3 w-3" />}
          </span>
        </>
      )}
    </button>
  );
}

function TagBadge({ tag }: { tag: string }) {
  return (
    <span className="flex shrink-0 items-center gap-0.5 rounded bg-[var(--surface)] px-1 text-[9px] text-[var(--text-secondary)]">
      <Tag className="h-2 w-2" />
      {tag}
    </span>
  );
}

function ScenarioRow({ scenario, op }: { scenario: AxnDevScenario; op?: ScenarioOp }) {
  return (
    <div className="rounded px-2 py-1">
      <div className="flex items-start gap-2">
        <ScenarioOpButton scenario={scenario} op={op} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="font-mono text-[11px] font-semibold text-[var(--text-primary)]">
              {scenario.name}
            </span>
            {scenario.worktree && (
              <span
                className="flex items-center gap-0.5 rounded bg-[color-mix(in_srgb,var(--violet)_15%,transparent)] px-1 font-mono text-[9px] text-[var(--violet)]"
                data-tip={scenario.worktree.path}
              >
                <GitFork className="h-2.5 w-2.5" />
                {scenario.worktree.branch}
              </span>
            )}
            {scenario.tags.map((t) => (
              <TagBadge key={t} tag={t} />
            ))}
          </div>
          {scenario.description && (
            <div className="mt-0.5 break-words text-[10px] text-[var(--text-secondary)]">
              {scenario.description}
            </div>
          )}
          {op?.error && (
            <div className="mt-0.5 break-words text-[10px] text-[var(--red)]">
              {op.op} failed: {op.error}
            </div>
          )}
        </div>
      </div>
      {scenario.running && scenario.resources && (
        <div className="ml-12 pt-0.5 text-[10px] text-[var(--text-secondary)]">
          cpu {scenario.resources.cpuPercent}% · mem {scenario.resources.mem}
        </div>
      )}
      {scenario.endpoints.length > 0 && (
        <div className="ml-12 flex flex-col gap-0.5 pt-0.5">
          {scenario.endpoints.map((ep) => (
            <a
              key={`${ep.label}:${ep.url}`}
              href={ep.url}
              target="_blank"
              rel="noreferrer"
              className="flex items-baseline gap-2 text-[10px] hover:underline"
            >
              <span className="w-36 shrink-0 truncate text-[var(--text-secondary)]">
                {ep.label}
              </span>
              <span className="truncate text-[var(--accent)]">{ep.url}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function ScenarioSectionView({
  section,
  scenarios,
  runningOnly,
  ops,
}: {
  section: ScenarioSection;
  scenarios: AxnDevScenario[];
  runningOnly: boolean;
  ops: Record<string, ScenarioOp>;
}) {
  if (scenarios.length === 0) return null;
  const running = scenarios.filter((s) => s.running).length;
  return (
    <div className="mb-4">
      <div className="mb-1 flex items-baseline gap-2 px-2 text-[10px] uppercase tracking-wide text-[var(--text-secondary)]">
        <span>{section.scope === 'global' ? 'global scenarios' : section.label}</span>
        <span className={running > 0 ? 'font-semibold text-[var(--green)]' : ''}>
          {runningOnly ? scenarios.length : `${running}/${scenarios.length}`}
        </span>
      </div>
      <div className="flex flex-col gap-0.5">
        {scenarios.map((s) => (
          <ScenarioRow key={s.key} scenario={s} op={ops[s.key]} />
        ))}
      </div>
    </div>
  );
}

function TagFolderView({
  node,
  depth,
  runningOnly,
  ops,
}: {
  node: TagTreeNode;
  depth: number;
  runningOnly: boolean;
  ops: Record<string, ScenarioOp>;
}) {
  return (
    <div className={depth === 0 ? '' : 'mb-2'}>
      {node.path && (
        <div
          className="mb-1 flex items-baseline gap-2 px-2 text-[10px] uppercase tracking-wide text-[var(--text-secondary)]"
          style={{ paddingLeft: `${8 + depth * 12}px` }}
        >
          <span>{node.segment}</span>
          <span className={node.running > 0 ? 'font-semibold text-[var(--green)]' : ''}>
            {runningOnly ? node.total : `${node.running}/${node.total}`}
          </span>
        </div>
      )}
      {node.scenarios.length > 0 && (
        <div
          className="flex flex-col gap-0.5"
          style={{ paddingLeft: `${depth * 12}px` }}
        >
          {node.scenarios.map((s) => (
            <ScenarioRow key={s.key} scenario={s} op={ops[s.key]} />
          ))}
        </div>
      )}
      {node.children.map((c) => (
        <TagFolderView key={c.path} node={c} depth={depth + 1} runningOnly={runningOnly} ops={ops} />
      ))}
    </div>
  );
}

function AxnDevView({
  close,
  appState,
  updateAppState,
}: {
  close: () => void;
  appState: unknown;
  updateAppState: (patch: Record<string, unknown>) => void;
}) {
  const data = useAxnDevOverview();
  const state = (appState ?? {}) as {
    runningOnly?: boolean;
    view?: string;
    query?: string;
    showWorktrees?: boolean;
  };
  const runningOnly = state.runningOnly === true;
  const treeView = state.view === 'tree';
  const showWorktrees = state.showWorktrees !== false;
  const query = state.query ?? '';

  useEffect(() => {
    if (data.status === 'idle') void refreshScenarios();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { total, running } = countScenarios(data.sections);
  const all = data.sections.flatMap((s) => s.scenarios);
  const matches = (s: AxnDevScenario) =>
    (!runningOnly || s.running) && (showWorktrees || !s.worktree) && scenarioMatches(s, query);
  const filtered = all.filter(matches);
  const tree = treeView ? buildTagTree(filtered) : null;

  const sectionRows = data.sections
    .map((section) => ({
      section,
      scenarios: section.scenarios.filter(matches),
    }))
    .filter((r) => r.scenarios.length > 0);

  const viewButton =
    'flex h-6 w-6 items-center justify-center rounded text-[10px] transition';

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg)]">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-secondary)] px-3">
        <Boxes className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-primary)]">
          axn-dev scenarios
        </span>
        <div className="min-w-0 flex-1">
          <PanelSearch
            value={query}
            onChange={(v) => updateAppState({ query: v })}
            placeholder="Filter scenarios…"
          />
        </div>
        <button
          type="button"
          onClick={() => updateAppState({ view: 'list' })}
          data-tip="List view"
          aria-label="List view"
          className={`${viewButton} ${
            !treeView
              ? 'bg-[var(--surface)] text-[var(--accent)]'
              : 'text-[var(--text-secondary)] hover:bg-[var(--surface)] hover:text-[var(--text-primary)]'
          }`}
        >
          <List className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => updateAppState({ view: 'tree' })}
          data-tip="Tag tree view"
          aria-label="Tag tree view"
          className={`${viewButton} ${
            treeView
              ? 'bg-[var(--surface)] text-[var(--accent)]'
              : 'text-[var(--text-secondary)] hover:bg-[var(--surface)] hover:text-[var(--text-primary)]'
          }`}
        >
          <FolderTree className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => updateAppState({ runningOnly: !runningOnly })}
          data-tip="Only list running scenarios"
          className={`flex h-6 items-center rounded px-2 text-[10px] transition ${
            runningOnly
              ? 'bg-[var(--surface)] text-[var(--accent)]'
              : 'text-[var(--text-secondary)] hover:bg-[var(--surface)] hover:text-[var(--text-primary)]'
          }`}
        >
          running only
        </button>
        <button
          type="button"
          onClick={() => updateAppState({ showWorktrees: !showWorktrees })}
          data-tip="Show scenarios from linked worktrees"
          aria-label="Show worktree scenarios"
          className={`${viewButton} ${
            showWorktrees
              ? 'bg-[var(--surface)] text-[var(--accent)]'
              : 'text-[var(--text-secondary)] hover:bg-[var(--surface)] hover:text-[var(--text-primary)]'
          }`}
        >
          <GitFork className="h-3.5 w-3.5" />
        </button>
        <span
          className={`text-[10px] ${running > 0 ? 'font-semibold text-[var(--green)]' : 'text-[var(--text-secondary)]'}`}
          data-tip="running / total scenarios"
        >
          {running}/{total}
        </span>
        {data.fetchedAt && (
          <span className="text-[10px] text-[var(--text-secondary)]">
            updated {Math.max(0, Math.round((Date.now() - data.fetchedAt) / 1000))}s ago
          </span>
        )}
        <button
          type="button"
          onClick={() => void refreshScenarios()}
          data-tip="Refresh"
          aria-label="Refresh"
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-secondary)] transition hover:bg-[var(--surface)] hover:text-[var(--text-primary)]"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${data.status === 'loading' ? 'animate-spin' : ''}`} />
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
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {data.status === 'error' ? (
          <div className="rounded border border-[var(--border)] bg-[var(--surface)] p-3 text-[11px] text-[var(--text-primary)]">
            <div className="mb-1 font-semibold text-[var(--red)]">failed to load scenarios</div>
            <div className="mb-2 text-[var(--text-secondary)]">{data.error}</div>
            <div className="text-[var(--text-secondary)]">
              Check <code className="text-[var(--accent)]">axn-dev list</code> in a shell.
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-2 py-1 text-[11px] italic text-[var(--text-secondary)]">
            {data.status === 'loading' && total === 0
              ? 'loading…'
              : query
                ? 'no matches'
                : runningOnly && running === 0
                  ? 'no running scenarios'
                  : 'no scenarios found'}
          </div>
        ) : treeView && tree ? (
          <TagFolderView node={tree} depth={0} runningOnly={runningOnly} ops={data.ops} />
        ) : (
          <>
            {sectionRows.map(({ section, scenarios }) => (
              <ScenarioSectionView
                key={`${section.scope}:${section.label}`}
                section={section}
                scenarios={scenarios}
                runningOnly={runningOnly}
                ops={data.ops}
              />
            ))}
            {data.status === 'loading' && (
              <div className="px-2 text-[10px] italic text-[var(--text-secondary)]">
                refreshing…
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

/**
 * Parse `axn-dev git repos --json` into repo dirs. Null when the output is
 * not that JSON (an older CLI without `git repos`).
 */
export function parseAxnDevRepos(out: string): RepoDir[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(out);
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  const dirs: RepoDir[] = [];
  for (const r of raw as Array<Record<string, unknown>>) {
    if (typeof r?.path !== 'string' || !r.path) continue;
    const worktrees = Array.isArray(r.worktrees)
      ? (r.worktrees as Array<Record<string, unknown>>).flatMap((w) =>
          typeof w?.path === 'string' && w.path
            ? [
                {
                  path: w.path,
                  branch: typeof w.branch === 'string' ? w.branch : null,
                  ...(typeof w.isMain === 'boolean' ? { isMain: w.isMain } : {}),
                },
              ]
            : [],
        )
      : undefined;
    dirs.push({
      path: r.path,
      name: typeof r.name === 'string' ? r.name : undefined,
      remote: typeof r.remote === 'string' ? r.remote : null,
      worktrees,
    });
  }
  return dirs;
}

/** The repos configured in axn-dev; empty when the CLI is absent or too old. */
async function axnDevRepoDirs(ctx: RepoDirsContext): Promise<RepoDir[]> {
  const out = await ctx.exec('axn-dev git repos --json').catch(() => '');
  return parseAxnDevRepos(out) ?? [];
}

export const axnDevPlugin: SessionViewPlugin = {
  id: 'axn-dev',
  title: 'axn-dev scenarios',
  version: '0.1.0',
  repoDirs: axnDevRepoDirs,
  settings: [
    {
      key: 'refreshIntervalSeconds',
      label: 'Refresh interval (seconds)',
      description: 'How often `axn-dev list` is polled.',
      type: 'number',
      default: 30,
    },
  ],
  renderRail: ({ pluginSettings, viewActive, toggleView }) => (
    <AxnDevRail
      pluginSettings={pluginSettings}
      viewActive={viewActive}
      toggleView={toggleView}
    />
  ),
  renderView: ({ close, appState, updateAppState }) => (
    <AxnDevView close={close} appState={appState} updateAppState={updateAppState} />
  ),
};
