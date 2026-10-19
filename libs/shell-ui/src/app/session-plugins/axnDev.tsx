import { useEffect, useSyncExternalStore } from 'react';
import { AlertTriangle, Boxes, GitFork, RefreshCw, X } from 'lucide-react';
import { appRuntime } from '../appRuntime';
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
  worktree?: { branch: string; path: string };
  /** Resolved service URLs — only printed while the scenario runs. */
  endpoints: ScenarioEndpoint[];
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

// ---------------------------------------------------------------------------
// Overview store — one `axn-dev list` poller shared by rail + view
// ---------------------------------------------------------------------------

export interface AxnDevOverview {
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: string;
  sections: ScenarioSection[];
  fetchedAt?: number;
}

let overview: AxnDevOverview = { status: 'idle', sections: [] };
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

export function refreshScenarios(): Promise<void> {
  refreshInFlight ??= (async () => {
    setOverview({ ...overview, status: 'loading' });
    try {
      const rt = appRuntime();
      if (!rt) throw new Error('no session available for axn-dev');
      const out = await rt.exec('axn-dev list');
      setOverview({
        status: 'ready',
        sections: parseAxnDevList(out),
        fetchedAt: Date.now(),
      });
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
// Full plugin view — a simplified `axn-dev list` (no start/stop)
// ---------------------------------------------------------------------------

function ScenarioRow({ scenario }: { scenario: AxnDevScenario }) {
  return (
    <div className="rounded px-2 py-1">
      <div className="flex items-center gap-2">
        <span
          className={`shrink-0 text-[10px] leading-none ${
            scenario.running ? 'text-[var(--green)]' : 'text-[var(--text-secondary)]'
          }`}
        >
          {scenario.running ? '●' : '○'}
        </span>
        <span className="shrink-0 font-mono text-[11px] font-semibold text-[var(--text-primary)]">
          {scenario.name}
        </span>
        {scenario.worktree && (
          <span
            className="flex shrink-0 items-center gap-0.5 rounded bg-purple-500/15 px-1 font-mono text-[9px] text-purple-400"
            data-tip={scenario.worktree.path}
          >
            <GitFork className="h-2.5 w-2.5" />
            {scenario.worktree.branch}
          </span>
        )}
        <span
          className="min-w-0 flex-1 truncate text-[10px] text-[var(--text-secondary)]"
          data-tip={scenario.description || undefined}
        >
          {scenario.description}
        </span>
      </div>
      {scenario.endpoints.length > 0 && (
        <div className="ml-5 flex flex-col gap-0.5 pt-0.5">
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
  runningOnly,
}: {
  section: ScenarioSection;
  runningOnly: boolean;
}) {
  const scenarios = runningOnly
    ? section.scenarios.filter((s) => s.running)
    : section.scenarios;
  if (scenarios.length === 0) return null;
  const running = section.scenarios.filter((s) => s.running).length;
  return (
    <div className="mb-4">
      <div className="mb-1 flex items-baseline gap-2 px-2 text-[10px] uppercase tracking-wide text-[var(--text-secondary)]">
        <span>{section.scope === 'global' ? 'global scenarios' : section.label}</span>
        <span className={running > 0 ? 'font-semibold text-[var(--green)]' : ''}>
          {running}/{section.scenarios.length}
        </span>
      </div>
      <div className="flex flex-col gap-0.5">
        {scenarios.map((s) => (
          <ScenarioRow key={s.key} scenario={s} />
        ))}
      </div>
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
  const runningOnly =
    (appState as { runningOnly?: boolean } | undefined)?.runningOnly === true;

  useEffect(() => {
    if (data.status === 'idle') void refreshScenarios();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { total, running } = countScenarios(data.sections);
  const sections = runningOnly
    ? data.sections.filter((s) => s.scenarios.some((x) => x.running))
    : data.sections;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg)]">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-secondary)] px-3">
        <Boxes className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-primary)]">
          axn-dev scenarios
        </span>
        {data.fetchedAt && (
          <span className="text-[10px] text-[var(--text-secondary)]">
            updated {Math.max(0, Math.round((Date.now() - data.fetchedAt) / 1000))}s ago
          </span>
        )}
        <div className="flex-1" />
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
            <div className="mb-1 font-semibold text-red-500">failed to load scenarios</div>
            <div className="mb-2 text-[var(--text-secondary)]">{data.error}</div>
            <div className="text-[var(--text-secondary)]">
              Check <code className="text-[var(--accent)]">axn-dev list</code> in a shell.
            </div>
          </div>
        ) : sections.length === 0 ? (
          <div className="px-2 py-1 text-[11px] italic text-[var(--text-secondary)]">
            {data.status === 'loading' && total === 0
              ? 'loading…'
              : runningOnly && running === 0
                ? 'no running scenarios'
                : 'no scenarios found'}
          </div>
        ) : (
          <>
            {sections.map((section) => (
              <ScenarioSectionView
                key={`${section.scope}:${section.label}`}
                section={section}
                runningOnly={runningOnly}
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

export const axnDevPlugin: SessionViewPlugin = {
  id: 'axn-dev',
  title: 'axn-dev scenarios',
  version: '0.1.0',
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
