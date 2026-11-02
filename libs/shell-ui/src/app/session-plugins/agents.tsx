import { t } from '@lingui/core/macro';
import { i18n } from '../../i18n';
import { Bot, Play } from 'lucide-react';
import type { ShellSession, Workspace } from '../../types';
import type { PluginApi, SessionViewContext, SessionViewPlugin } from './plugin';
import { axnLog } from '../log';
import { pickFromList } from '../pickerHost';
import { SessionIconGlyph } from '../SessionPanel';
import { useIconBag, resolveProcessIcon } from '../iconModel';
import { agentLaunchLine } from './devWorkflow';
import {
  listPersonas,
  parsePersonas,
  registerPersonas,
  resolvePersona,
  type AgentPersona,
} from './agentRegistry';

/**
 * Agents — first-class agent personas. `agents.personas` in plugins.yaml
 * declares reusable `{ cli, model, args, prompt, prompt-file, instructions,
 * instructions-file, description }` bundles; this plugin owns that section
 * and mirrors it into the shared `agentRegistry` on every ctx touch, so
 * other plugins (dev-workflow's `agent: <name>` step references) resolve
 * the same definitions. `prompt` is the kickoff message; `instructions` is
 * the persistent identity, delivered by the cli's registered launcher.
 *
 * Launch surfaces: the rail icon opens a full-area view of persona cards
 * (name, cli/model, description, live sessions), a card's Launch spawns a
 * session seeded with the persona's launch line, session context menus
 * offer "New session with <persona>", and `axn-agent <name>` types the
 * launch line in the current shell. Sessions stamped with a persona show
 * a row badge — the persona survives as the session's identity beyond
 * process detection.
 */

type Ctx = SessionViewContext & PluginApi;

/** Personas yaml is the source of truth — re-parse on every ctx touch.
 * The owning device publishes its personas through appState so remote
 * devices without a local plugins.yaml render the same agents view. */
function syncRegistry(settings: unknown): AgentPersona[] {
  const personas = parsePersonas(settings);
  registerPersonas(personas);
  return personas;
}

function publishPersonas(ctx: Ctx): void {
  const personas = syncRegistry(ctx.pluginSettings);
  const shared = (ctx.appState as { personas?: AgentPersona[] } | undefined)?.personas;
  if (personas.length && JSON.stringify(personas) !== JSON.stringify(shared)) {
    ctx.updateAppState?.({ personas });
  }
}

/** Local personas win; devices without plugins.yaml fall back to the
 * shared list published upstream. */
function resolvePersonas(settings: unknown, appState: unknown): AgentPersona[] {
  const local = parsePersonas(settings);
  if (local.length) return local;
  return ((appState as { personas?: AgentPersona[] } | undefined)?.personas ?? local);
}

const echo = (msg: string) => `echo ${JSON.stringify(msg)}`;

/**
 * The launch line for a persona — inline prompt, else prompt-file text —
 * built by the persona CLI's registered launcher (agent plugins own their
 * launch semantics; a refusal, e.g. an existing GEMINI.md, throws with a
 * user-facing message).
 */
async function personaCommand(ctx: Ctx, persona: AgentPersona): Promise<string> {
  const cwd = (await ctx.getCwd().catch(() => null)) ?? ctx.getSession().cwd ?? '';
  const prompt =
    persona.prompt ??
    (persona.promptFile
      ? await ctx.readFile(persona.promptFile, cwd).catch(() => undefined)
      : undefined);
  return agentLaunchLine(persona.cli, persona, prompt, ctx, cwd);
}

/** Session names → personas queued for the next session that opens with that name. */
const pendingLaunches = new Map<string, AgentPersona[]>();

/** Spawn a fresh session named after the persona and seed its launch line. */
function launchPersonaSession(ctx: Ctx, persona: AgentPersona, cwd?: string): void {
  const queue = pendingLaunches.get(persona.name) ?? [];
  queue.push(persona);
  pendingLaunches.set(persona.name, queue);
  ctx.openSession(cwd ?? ctx.session.cwd, persona.name);
}

