import { useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Layers,
  Loader2,
  Play,
  RefreshCw,
  RotateCw,
  ScrollText,
  Square,
  X,
} from 'lucide-react';
import type { PluginApi, SessionViewContext } from './plugin';
import type { ShellSession } from '../../types';
import { ptyIdOf } from '../../types';
import { useSessionBackend } from '../../services';
import { PanelSearch, PluginIcon } from '../SessionPanel';
import { dockerPlugin, parseDockerAvailability } from './docker';
import type { DockerAvailability } from './docker';

/**
 * `docker ps -a` + `docker stats --no-stream`, one probe — same shell-script
 * style as the rail's. An `==unavailable==` section (`no-cli`/`daemon-down`)
 * replaces the container listing when the daemon can't be queried, so the
 * view can say "docker is down" instead of showing an empty list.
 */
const PS_CMD = `if ! command -v docker >/dev/null 2>&1; then
  echo '==unavailable=='
  echo 'no-cli'
  exit 0
fi
if ! docker info >/dev/null 2>&1; then
  echo '==unavailable=='
  echo 'daemon-down'
  exit 0
fi
docker ps -a --format '{{json .}}' 2>/dev/null
echo '==stats=='
docker stats --no-stream --format '{{json .}}' 2>/dev/null || echo unavailable`;

interface RawPs {
  ID?: string; Names?: string; Image?: string; State?: string; Status?: string;
  Ports?: string; Labels?: string;
}
interface RawStat { Name?: string; CPUPerc?: string; MemUsage?: string; MemPerc?: string }

export interface DockerContainer {
  id: string; name: string; image: string; state: string; status: string;
  ports: string; project?: string; service?: string;
  cpu?: string; mem?: string;
}

export function parsePs(output: string): DockerContainer[] {
  const [psSec] = output.split('==stats==');
  const stats = new Map<string, { cpu: string; mem: string }>();
  for (const line of (output.split('==stats==')[1] ?? '').split('\n')) {
    try {
      const j = JSON.parse(line) as RawStat;
      if (j?.Name) stats.set(j.Name, { cpu: j.CPUPerc ?? '', mem: j.MemUsage?.split('/')[0]?.trim() ?? '' });
    } catch { /* ignore */ }
  }
  const out: DockerContainer[] = [];
  for (const line of psSec.split('\n')) {
    try {
      const j = JSON.parse(line) as RawPs;
      if (!j?.ID) continue;
      const labels = new Map(
        (j.Labels ?? '').split(',').map((l) => l.split(/=(.*)/) as [string, string]),
      );
      out.push({
        id: j.ID, name: j.Names ?? j.ID, image: j.Image ?? '', state: j.State ?? '',
        status: j.Status ?? '', ports: j.Ports ?? '',
        project: labels.get('com.docker.compose.project'),
        service: labels.get('com.docker.compose.service'),
        cpu: stats.get(j.Names ?? '')?.cpu,
        mem: stats.get(j.Names ?? '')?.mem,
      });
    } catch { /* skip */ }
  }
  return out;
}

/** Filter predicate shared by the list filter — name/image/service/project substring. */
export function containerMatches(c: DockerContainer, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [c.name, c.image, c.service ?? '', c.project ?? ''].some((v) =>
    v.toLowerCase().includes(q),
  );
}

// ---------------------------------------------------------------------------
// Overview store — module-level so the last listing survives view switches
// (same pattern as the axn-dev overview); ops track in-flight lifecycle calls
// per container id so a row can spin and surface a failed command.
// ---------------------------------------------------------------------------

export interface DockerOp {
  op: 'start' | 'stop' | 'restart';
  /** Set when the last attempt failed — the button is re-enabled. */
  error?: string;
}

export interface DockerOverview {
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: string;
  containers: DockerContainer[];
  /** Result of the last probe's daemon check — `unknown` until a probe lands. */
  availability: DockerAvailability;
  fetchedAt?: number;
  /** In-flight (or last failed) lifecycle ops, keyed by container id. */
  ops: Record<string, DockerOp>;
}

let overview: DockerOverview = { status: 'idle', containers: [], availability: 'unknown', ops: {} };
const overviewListeners = new Set<() => void>();

function setOverview(next: DockerOverview) {
  overview = next;
  for (const listener of overviewListeners) listener();
}

export function useDockerOverview(): DockerOverview {
  return useSyncExternalStore(
    (listener) => {
      overviewListeners.add(listener);
      return () => overviewListeners.delete(listener);
    },
    () => overview,
  );
}