/** The session's stamped persona, if any. */
function personaOf(session: ShellSession): string | undefined {
  return (session.pluginState?.['agents'] as { persona?: string } | undefined)?.persona;
}

/** Sessions running a persona — stamped, or heuristically the cli as foreground. */
function sessionsFor(persona: AgentPersona, sessions: ShellSession[]): ShellSession[] {
  return sessions.filter(
    (s) => personaOf(s) === persona.name || s.process?.toLowerCase() === persona.cli,
  );
}

// ---------------------------------------------------------------------------
// Persona card view
// ---------------------------------------------------------------------------

/**
 * The CLI's configured process icon (the icon its sessions show in
 * the panel — e.g. a claude persona gets claude's icon), Bot otherwise.
 */
function AgentIcon({ cli, className }: { cli?: string; className: string }) {
  const bag = useIconBag();
  const value = resolveProcessIcon(cli, bag, 'Bot');
  return <SessionIconGlyph value={value} className={`${className} text-[var(--accent)]`} />;
}

function PersonaCard({
  persona,
  running,
  api,
  onLaunch,
}: {
  persona: AgentPersona;
  running: ShellSession[];
  api: Ctx | undefined;
  onLaunch: (persona: AgentPersona) => void;
}) {
  const spec = [
    persona.cli,
    persona.model,
    persona.args ? `+args` : undefined,
    persona.promptFile ? `+prompt-file` : persona.prompt ? '+prompt' : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="flex items-center gap-1.5">
        <AgentIcon cli={persona.cli} className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-[var(--text-primary)]">
          {persona.name}
        </span>
      </div>
      <div className="truncate text-[10px] text-[var(--text-secondary)]" data-tip={spec}>
        {spec}
      </div>
      {persona.description && (
        <div
          className="line-clamp-2 text-[10px] text-[var(--text-secondary)]"
          data-tip={persona.description}
        >
          {persona.description}
        </div>
      )}
      <div className="mt-1 flex items-center justify-between">
        <span className="text-[9px] text-[var(--text-secondary)]">
          {running.length > 0 ? `${running.length} session${running.length === 1 ? '' : 's'}` : ''}
        </span>
        <span data-tip={api ? `open a session running ${persona.name}` : 'no session to launch from'}>
          <button
            type="button"
            disabled={!api}
            onClick={() => onLaunch(persona)}
            className="flex items-center gap-1 rounded border border-[var(--border)] px-2 py-1 text-[10px] font-semibold text-[var(--text-primary)] transition hover:bg-[var(--surface-hover)] disabled:opacity-40"
          >
            <Play className="h-3 w-3" />
            Launch
          </button>
        </span>
      </div>
    </div>
  );
}

function AgentsView({
  pluginSettings,
  appState,
  sessions,
  workspaces,
  sessionApi,
  selectSession,
  close,
}: {
  pluginSettings: unknown;
  appState?: unknown;
  sessions: ShellSession[];
  workspaces: Workspace[];
  sessionApi: (id: string) => Ctx | undefined;
  selectSession: (id: string) => void;
  close: () => void;
}) {
  const personas = resolvePersonas(pluginSettings, appState);
  const api = sessions.length > 0 ? sessionApi(sessions[0].id) : undefined;
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
      <div className="flex items-center gap-2">
        <Bot className="h-4 w-4 text-[var(--accent)]" />
        <span className="text-[12px] font-semibold text-[var(--text-primary)]">agents</span>
        <span className="text-[10px] text-[var(--text-secondary)]">
          {personas.length > 0
            ? `${personas.length} persona${personas.length === 1 ? '' : 's'} — declare more under agents.personas in plugins.yaml`
            : 'no personas — declare them under agents.personas in plugins.yaml'}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {personas.map((p) => {
          const running = sessionsFor(p, sessions);
          return (
            <PersonaCard
              key={p.name}
              persona={p}
              running={running}
              api={api}
              onLaunch={(persona) => {
                if (!api) return;
                launchPersonaSession(api, persona);
                close();
              }}
            />
          );
        })}
      </div>
      {runningSection(personas, sessions, workspaces, selectSession)}
    </div>
  );
}

function RunningSessionRow({
  session,
  onSelect,
}: {
  session: ShellSession;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex items-center gap-2 rounded border border-[var(--border)] px-2 py-1 text-left text-[10px] text-[var(--text-primary)] transition hover:bg-[var(--surface-hover)]"
    >
      <AgentIcon cli={session.process} className="h-3 w-3 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{session.name ?? session.id}</span>
      <span className="shrink-0 text-[9px] text-[var(--text-secondary)]">
        {personaOf(session) ?? session.process}
      </span>
    </button>
  );
}

function runningSection(
  personas: AgentPersona[],
  sessions: ShellSession[],
  workspaces: Workspace[],
  selectSession: (id: string) => void,
) {
  const bound = sessions.filter((s) => {
    const stamped = personaOf(s);
    return stamped
      ? personas.some((p) => p.name === stamped)
      : personas.some((p) => p.cli === s.process?.toLowerCase());
  });
  if (bound.length === 0) return null;
  // Group by workspace in panel order — a session whose workspace vanished
  // still shows, in a trailing unlabeled group.
  const groups = workspaces
    .map((ws) => ({
      ws,
      sessions: bound.filter((s) => s.workspaceId === ws.id),
    }))
    .filter((g) => g.sessions.length > 0);
  const orphans = bound.filter(
    (s) => !workspaces.some((w) => w.id === s.workspaceId),
  );
  const rows = (list: ShellSession[]) =>
    list.map((s) => (
      <RunningSessionRow key={s.id} session={s} onSelect={() => selectSession(s.id)} />
    ));
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[10px] font-semibold text-[var(--text-secondary)]">running</div>
      {groups.map(({ ws, sessions: wsSessions }) => (
        <div key={ws.id} className="flex flex-col gap-1">
          <div
            className="px-1 text-[9px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]"
            data-tip={ws.defaultFolder}
          >
            {ws.name}
          </div>
          <div className="ml-2 flex flex-col gap-1 border-l border-[var(--border)] pl-2">
            {rows(wsSessions)}
          </div>
        </div>
      ))}
      {orphans.length > 0 && (
        <div className="ml-2 flex flex-col gap-1 border-l border-[var(--border)] pl-2">
          {rows(orphans)}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

/** Searchable persona picker — resolves the chosen persona, or null. */
async function pickPersona(): Promise<AgentPersona | null> {
  const personas = listPersonas();
  const key = await pickFromList({
    title: 'New session with agent',
    placeholder: 'Search agents…',
    items: personas.map((p) => ({
      key: p.name,
      label: p.name,
      detail: p.description ?? [p.cli, p.model].filter(Boolean).join(' · '),
    })),
  });
  return personas.find((p) => p.name === key) ?? null;
}

export const agentsPlugin: SessionViewPlugin = {
  id: 'agents',
  title: 'agents',
  version: '0.1.0',
  defaultEnabled: true,

  onSessionOpen: (ctx) => {
    publishPersonas(ctx);
    const queue = pendingLaunches.get(ctx.session.name);
    const persona = queue?.shift();
    if (!persona) return;
    if (queue && queue.length === 0) pendingLaunches.delete(ctx.session.name);
    ctx.updatePluginState({ persona: persona.name });
    void ctx.waitForSessionOutput(5000).then(async () => {
      try {
        await ctx.writeToSession(`${await personaCommand(ctx, persona)}\n`);
      } catch (e) {
        // A launcher's refusal —
        // visible on the session, not a silent no-op.
        const msg = String(e instanceof Error ? e.message : e);
        ctx.setAttention({ level: 'warning', message: msg });
        axnLog('warn', 'agents', `persona '${persona.name}' launch refused: ${msg}`);
      }
    });
  },

  onOutput: (ctx) => {
    publishPersonas(ctx);
  },

  commands: [
    {
      // `axn-agent <persona>` — type the persona's launch line in this shell.
      name: 'axn-agent',
      takesArg: true,
      completeArg: (ctx, prefix) => {
        syncRegistry(ctx.pluginSettings);
        return listPersonas()
          .map((p) => p.name)
          .filter((n) => n.startsWith(prefix));
      },
      run: async (ctx, arg) => {
        syncRegistry(ctx.pluginSettings);
        const name = (arg ?? '').trim();
        const persona = name ? resolvePersona(name) : undefined;
        if (!persona) {
          const known = listPersonas()
            .map((p) => p.name)
            .join(', ');
          return echo(
            name
              ? `axn-agent: unknown persona '${name}'${known ? ` — known: ${known}` : ''}`
              : 'usage: axn-agent <persona>',
          );
        }
        ctx.updatePluginState({ persona: persona.name });
        try {
          return await personaCommand(ctx, persona);
        } catch (e) {
          return echo(String(e instanceof Error ? e.message : e));
        }
      },
    },
  ],

  // One "New session with agent…" row opening a searchable persona picker,
  // instead of a row per persona.
  sessionMenuItems: (ctx) => {
    syncRegistry(ctx.pluginSettings);
    if (listPersonas().length === 0) return [];
    return [
      {
        label: i18n._(t`New session with agent…`),
        onClick: () =>
          void pickPersona().then((persona) => persona && launchPersonaSession(ctx, persona)),
      },
    ];
  },

  workspaceMenuItems: (ctx, workspace) => {
    syncRegistry(ctx.pluginSettings);
    if (!workspace.defaultFolder || listPersonas().length === 0) return [];
    return [
      {
        label: i18n._(t`New session with agent…`),
        onClick: () =>
          void pickPersona().then(
            (persona) => persona && launchPersonaSession(ctx, persona, workspace.defaultFolder),
          ),
      },
    ];
  },

  renderRail: ({ pluginSettings, appState, viewActive, toggleView }) => {
    const personas = resolvePersonas(pluginSettings, appState);
    return (
      <button
        type="button"
        onClick={toggleView}
        data-tip={`agents — ${personas.length} persona${personas.length === 1 ? '' : 's'}`}
        className={`flex flex-col items-center gap-0.5 rounded px-1 py-0.5 transition ${
          viewActive
            ? 'bg-[var(--surface)] text-[var(--accent)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--surface)] hover:text-[var(--text-primary)]'
        }`}
      >
        <Bot className="h-3.5 w-3.5" />
        {personas.length > 0 && (
          <span className="select-none text-[8px] font-bold leading-none">
            {personas.length}
          </span>
        )}
      </button>
    );
  },

  renderView: ({ pluginSettings, appState, sessions, workspaces, sessionApi, selectSession, close }) => (
    <AgentsView
      pluginSettings={pluginSettings}
      appState={appState}
      sessions={sessions}
      workspaces={workspaces}
      sessionApi={sessionApi}
      selectSession={selectSession}
      close={close}
    />
  ),

  renderRow: (ctx) => {
    const persona = personaOf(ctx.session);
    if (!persona) return null;
    return (
      <span
        className="flex shrink-0 items-center gap-0.5 font-mono text-[9px] leading-none text-[var(--accent)]"
        data-tip={`persona: ${persona}`}
      >
        <Bot className="h-2.5 w-2.5 shrink-0" />
        <span className="max-w-16 truncate">{persona}</span>
      </span>
    );
  },

  rowTip: (ctx) => {
    const persona = personaOf(ctx.session);
    return persona ? `${persona}: agent persona of this session` : null;
  },
};