let refreshInFlight: Promise<void> | null = null;

/** `sh -c` exec in a live session's environment (or the desktop host). */
export type DockerExec = (command: string) => Promise<string>;

export function refreshContainers(exec: DockerExec): Promise<void> {
  refreshInFlight ??= (async () => {
    setOverview({ ...overview, status: 'loading' });
    try {
      const out = await exec(PS_CMD);
      setOverview({
        status: 'ready', containers: parsePs(out),
        availability: parseDockerAvailability(out),
        fetchedAt: Date.now(), ops: overview.ops,
      });
    } catch (e) {
      setOverview({
        ...overview,
        status: overview.containers.length ? overview.status : 'error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/**
 * `docker start|stop|restart` — tracked per container so its row shows a
 * pending spinner; the list refreshes as soon as the command completes so
 * the state change is visible without waiting for the poll interval.
 */
export async function runContainerOp(
  exec: DockerExec,
  c: DockerContainer,
  op: DockerOp['op'],
): Promise<void> {
  setOverview({ ...overview, ops: { ...overview.ops, [c.id]: { op } } });
  try {
    await exec(`docker ${op} ${c.id}`);
    const cleared = { ...overview.ops };
    delete cleared[c.id];
    setOverview({ ...overview, ops: cleared });
  } catch (e) {
    setOverview({
      ...overview,
      ops: {
        ...overview.ops,
        [c.id]: { op, error: e instanceof Error ? e.message : String(e) },
      },
    });
  }
  void refreshContainers(exec);
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

function stateColor(state: string): string {
  if (state === 'running') return 'var(--green)';
  if (state === 'paused') return 'var(--yellow)';
  return 'var(--text-secondary)';
}

const iconBtn =
  'rounded p-0.5 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-40';

export function DockerView({
  sessions, pluginSettings, close, selectSession, sessionApi, appState, updateAppState,
}: {
  sessions: ShellSession[];
  pluginSettings: unknown;
  close: () => void;
  selectSession: (sessionId: string) => void;
  sessionApi: (id: string) => (SessionViewContext & PluginApi) | undefined;
  appState: unknown;
  updateAppState: (patch: Record<string, unknown>) => void;
}) {
  const backend = useSessionBackend();
  const data = useDockerOverview();
  const state = (appState ?? {}) as { runningOnly?: boolean; query?: string };
  const runningOnly = state.runningOnly === true;
  const query = state.query ?? '';
  const intervalSec =
    (pluginSettings as { refreshIntervalSeconds?: number } | undefined)
      ?.refreshIntervalSeconds ?? 15;
  // Same target the rail uses: desktop exec ignores the id and runs on the
  // host; over WS any session's connection reaches the same session host.
  const target = sessions.length > 0 ? ptyIdOf(sessions[0]) : '';
  const exec: DockerExec = (command) => {
    const run = backend.exec?.bind(backend);
    if (!run) return Promise.reject(new Error('exec is not available on this backend'));
    return run(target, command);
  };

  useEffect(() => {
    if (!backend.exec) return;
    const stale =
      data.status === 'idle' ||
      (data.fetchedAt != null && Date.now() - data.fetchedAt > Math.max(5, intervalSec) * 1000);
    if (stale) void refreshContainers(exec);
    const t = setInterval(
      () => void refreshContainers(exec),
      Math.max(5, intervalSec) * 1000,
    );
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, target, intervalSec]);

  const groups = useMemo(() => {
    const projects = new Map<string, DockerContainer[]>();
    const standalone: DockerContainer[] = [];
    const visible = data.containers.filter(
      (c) => (!runningOnly || c.state === 'running') && containerMatches(c, query),
    );
    for (const c of visible) {
      if (c.project) {
        const g = projects.get(c.project) ?? [];
        g.push(c);
        projects.set(c.project, g);
      } else standalone.push(c);
    }
    return { projects: [...projects.entries()].sort((a, b) => a[0].localeCompare(b[0])), standalone, visible };
  }, [data.containers, runningOnly, query]);

  function openLogs(c: DockerContainer) {
    const sid = sessions[0]?.id;
    if (!sid) return;
    // A labeled subshell tab — writing the command into the session's main
    // PTY would land as input to whatever TUI is in the foreground there.
    const tabId = sessionApi(sid)?.openSubShell(
      `docker logs -f --tail 200 ${c.name}`,
      undefined,
      `logs ${c.name}`,
    );
    if (tabId != null) selectSession(sid);
  }

  function Row({ c }: { c: DockerContainer }) {
    const running = c.state === 'running';
    const op = data.ops[c.id];
    const pending = op !== undefined && !op.error;
    return (
      <div className="px-3 py-1 text-[11px] hover:bg-[var(--surface)]">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: stateColor(c.state) }}
            data-tip={c.status || c.state} />
          <span className="min-w-0 flex-1 truncate font-medium text-[var(--text-primary)]" data-tip={c.name}>
            {c.service ?? c.name}
            {c.service && (
              <span className="ml-1.5 font-mono text-[10px] font-normal text-[var(--text-secondary)]">
                {c.name}
              </span>
            )}
          </span>
          <span className="hidden w-32 shrink-0 truncate text-[var(--text-secondary)] sm:block" data-tip={c.image}>{c.image}</span>
          {c.ports && <span className="hidden w-24 shrink-0 truncate text-[10px] text-[var(--text-secondary)] md:block" data-tip={c.ports}>{c.ports}</span>}
          <span className="w-14 shrink-0 text-right font-mono text-[10px] text-[var(--text-secondary)]">{running ? c.cpu ?? '—' : ''}</span>
          <span className="w-16 shrink-0 text-right font-mono text-[10px] text-[var(--text-secondary)]">{running ? c.mem ?? '—' : ''}</span>
          <span className="flex shrink-0 items-center gap-0.5">
            <button type="button" aria-label={`logs ${c.name}`}
              data-tip={sessions.length ? `docker logs -f ${c.name} (new tab)` : 'no session for logs'}
              disabled={!sessions.length} onClick={() => openLogs(c)}
              className={`${iconBtn} hover:text-[var(--text-primary)]`}>
              <ScrollText className="h-3 w-3" />
            </button>
            {running ? (
              <>
                <button type="button" aria-label={`restart ${c.name}`} data-tip={`docker restart ${c.name}`}
                  disabled={pending} onClick={() => void runContainerOp(exec, c, 'restart')}
                  className={`${iconBtn} hover:text-[var(--text-primary)]`}>
                  {pending && op.op === 'restart' ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCw className="h-3 w-3" />}
                </button>
                <button type="button" aria-label={`stop ${c.name}`} data-tip={`docker stop ${c.name}`}
                  disabled={pending} onClick={() => void runContainerOp(exec, c, 'stop')}
                  className={`${iconBtn} hover:text-[var(--red)]`}>
                  {pending && op.op === 'stop' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3" />}
                </button>
              </>
            ) : (
              <button type="button" aria-label={`start ${c.name}`} data-tip={`docker start ${c.name}`}
                disabled={pending} onClick={() => void runContainerOp(exec, c, 'start')}
                className={`${iconBtn} hover:text-[var(--green)]`}>
                {pending && op.op === 'start' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
              </button>
            )}
          </span>
        </div>
        {op?.error && (
          <div className="ml-4 break-words text-[10px] text-[var(--red)]">
            {op.op} failed: {op.error}
          </div>
        )}
      </div>
    );
  }

  const running = data.containers.filter((c) => c.state === 'running').length;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg)]">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-secondary)] px-3">
        <PluginIcon plugin={dockerPlugin} className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-primary)]">docker</span>
        <div className="min-w-0 flex-1">
          <PanelSearch
            value={query}
            onChange={(v) => updateAppState({ query: v })}
            placeholder="Filter containers…"
          />
        </div>
        <button
          type="button"
          onClick={() => updateAppState({ runningOnly: !runningOnly })}
          data-tip="Only list running containers"
          className={`flex h-6 items-center rounded px-2 text-[10px] transition ${
            runningOnly
              ? 'bg-[var(--surface)] text-[var(--accent)]'
              : 'text-[var(--text-secondary)] hover:bg-[var(--surface)] hover:text-[var(--text-primary)]'
          }`}
        >
          running only
        </button>
        <span
          className={`text-[10px] ${running > 0 ? 'font-semibold text-[var(--green)]' : 'text-[var(--text-secondary)]'}`}
          data-tip="running / total containers"
        >
          {running}/{data.containers.length}
        </span>
        {data.fetchedAt && (
          <span className="text-[10px] text-[var(--text-secondary)]">
            updated {Math.max(0, Math.round((Date.now() - data.fetchedAt) / 1000))}s ago
          </span>
        )}
        <button type="button" onClick={() => void refreshContainers(exec)} data-tip="Refresh"
          aria-label="Refresh"
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-secondary)] transition hover:bg-[var(--surface)] hover:text-[var(--text-primary)]">
          <RefreshCw className={`h-3.5 w-3.5 ${data.status === 'loading' ? 'animate-spin' : ''}`} />
        </button>
        <button type="button" onClick={close} aria-label="Close" data-tip="Close"
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-secondary)] transition hover:bg-[var(--surface)] hover:text-[var(--text-primary)]">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {data.status === 'error' ? (
          <div className="m-3 rounded border border-[var(--border)] bg-[var(--surface)] p-3 text-[11px] text-[var(--text-primary)]">
            <div className="mb-1 font-semibold text-[var(--red)]">failed to list containers</div>
            <div className="mb-2 text-[var(--text-secondary)]">{data.error}</div>
            <div className="text-[var(--text-secondary)]">
              Check <code className="text-[var(--accent)]">docker ps</code> in a shell.
            </div>
          </div>
        ) : data.availability === 'daemon-down' ? (
          <div className="m-3 rounded border border-[var(--border)] bg-[var(--surface)] p-3 text-[11px] text-[var(--text-primary)]">
            <div className="mb-1 font-semibold text-[var(--yellow)]">docker daemon is not running</div>
            <div className="text-[var(--text-secondary)]">
              Start colima or Docker Desktop, then refresh.
            </div>
          </div>
        ) : data.availability === 'no-cli' ? (
          <div className="p-4 text-[11px] text-[var(--text-secondary)]">
            No docker CLI on this host.
          </div>
        ) : data.containers.length === 0 ? (
          <div className="p-4 text-[11px] text-[var(--text-secondary)]">
            {data.status === 'loading' ? 'loading…' : 'No containers.'}
          </div>
        ) : groups.visible.length === 0 ? (
          <div className="p-4 text-[11px] italic text-[var(--text-secondary)]">
            {query ? 'no matches' : 'no running containers'}
          </div>
        ) : (
          <>
            {groups.projects.length > 0 && (
              <SectionHeader label="compose projects" count={groups.projects.length}
                tip="containers grouped by their docker compose project" />
            )}
            {groups.projects.map(([project, members]) => (
              <ProjectGroup key={project} project={project} members={members} Row={Row} />
            ))}
            {groups.standalone.length > 0 && (
              <div>
                <SectionHeader label="standalone containers" count={groups.standalone.length}
                  tip="not managed by a docker compose project" />
                {groups.standalone.map((c) => <Row key={c.id} c={c} />)}
              </div>
            )}
            {data.status === 'loading' && (
              <div className="px-3 text-[10px] italic text-[var(--text-secondary)]">refreshing…</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SectionHeader({ label, count, tip }: { label: string; count: number; tip: string }) {
  return (
    <div className="flex items-baseline gap-2 px-3 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]"
      data-tip={tip}>
      <span>{label}</span>
      <span className="font-normal">{count}</span>
    </div>
  );
}

function ProjectGroup({
  project, members, Row,
}: {
  project: string;
  members: DockerContainer[];
  Row: (props: { c: DockerContainer }) => React.ReactNode;
}) {
  const isCollapsed = useCollapsed(project);
  const running = members.filter((c) => c.state === 'running').length;
  return (
    <div>
      <button type="button"
        onClick={() => toggleCollapsed(project)}
        className="flex w-full items-center gap-1 px-2 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
        {isCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        <Layers className="h-3 w-3" data-tip="docker compose project" />
        {project}
        <span className={`font-normal ${running > 0 ? 'text-[var(--green)]' : ''}`}>
          {running}/{members.length}
        </span>
      </button>
      {!isCollapsed && (
        <div className="border-l border-[var(--border)]" style={{ marginLeft: '14px' }}>
          {members.map((c) => <Row key={c.id} c={c} />)}
        </div>
      )}
    </div>
  );
}

// Collapsed project set — module-level so it survives view switches.
const collapsedProjects = new Set<string>();
function toggleCollapsed(project: string) {
  if (collapsedProjects.has(project)) collapsedProjects.delete(project);
  else collapsedProjects.add(project);
  for (const listener of collapsedListeners) listener();
}
const collapsedListeners = new Set<() => void>();
function useCollapsed(project: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      collapsedListeners.add(listener);
      return () => collapsedListeners.delete(listener);
    },
    () => collapsedProjects.has(project),
  );
}
