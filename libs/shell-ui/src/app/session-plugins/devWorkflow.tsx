import { t } from '@lingui/core/macro';
import { PublishPanelStatus } from '../PanelStatusSection';
import { i18n } from '../../i18n';
import { useEffect, useRef, useState } from 'react';
import { load as loadYaml, dump as dumpYaml } from 'js-yaml';
import { AlertTriangle, ChevronLeft, ChevronRight, Columns3, Loader2, Play, Workflow } from 'lucide-react';
import type { ShellSession, Workspace } from '../../types';
import { SessionIcon } from '../SessionPanel';
import { RailItem } from '../RailItem';
import { usePluginSettings } from '../PluginSettingsProvider';
import { WorkspacePicker } from '../../WorkspacePicker';
import { axnLog } from '../log';
import { promptArg, shellQuote, shellWord } from '../../shellQuote';
import { shellTokens } from '../shellCommandSupport';
import { forgeOfRemote } from './forge';
import { pickFromList } from '../pickerHost';
import { resolvePersona, agentLauncherFor } from './agentRegistry';
import type { AgentLaunchTools } from './agentRegistry';
import { CardChips, ChipView, useCardEnrichment, type CardSubject } from './cardEnrichers';
import {
  peekMrDetails,
  registerMrActions,
  resolveMrDetails,
  useMrDetails,
  type MrActionProps,
  type MrRef,
  type MrRowEnv,
} from './mrActions';
import { MR_ROLES, type MrRole } from './forge';
import { normalizeReviewAgent } from '../gitReview';
import { checkoutsOf, localCheckouts, parseRepoRoots, remoteMatchesProject } from '../repoDirectory';
import { ticketListKey, useTicketLists, type Ticket } from './ticketSources';
import type { PluginSettings } from '../pluginSettings';
import { shellServices } from '../../services';
import {
  normPath,
  worktreeBranchFor,
  worktreeDirFor,
} from './worktrees';
import type {
  PluginApi,
  PluginCommand,
  RepoMenuItem,
  SessionViewContext,
  SessionViewPlugin,
} from './plugin';

/**
 * dev-workflow: a meta layer above coding agents. Workflows are declared in
 * the plugin's plugins.yaml section (`dev-workflow.workflows.<id>`); each has
 * an ordered list of states and per-state `steps` — a map of named actions
 * (or a single anonymous action via the flat sugar form). An action either
 * launches an agent (devin/claude/vibe/any command template) or runs a plain
 * command whose exit code is recorded as a check result — informational
 * only, never gating.
 *
 * The state of record lives in the session's pluginState (persisted in
 * state.json, restored on reload). `tracking.file` is an OPTIONAL
 * agent-writable mirror — transitions are mirrored to it and file edits are
 * reconciled back (e.g. a speckit agent flips `state: plan` to
 * `state: plan-review`). Without a file, agents hand off by printing a
 * whole-line `axn-workflow-state[<token>]: <state>` marker — scanned from PTY
 * output. Three more whole-line output markers exist: `axn-workflow-check`
 * reports a check result, `axn-workflow-run` asks the plugin to fire a named
 * action, `axn-workflow-var` sets a var. Every marker carries the binding's
 * random token (`$AXN_WORKFLOW_TOKEN`, `{{workflow_token}}`), so text that
 * merely passes through the terminal — `cat` of a hostile README — cannot
 * drive the workflow.
 *
 * Task/progress/attention tracking once an action launches stays with the
 * agent's own plugin (devin/claude) via its processPattern.
 */

type Ctx = SessionViewContext & PluginApi;

export interface WorkflowAgentSpec {
  cli?: string;
  model?: string;
  /** Extra CLI args appended verbatim, e.g. "--permission-mode accept-edits". */
  args?: string;
  /**
   * Persistent identity/context, delivered through the CLI's instructions
   * channel (`--append-system-prompt(-file)` claude,
   * `-c developer_instructions=` codex) or prepended to the seed prompt
   * otherwise — a persona's values are defaults for these.
   */
  instructions?: string;
  /** cwd-relative; claude reads it natively, other CLIs get resolved text. */
  instructionsFile?: string;
  /**
   * Name of an `agents.personas` entry (the agents plugin's registry —
   * `agentRegistry.ts`). `agent: <string>` in config parses to this.
   * Inline `cli`/`model`/`args` override the persona's values; a persona's
   * `prompt`/`promptFile`/`instructions`/`instructionsFile` are defaults for
   * the action's own.
   */
  profile?: string;
}

/**
 * Name given to the single action when `steps.<state>` uses the flat sugar
 * form (`steps: { qa: { command: … } }`). Named actions come from the
 * `steps.<state>.<name>` map.
 */
export const ANONYMOUS_ACTION = 'default';

/**
 * One runnable action of a workflow state. Either `agent` (launch a coding
 * agent with a prompt) or `command` (a shell command — its exit code is
 * recorded as the action's check result).
 */
export interface WorkflowAction {
  /** Name within the state — ANONYMOUS_ACTION for the flat sugar form. */
  name: string;
  /** What the step is for — prepends the Run button's tooltip. */
  description?: string;
  /** Where the action runs: main shell (default), a labelled sub-shell tab, or headless. */
  runIn?: 'shell' | 'sub-shell' | 'headless';
  agent?: WorkflowAgentSpec;
  /**
   * Fire this action when the workflow STARTS — initial bind to the start
   * state only (`axn-workflow start`, menu start, MR-review session bind);
   * later moves into the state don't re-fire it.
   */
  auto?: boolean;
  prompt?: string;
  /** Prompt file resolved against the tracking base (repo root / cwd). */
  promptFile?: string;
  /**
   * Raw command template — {{prompt}} {{promptFile}} {{model}} {{state}}
   * {{workflow}} {{cwd}} {{tracking}} (resolved tracking.file path, empty
   * when no file is configured). `prompt`/`promptFile` text is expanded with
   * the same vars.
   */
  command?: string;
}

/** Recorded outcome of a command action's last run. */
export interface ActionCheck {
  status: 'running' | 'ok' | 'failed' | 'done';
  /** Process exit code when known (absent for 'done' — the web host reports none). */
  rc?: number;
  /** Epoch ms. */
  at: number;
  /** Short failure detail (stderr for headless runs). */
  message?: string;
}

/**
 * A workflow-declared input variable. Values are supplied at start
 * (`axn-workflow start <wf> [arg|key=value]`), via the session card's var
 * fields, the `axn-workflow set` command or the `axn-workflow-var[<token>]:` output
 * marker. They substitute into `{{key}}` templates and are exported to
 * every action's environment as `KEY` (camelCase/kebab → SNAKE).
 * `kind: 'mr'` marks the value as a merge/pull-request reference — a GitLab
 * MR url, a GitHub PR url or a bare `!123`/`#45` — and derives companion
 * vars `<key>_iid`, `<key>_url`, `<key>_project`, `<key>_host`.
 */
export interface WorkflowVarSpec {
  key: string;
  label?: string;
  hint?: string;
  required?: boolean;
  kind?: 'mr';
  /**
   * Conditions an MR must meet to fill this var (`kind: mr` only). Gates the
   * MR-row start button and `axn-workflow start <wf> <mr>`; absent = any MR.
   */
  when?: MrCondition;
}

/** `when` on a `kind: mr` var — every listed condition must hold. */
export interface MrCondition {
  /** Your role on the MR (`mrRole` in forge.ts); several = any of them. */
  role?: MrRole[];
}

export interface WorkflowDef {
  id: string;
  title: string;
  /**
   * Optional state file — relative paths resolve against the repo toplevel
   * (cwd outside repos), absolute paths are used verbatim. When set, the file
   * mirrors the session state and is agent-writable: edits reconcile back.
   * The file extension selects the encoding (.json → JSON, else YAML).
   * Absent = session pluginState only; agents hand off via the
   * `axn-workflow-state[<token>]:` output marker.
   */
  trackingFile?: string;
  trackingFormat: 'json' | 'yaml';
  states: string[];
  start: string;
  /** Declared input variables (see WorkflowVarSpec). */
  vars?: WorkflowVarSpec[];
  /** Optional allowlist: state -> states it may move to. Absent = free movement. */
  transitions?: Record<string, string[]>;
  /** Runnable actions per state — several named actions may share one state. */
  steps: Record<string, WorkflowAction[]>;
  /**
   * Ticket link — maps an external tracker's coarse statuses onto this
   * (finer) workflow. The status comes from a card enricher's fields
   * (`<source>.status` / `<source>.statusCategory`, e.g. the jira plugin).
   */
  tickets?: WorkflowTickets;
  /**
   * Per-state descriptions — shown in the session banner's lighter detail
   * text. Set by the flat action's `description` or the reserved
   * `description` key inside a named-actions map.
   */
  descriptions?: Record<string, string>;
}

export interface WorkflowTickets {
  /** Enricher id whose fields carry the status (default `jira`). */
  source: string;
  /** The workflow var holding the ticket key (default `ticket`). */
  var: string;
  /**
   * Tracker status (lowercased) → the workflow state a ticket in that status
   * enters at. Each mapped state opens a range that runs up to the next
   * mapped state, so one coarse status covers several local states.
   */
  statusMap: Record<string, string>;
  /**
   * Source query (JQL for jira) listing the tickets this workflow should
   * show — those without a session appear as backlog cards in their status's
   * entry state. Absent: no backlog, only enrichment of bound cards.
   */
  query?: string;
}

export interface WorkflowStateRecord {
  workflow: string;
  state: string;
  /** Epoch ms. */
  updated: number;
  history: { state: string; at: number }[];
}

/**
 * Per-session pluginState under 'dev-workflow' — the state of record.
 * Persisted in state.json with the session and restored on reload.
 */
export interface BindingState {
  workflow?: string;
  state?: string;
  updated?: number;
  history?: { state: string; at: number }[];
  /**
   * Last check result per command action, keyed `${state}:${name}`.
   * Informational only — checks never gate transitions.
   */
  checks?: Record<string, ActionCheck>;
  /** Declared-var values for this binding (incl. kind-derived companions). */
  vars?: Record<string, string>;
  /**
   * Random per-binding secret every output marker must carry. Handed only to
   * what the workflow launches (env + prompt var); minted on bind.
   */
  token?: string;
}

/** Entry mirrored to appState.instances — the kanban board's read model. */
export interface WorkflowInstance {
  workflow: string;
  state: string;
  sessionName?: string;
  cwd?: string;
  updatedAt: number;
  /** Copy of the binding's vars so closed-session cards keep showing them. */
  vars?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Settings parsing
// ---------------------------------------------------------------------------

/** Kebab→camel for one level of config keys (run-in → runIn etc.). */
function camelKeys(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    out[k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = v;
  }
  return out;
}

/** Kebab→camel for a single config key (`prompt-file` → `promptFile`). */
function camelKey(k: string): string {
  return k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Config keys that mark a `steps.<state>` value as a single anonymous action
 * rather than a map of named actions — their presence selects the flat form,
 * so action names must not collide with them.
 */
const ACTION_SPEC_KEYS = new Set(['agent', 'command', 'prompt', 'promptFile', 'runIn', 'auto']);

/**
 * Parse one action spec — a map (`{ agent, command, prompt, … }`) or a bare
 * string shorthand for `{ command: <string> }`. Returns undefined for
 * non-runnable specs (no `agent`/`command`): `state: {}` marks a human gate.
 */
function parseActionSpec(raw: unknown): Omit<WorkflowAction, 'name'> | undefined {
  const s = typeof raw === 'string' ? { command: raw } : camelKeys(raw);
  // `agent: <string>` is a persona reference; a map is an inline spec that
  // may still carry `profile` plus overrides.
  const agent = (
    typeof s.agent === 'string' ? { profile: s.agent } : camelKeys(s.agent)
  ) as WorkflowAgentSpec;
  const action: Omit<WorkflowAction, 'name'> = {
    runIn:
      s.runIn === 'sub-shell' || s.runIn === 'headless' || s.runIn === 'shell'
        ? s.runIn
        : undefined,
    agent: Object.keys(agent).length > 0 ? agent : undefined,
    auto: s.auto === true ? true : undefined,
    prompt: typeof s.prompt === 'string' ? s.prompt : undefined,
    promptFile: typeof s.promptFile === 'string' ? s.promptFile : undefined,
    command: typeof s.command === 'string' ? s.command : undefined,
    description: typeof s.description === 'string' ? s.description : undefined,
  };
  return action.agent || action.command ? action : undefined;
}

function varSpecOf(key: string, raw: unknown): WorkflowVarSpec {
  const s = camelKeys(raw);
  return {
    key: camelKey(key),
    label: typeof s.label === 'string' ? s.label : undefined,
    hint: typeof s.hint === 'string' ? s.hint : undefined,
    required: s.required === true ? true : undefined,
    kind: s.kind === 'mr' ? 'mr' : undefined,
    when: s.kind === 'mr' ? parseMrCondition(s.when) : undefined,
  };
}

/**
 * `when: { role: reviewer }` / `{ role: [author, other] }`. Unknown roles
 * are dropped; a `role` that lists none at all matches nothing, so a typo
 * hides the button instead of silently widening it to every MR.
 */
export function parseMrCondition(raw: unknown): MrCondition | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (r.role === undefined) return undefined;
  const list = (Array.isArray(r.role) ? r.role : [r.role]).map((v) => String(v).trim().toLowerCase());
  return { role: MR_ROLES.filter((role) => list.includes(role)) };
}

/** Whether an MR with `role` (undefined = not known) meets `when`. */
export function mrConditionMet(when: MrCondition | undefined, role: MrRole | undefined): boolean {
  if (!when?.role) return true;
  return role !== undefined && when.role.includes(role);
}

/** The var an MR fills: the workflow's first `kind: mr` var. */
export function mrVarOf(def: WorkflowDef): WorkflowVarSpec | undefined {
  return def.vars?.find((v) => v.kind === 'mr');
}

/**
 * Parse `workflows.<id>.vars` — a map (`vars: { mr: { kind: mr, … } }`,
 * a bare string value is shorthand for `{ label }`) or a list of
 * `{ key, … }` entries. Keys are camelized (`mr-url` → `mrUrl`) so the
 * same key works in `{{templates}}`, `key=value` args and env names.
 */
export function parseWorkflowVars(raw: unknown): WorkflowVarSpec[] {
  const out: WorkflowVarSpec[] = [];
  if (Array.isArray(raw)) {
    for (const v of raw) {
      const s = camelKeys(v);
      if (typeof s.key === 'string' && s.key) out.push(varSpecOf(s.key, s));
    }
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      out.push(varSpecOf(k, typeof v === 'string' ? { label: v } : v));
    }
  }
  return out;
}

/**
 * Read `workflows` from the plugin's settings section. Invalid entries
 * (missing/empty `states`) are skipped. Config keys are camelized one level
 * at a time — `transitions`/`steps` map keys are state names like
 * `plan-review` and must NOT be camelized.
 */
export function parseWorkflows(settings: unknown): WorkflowDef[] {
  const raw = (settings as Record<string, unknown> | undefined)?.workflows;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const defs: WorkflowDef[] = [];
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    const w = camelKeys(v);
    const states = Array.isArray(w.states)
      ? (w.states as unknown[]).filter((s): s is string => typeof s === 'string' && s.length > 0)
      : [];
    if (states.length === 0) continue;
    const tracking = camelKeys(w.tracking);
    const trackingFile =
      typeof tracking.file === 'string' && tracking.file ? tracking.file : undefined;
    const transitions: Record<string, string[]> = {};
    const transitionsRaw = (w.transitions ?? {}) as Record<string, unknown>;
    for (const [from, to] of Object.entries(transitionsRaw)) {
      transitions[from] = Array.isArray(to)
        ? (to as unknown[]).filter((s): s is string => typeof s === 'string')
        : [];
    }
    const steps: WorkflowDef['steps'] = {};
    const descriptions: Record<string, string> = {};
    const stepsRaw = (w.steps ?? {}) as Record<string, unknown>;
    for (const [state, sv] of Object.entries(stepsRaw)) {
      // A step value carrying action-spec keys is one anonymous action;
      // anything else is a map of named actions (keys stay verbatim —
      // kebab-case action names like `dry-check` must not be camelized).
      const isSingle =
        typeof sv === 'string' ||
        (!!sv &&
          typeof sv === 'object' &&
          !Array.isArray(sv) &&
          Object.keys(sv).some((k) => ACTION_SPEC_KEYS.has(camelKey(k))));
      const actions: WorkflowAction[] = [];
      if (isSingle) {
        const a = parseActionSpec(sv);
        if (a) {
          actions.push({ name: ANONYMOUS_ACTION, ...a });
          if (a.description) descriptions[state] = a.description;
        }
      } else if (sv && typeof sv === 'object' && !Array.isArray(sv)) {
        for (const [name, av] of Object.entries(sv as Record<string, unknown>)) {
          // `description` is reserved: it describes the state itself, so a
          // bare-string value never parses as a command action of that name.
          if (name === 'description') {
            if (typeof av === 'string' && av) descriptions[state] = av;
            continue;
          }
          const a = parseActionSpec(av);
          if (a) actions.push({ name, ...a });
        }
      }
      if (actions.length > 0) steps[state] = actions;
    }
    defs.push({
      id,
      title: typeof w.title === 'string' && w.title ? w.title : id,
      trackingFile,
      // the file extension picks the encoding — .json → json, else yaml
      trackingFormat: trackingFile?.endsWith('.json') ? 'json' : 'yaml',
      states,
      start: typeof w.start === 'string' && states.includes(w.start) ? w.start : states[0],
      vars: (() => {
        const vars = parseWorkflowVars(w.vars);
        return vars.length > 0 ? vars : undefined;
      })(),
      transitions: Object.keys(transitions).length > 0 ? transitions : undefined,
      tickets: parseWorkflowTickets(w.tickets, states),
      steps,
      descriptions: Object.keys(descriptions).length > 0 ? descriptions : undefined,
    });
  }
  return defs;
}

/**
 * `tickets: { source?, var?, status-map: { <status>: <state> } }`. Status
 * names stay verbatim (matched case-insensitively); entries naming an
 * unknown state are dropped. An empty map still links the workflow — the
 * status category then decides (see `ticketRange`).
 */
export function parseWorkflowTickets(raw: unknown, states: string[]): WorkflowTickets | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = camelKeys(raw);
  const statusMap: Record<string, string> = {};
  const map = r.statusMap;
  if (map && typeof map === 'object' && !Array.isArray(map)) {
    for (const [status, state] of Object.entries(map as Record<string, unknown>)) {
      if (typeof state === 'string' && states.includes(state)) {
        statusMap[status.trim().toLowerCase()] = state;
      }
    }
  }
  return {
    source: typeof r.source === 'string' && r.source ? r.source : 'jira',
    var: typeof r.var === 'string' && r.var ? r.var : 'ticket',
    statusMap,
    query: typeof r.query === 'string' && r.query.trim() ? r.query.trim() : undefined,
  };
}

export interface TicketRange {
  /** The state a ticket in this status enters at. */
  entry: string;
  /** Every state the status covers, in workflow order. */
  states: string[];
}

/**
 * The workflow states a ticket status covers. An explicitly mapped status
 * covers its entry state up to (not including) the next mapped entry state;
 * statuses sharing an entry share the range. Unmapped statuses fall back to
 * the status category: `new` → the start state, `done` → the last state,
 * `indeterminate` → everything in between. Undefined when nothing applies.
 */
export function ticketRange(
  def: WorkflowDef,
  status: string | undefined,
  category: string | undefined,
): TicketRange | undefined {
  const tickets = def.tickets;
  if (!tickets) return undefined;
  const states = def.states;
  const entry = status ? tickets.statusMap[status.trim().toLowerCase()] : undefined;
  if (entry) {
    const from = states.indexOf(entry);
    const entries = new Set(Object.values(tickets.statusMap).map((s) => states.indexOf(s)));
    let to = states.length;
    for (const i of entries) if (i > from && i < to) to = i;
    return { entry, states: states.slice(from, to) };
  }
  const start = states.indexOf(def.start);
  const last = states.length - 1;
  switch (category) {
    case 'new':
      return { entry: def.start, states: [def.start] };
    case 'done':
      return { entry: states[last], states: [states[last]] };
    case 'indeterminate':
      return start + 1 < last
        ? { entry: states[start + 1], states: states.slice(start + 1, last) }
        : undefined;
    default:
      return undefined;
  }
}

/**
 * A message when the session's state lies outside what the ticket's status
 * covers — shown as a badge, never acted on (two writers would ping-pong).
 */
export function ticketDrift(
  def: WorkflowDef,
  state: string,
  status: string | undefined,
  category: string | undefined,
): string | undefined {
  const range = ticketRange(def, status, category);
  if (!range || range.states.includes(state)) return undefined;
  const span =
    range.states.length > 1
      ? `${range.states[0]}…${range.states[range.states.length - 1]}`
      : range.states[0];
  return `Ticket is '${status ?? category}' — that covers ${span}, the session is in ${state}`;
}

function workflowsOf(ctx: Ctx): WorkflowDef[] {
  return parseWorkflows(ctx.pluginSettings);
}

/**
 * The plugin's slice of session pluginState. Prefer the live session object
 * (`getSession()` returns the latest state) over `ctx.pluginState`, which is
 * a snapshot from when the ctx was built — async continuations (headless
 * exec callbacks, sub-shell exit events) would otherwise read and clobber
 * fresh `checks` entries.
 */
function bindingSource(ctx: Ctx): BindingState | undefined {
  const live = (
    ctx.getSession().pluginState as Record<string, unknown> | undefined
  )?.['dev-workflow'];
  return (live ?? ctx.pluginState) as BindingState | undefined;
}

/**
 * Our own binding writes the host has not committed yet. The host applies
 * `updatePluginState` asynchronously (a React state update), so until the
 * session object changes, a read — the next output chunk, the affordance
 * refresh in the same chunk — would see the pre-write binding and could
 * write it back (undoing e.g. a marker move). Keyed by session; `base` is
 * the binding object the write was made against.
 */
const uncommitted = new Map<string, { base: BindingState | undefined; binding: BindingState }>();

function bindingOf(ctx: Ctx): BindingState {
  const source = bindingSource(ctx);
  const pending = uncommitted.get(ctx.session.id);
  if (pending && pending.base === source) return pending.binding;
  if (pending) uncommitted.delete(ctx.session.id);
  return source ?? {};
}

/** Write (part of) the binding and read it back until the host commits it. */
function writeBinding(ctx: Ctx, patch: BindingState): void {
  const base = bindingSource(ctx);
  const binding = { ...bindingOf(ctx), ...patch };
  ctx.updatePluginState(patch);
  uncommitted.set(ctx.session.id, { base, binding });
}

function checkKey(state: string, name: string): string {
  return `${state}:${name}`;
}

// ---------------------------------------------------------------------------
// State records — encode/decode + read/write against file or plugin store
// ---------------------------------------------------------------------------

export function encodeState(rec: WorkflowStateRecord, format: 'json' | 'yaml'): string {
  return format === 'json' ? `${JSON.stringify(rec, null, 2)}\n` : dumpYaml(rec);
}

/** Parse a state file's content — accepts json or yaml regardless of declared format. */
export function decodeState(text: string): WorkflowStateRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    try {
      parsed = loadYaml(text);
    } catch {
      return undefined;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const r = parsed as Record<string, unknown>;
  if (typeof r.workflow !== 'string' || typeof r.state !== 'string') return undefined;
  const history = Array.isArray(r.history)
    ? (r.history as unknown[])
        .filter(
          (h): h is { state: string; at: number } =>
            !!h && typeof h === 'object' && typeof (h as { state?: unknown }).state === 'string',
        )
        .map((h) => ({ state: h.state, at: typeof h.at === 'number' ? h.at : 0 }))
    : [];
  return {
    workflow: r.workflow,
    state: r.state,
    updated: typeof r.updated === 'number' ? r.updated : 0,
    history,
  };
}

/**
 * The base directory for repo-relative workflow files: the git toplevel when
 * the session sits in a repo, its live cwd otherwise.
 */
async function trackingBase(ctx: Ctx): Promise<string | undefined> {
  const cwd = (await ctx.getCwd().catch(() => null)) ?? ctx.getSession().cwd;
  if (!cwd) return undefined;
  try {
    const top = (await ctx.exec('git rev-parse --show-toplevel', cwd)).trim();
    return top || cwd;
  } catch {
    return cwd;
  }
}

async function stateFilePath(ctx: Ctx, def: WorkflowDef): Promise<string | undefined> {
  if (!def.trackingFile) return undefined;
  if (def.trackingFile.startsWith('/')) return def.trackingFile;
  const base = await trackingBase(ctx);
  return base ? `${base.replace(/\/+$/, '')}/${def.trackingFile}` : undefined;
}

interface ReadResult {
  record?: WorkflowStateRecord;
  /** File exists but could not be decoded / holds the wrong workflow. */
  invalid?: boolean;
}

/**
 * Read the tracked record. With `tracking.file` the file is authoritative
 * (agents may have moved it); without one the session's own pluginState is
 * the record. The session record itself only ever holds a valid state, so
 * `invalid` can only come from a file.
 */
async function readRecord(ctx: Ctx, def: WorkflowDef): Promise<ReadResult> {
  const path = await stateFilePath(ctx, def);
  if (!path) {
    const b = bindingOf(ctx);
    if (b.workflow !== def.id || !b.state) return {};
    return {
      record: {
        workflow: b.workflow,
        state: b.state,
        updated: b.updated ?? 0,
        history: b.history ?? [],
      },
    };
  }
  let text: string;
  try {
    text = await ctx.readFile(path);
  } catch {
    return {};
  }
  const record = decodeState(text);
  if (!record || record.workflow !== def.id) return { invalid: !record };
  return { record };
}

/**
 * Mirror a record to the tracking file (when configured). The session's
 * pluginState is written by showState — every record flows through it.
 */
async function writeRecord(
  ctx: Ctx,
  def: WorkflowDef,
  rec: WorkflowStateRecord,
): Promise<void> {
  const path = await stateFilePath(ctx, def);
  if (!path) return;
  // fs-write doesn't create missing directories.
  const dir = path.slice(0, path.lastIndexOf('/'));
  if (dir) await ctx.mkdir(dir);
  await ctx.writeFile(path, encodeState(rec, def.trackingFormat));
}

// ---------------------------------------------------------------------------
// Binding + mirrors
// ---------------------------------------------------------------------------

function mirrorInstance(ctx: Ctx, def: WorkflowDef, rec: WorkflowStateRecord): void {
  const instances = {
    ...(((ctx.appState as { instances?: Record<string, WorkflowInstance> } | undefined)
      ?.instances) ?? {}),
  };
  const session = ctx.getSession();
  instances[session.id] = {
    workflow: def.id,
    state: rec.state,
    sessionName: session.name,
    cwd: session.cwd,
    updatedAt: rec.updated,
    vars: bindingOf(ctx).vars,
  };
  ctx.updateAppState({ instances });
}

function unmirrorInstance(ctx: Ctx): void {
  const instances = {
    ...(((ctx.appState as { instances?: Record<string, WorkflowInstance> } | undefined)
      ?.instances) ?? {}),
  };
  delete instances[ctx.session.id];
  ctx.updateAppState({ instances });
}

/** Compact status glyph appended to a check action's label. */
function checkBadge(check: ActionCheck | undefined): string {
  switch (check?.status) {
    case 'running':
      return ' …';
    case 'ok':
      return ' ✓';
    case 'failed':
      return ' ✗';
    case 'done':
      return ' •';
    default:
      return '';
  }
}

function checkTip(check: ActionCheck): string {
  const rc = check.rc != null ? `exit ${check.rc}` : 'exit code unavailable';
  const detail = check.message ? ` — ${check.message.split('\n')[0]}` : '';
  return check.status === 'running' ? 'running…' : `${rc}${detail}`;
}

/**
 * Render the bound state into pluginState + banner. `freshEntry` marks an
 * actual transition into `rec.state` — the state's previous check results
 * are stale (the work changed since) and get discarded.
 */
function showState(
  ctx: Ctx,
  def: WorkflowDef,
  rec: WorkflowStateRecord,
  opts?: { freshEntry?: boolean },
): void {
  const bound = bindingOf(ctx);
  const patch: BindingState = {
    workflow: def.id,
    state: rec.state,
    updated: rec.updated,
    history: rec.history,
    // a (re)bind to another workflow gets a fresh token — markers aimed at
    // the old binding stop counting
    token: bound.workflow === def.id && bound.token ? bound.token : newWorkflowToken(),
  };
  if (opts?.freshEntry) {
    const prefix = `${rec.state}:`;
    patch.checks = Object.fromEntries(
      Object.entries(bindingOf(ctx).checks ?? {}).filter(([k]) => !k.startsWith(prefix)),
    );
  }
  writeBinding(ctx, patch);
  const idx = def.states.indexOf(rec.state);
  const prev = idx > 0 ? def.states[idx - 1] : undefined;
  const next = idx >= 0 && idx < def.states.length - 1 ? def.states[idx + 1] : undefined;
  const prevOk = prev !== undefined && transitionAllowed(def, rec.state, prev);
  const nextOk = next !== undefined && transitionAllowed(def, rec.state, next);
  const actions = def.steps[rec.state] ?? [];
  // on freshEntry the just-filtered patch is the truth — the ctx snapshot may
  // still carry the discarded results
  const checks = patch.checks ?? bindingOf(ctx).checks ?? {};
  const proc = ctx.getSession().process;
  lastRunKey.set(ctx.session.id, affordanceKey(ctx, def, rec.state, checks));
  ctx.setBanner({
    level: 'info',
    message: `${def.title} · ${rec.state}`,
    // what this state is for — lighter text, ellipsized, full text on hover
    detail: def.descriptions?.[rec.state],
    // stays while the session is bound — only axn-workflow stop clears it
    dismissible: false,
    // chevrons lead the state name so its length doesn't shift them;
    // edge/disallowed moves render disabled instead of disappearing
    actions: [
      {
        id: 'prev',
        icon: 'chevron-left' as const,
        title: prevOk ? `move to ${prev}` : 'no previous state',
        disabled: !prevOk,
      },
      {
        id: 'next',
        icon: 'chevron-right' as const,
        title: nextOk ? `move to ${next}` : 'no next state',
        disabled: !nextOk,
      },
    ],
    trailingActions: actions.length
      ? actions.map((action) => {
          const info = actionRunInfo(action, proc, rec.state);
          const check = checks[checkKey(rec.state, action.name)];
          return {
            id: `run:${action.name}`,
            icon: 'play' as const,
            label: `${info.label}${checkBadge(check)}`,
            title: check ? `${info.tip} — last run: ${checkTip(check)}` : info.tip,
            disabled: info.kind === 'blocked',
          };
        })
      : undefined,
  });
  mirrorInstance(ctx, def, rec);
}

/** Re-render the banner without touching the state — e.g. a check result landed. */
function refreshBanner(ctx: Ctx, def: WorkflowDef): void {
  const bound = bindingOf(ctx);
  if (!bound.state) return;
  showState(ctx, def, {
    workflow: def.id,
    state: bound.state,
    updated: bound.updated ?? Date.now(),
    history: bound.history ?? [],
  });
}

/**
 * Persist a command action's result and refresh the banner badge. Reads the
 * live binding so two checks resolving back-to-back can't clobber each other.
 */
function recordCheck(
  ctx: Ctx,
  def: WorkflowDef,
  state: string,
  name: string,
  check: ActionCheck,
): void {
  const checks = { ...(bindingOf(ctx).checks ?? {}) };
  checks[checkKey(state, name)] = check;
  writeBinding(ctx, { checks });
  refreshBanner(ctx, def);
}

/**
 * Persist one workflow var (a `kind: mr` value expands into its `<key>_*`
 * companions via expandVars) and keep the kanban card's mirrored copy in
 * sync without a state transition.
 */
function setVar(ctx: Ctx, def: WorkflowDef, key: string, value: string): void {
  const vars = { ...(bindingOf(ctx).vars ?? {}), ...expandVars(def, { [key]: value }) };
  writeBinding(ctx, { vars });
  const instances = {
    ...(((ctx.appState as { instances?: Record<string, WorkflowInstance> } | undefined)
      ?.instances) ?? {}),
  };
  const inst = instances[ctx.session.id];
  if (inst) {
    instances[ctx.session.id] = { ...inst, vars };
    ctx.updateAppState({ instances });
  }
}

function clearBinding(ctx: Ctx): void {
  writeBinding(ctx, {
    workflow: undefined,
    state: undefined,
    updated: undefined,
    history: undefined,
    checks: undefined,
    vars: undefined,
    token: undefined,
  });
  ctx.setBanner(null);
  ctx.setAttention(null);
  unmirrorInstance(ctx);
  lastRunKey.delete(ctx.session.id);
}

// ---------------------------------------------------------------------------
// Step launch
// ---------------------------------------------------------------------------

/**
 * Render the agent launch command for a step's `agent` spec. `extraFlags`
 * slots cli-specific flags (an agent launcher's instructions channel)
 * between `args` and the prompt.
 */
export function agentCommand(
  cli: string,
  spec: WorkflowAgentSpec,
  prompt?: string,
  extraFlags?: string,
): string {
  const model = spec.model ? ` --model ${shellWord(spec.model)}` : '';
  const args = spec.args ? ` ${spec.args}` : '';
  const extra = extraFlags ?? '';
  const p = prompt ? promptArg(prompt) : undefined;
  switch (cli) {
    case 'devin':
      // `devin --model X <args> -- "<prompt>"` — `--` keeps the prompt from
      // being parsed as a subcommand.
      return `devin${model}${args}${extra}${p ? ` -- ${p}` : ''}`;
    case 'claude':
      return `claude${model}${args}${extra}${p ? ` ${p}` : ''}`;
    default:
      return `${cli}${model}${args}${extra}${p ? ` -- ${p}` : ''}`;
  }
}

/**
 * Build an agent's launch line through its registered launcher — each agent
 * plugin owns its CLI's semantics (`registerAgentLauncher`: claude appends
 * system-prompt flags, codex inlines a config override, agy sends the
 * prompt via `-i`). Unregistered CLIs get the generic line with `instructions`
 * folded into the seed prompt. A launcher may throw a user-facing refusal
 * — callers surface it as attention.
 */
export async function agentLaunchLine(
  cli: string,
  spec: WorkflowAgentSpec,
  prompt: string | undefined,
  tools: AgentLaunchTools,
  cwd: string,
): Promise<string> {
  const launcher = agentLauncherFor(cli);
  if (launcher) return launcher(spec, prompt, tools, cwd);
  const inst =
    spec.instructions ??
    (spec.instructionsFile
      ? await tools.readFile(spec.instructionsFile, cwd).catch(() => undefined)
      : undefined);
  return agentCommand(cli, spec, inst ? inst + (prompt ? `\n\n${prompt}` : '') : prompt);
}

/**
 * Substitute {{placeholder}}s in a `command:` step template for the shell.
 * Values come from places an attacker can reach — MR titles/branches, the
 * `axn-workflow-var[<token>]:` output marker, card fields — so each one goes
 * in as a single shell word (`shellWord`: plain values stay bare, anything
 * else is single-quoted), never as raw shell text. The template is scanned
 * for its quoting so the word works wherever the placeholder sits: inside
 * "…" or '…' the string is closed around it (`"fix: "'v'""`), and a
 * placeholder that is the whole quoted string (`"{{x}}"`) just replaces it.
 * Inside a comment it goes in on one line; in places a word cannot be
 * spliced safely (backticks, `${…}`, `$((…))`, `$'…'`, heredocs) rendering
 * throws. `rawKeys` (the base64 `{{prompt}}` word from promptArg) are
 * already safe shell words and get the same treatment without shellWord.
 */
export function renderCommandTemplate(
  template: string,
  vars: Record<string, string>,
  rawKeys: readonly string[] = [],
): string {
  type Kind = 'plain' | 'cmd' | 'dq' | 'sq' | 'ansi' | 'bt' | 'param' | 'arith' | 'comment';
  // quoting context stack; `start` = index in `out` of the opening quote,
  // `depth` = open parens/braces for cmd/param/arith
  const stack: Array<{ kind: Kind; start: number; depth: number }> = [
    { kind: 'plain', start: -1, depth: 0 },
  ];
  const top = () => stack[stack.length - 1];
  const push = (kind: Kind, open: string, depth = 0) => {
    stack.push({ kind, start: out.length, depth });
    out += open;
  };
  const placeholder = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/y;
  let out = '';
  let heredoc: 'none' | 'pending' | 'body' = 'none';
  let i = 0;
  // `$((`, `$(` or `${` at i: open the frame and advance
  const openExpansion = (): boolean => {
    if (template.startsWith('$((', i)) {
      i += 3;
      push('arith', '$((', 2);
    } else if (template.startsWith('$(', i)) {
      i += 2;
      push('cmd', '$(', 1);
    } else if (template.startsWith('${', i)) {
      i += 2;
      push('param', '${');
    } else {
      return false;
    }
    return true;
  };
  while (i < template.length) {
    placeholder.lastIndex = i;
    const m = placeholder.exec(template);
    if (m) {
      i += m[0].length;
      const key = m[1];
      const value = vars[key];
      if (value === undefined) {
        out += m[0];
        continue;
      }
      const word = rawKeys.includes(key) ? value : shellWord(value);
      const f = top();
      if (heredoc === 'body' || !['plain', 'cmd', 'dq', 'sq', 'comment'].includes(f.kind)) {
        throw new Error(`{{${key}}} cannot be used inside ${heredoc === 'body' ? 'a heredoc' : CONTEXT_NAME[f.kind]}`);
      } else if (f.kind === 'comment') {
        out += value.replace(/[\r\n]+/g, ' ');
      } else if (f.kind === 'dq' || f.kind === 'sq') {
        const q = f.kind === 'dq' ? '"' : "'";
        if (f.start === out.length - 1 && template[i] === q) {
          // the placeholder is the whole quoted string: drop the quotes
          out = out.slice(0, -1) + word;
          stack.pop();
          i++;
        } else {
          out += q + word + q;
        }
      } else {
        out += word;
      }
      continue;
    }
    const c = template[i];
    const f = top();
    const two = template.slice(i, i + 2);
    switch (f.kind) {
      case 'sq':
        out += c;
        i++;
        if (c === "'") stack.pop();
        continue;
      case 'ansi':
      case 'bt':
        if (c === '\\') {
          out += two;
          i += 2;
          continue;
        }
        out += c;
        i++;
        if (c === (f.kind === 'bt' ? '`' : "'")) stack.pop();
        continue;
      case 'comment':
        if (c === '\n') {
          stack.pop();
          continue;
        }
        out += c;
        i++;
        continue;
      case 'arith':
        out += c;
        i++;
        if (c === '(') f.depth++;
        else if (c === ')' && --f.depth === 0) stack.pop();
        continue;
      case 'dq':
        if (c === '\\') {
          const n = /^[$`"\\\n]$/.test(template[i + 1] ?? '') ? 2 : 1;
          out += template.slice(i, i + n);
          i += n;
        } else if (c === '"') {
          out += c;
          i++;
          stack.pop();
        } else if (c === '`') {
          i++;
          push('bt', c);
        } else if (c === '$' && openExpansion()) {
          // handled
        } else {
          out += c;
          i++;
        }
        continue;
      default: {
        // plain, cmd, param: unquoted shell text
        if (c === '\\') {
          out += two;
          i += 2;
        } else if (c === "'") {
          i++;
          push('sq', c);
        } else if (c === '"') {
          i++;
          push('dq', c);
        } else if (c === '`') {
          i++;
          push('bt', c);
        } else if (two === "$'") {
          i += 2;
          push('ansi', two);
        } else if (c === '$' && openExpansion()) {
          // handled
        } else if (c === '#' && f.kind !== 'param' && /^$|[\s;&|()<>]$/.test(template[i - 1] ?? '')) {
          i++;
          push('comment', c);
        } else {
          if (f.kind === 'cmd' && c === '(') f.depth++;
          else if (f.kind === 'cmd' && c === ')' && --f.depth === 0) stack.pop();
          else if (f.kind === 'param' && c === '}') stack.pop();
          if (heredoc === 'none' && f.kind !== 'param' && two === '<<' && template[i + 2] !== '<' && template[i - 1] !== '<') {
            heredoc = 'pending';
          } else if (heredoc === 'pending' && c === '\n') {
            heredoc = 'body';
          }
          out += c;
          i++;
        }
      }
    }
  }
  return out;
}

const CONTEXT_NAME: Record<string, string> = {
  ansi: "$'…'",
  bt: 'backticks',
  param: '${…}',
  arith: '$((…))',
};

/** Substitute {{placeholder}}s in prompt text (no shell involved). */
export function renderTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(
    /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g,
    (m, key: string) => vars[key] ?? m,
  );
}

/**
 * A merge/pull-request reference parsed from a var value — a GitLab MR url
 * (`…/group/proj/-/merge_requests/123`), a GitHub PR url (`…/pull/45`) or a
 * bare `!123`/`#45`/`group/proj!123`.
 */
export interface MrParsedRef {
  iid: string;
  url?: string;
  project?: string;
  host?: string;
  /** git fetch ref for the head commit (`merge-requests/N/head`, `pull/N/head`). */
  fetchRef?: string;
  /** The sigil of a bare ref: `!` (GitLab MR) or `#` (GitHub PR). */
  sigil?: '!' | '#';
}

export function parseMrRef(value: string): MrParsedRef | undefined {
  const v = value.trim();
  const glab = /^https?:\/\/([^/\s]+)\/(.+?)\/-\/merge_requests\/(\d+)/.exec(v);
  if (glab) {
    return {
      iid: glab[3],
      url: v,
      project: glab[2],
      host: glab[1],
      fetchRef: `merge-requests/${glab[3]}/head`,
    };
  }
  const gh = /^https?:\/\/([^/\s]+)\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/.exec(v);
  if (gh) {
    return { iid: gh[3], url: v, project: gh[2], host: gh[1], fetchRef: `pull/${gh[3]}/head` };
  }
  const bare = /^(?:([\w./~-]+)\s*)?([!#])(\d+)$/.exec(v);
  if (bare) return { iid: bare[3], project: bare[1], sigil: bare[2] as '!' | '#' };
  return undefined;
}

/**
 * The head ref to fetch for a review: what the URL names; for a bare ref
 * `#N` is a GitHub PR (`pull/N/head`) and `!N` a GitLab MR, except that a
 * `!N` typed in a GitHub checkout can only mean its PR.
 */
export function reviewFetchRef(
  ref: MrParsedRef | undefined,
  iid: number,
  remote: string | undefined,
): string {
  if (ref?.fetchRef) return ref.fetchRef;
  const github = ref?.sigil === '#' || forgeOfRemote(remote) === 'github';
  return github ? `pull/${iid}/head` : `merge-requests/${iid}/head`;
}

/**
 * Expand supplied var values: the raw value plus, for `kind: mr` vars, the
 * parsed companions (`<key>_iid`, `<key>_url`, `<key>_project`,
 * `<key>_host`). `extra` merges verbatim (used by the MR action for
 * `<key>_title`/`<key>_branch`/`worktree`).
 */
export function expandVars(
  def: WorkflowDef,
  vars: Record<string, string>,
  extra?: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) {
    const key = camelKey(k);
    out[key] = v;
    const spec = def.vars?.find((s) => s.key === key);
    if (spec?.kind === 'mr') {
      const ref = parseMrRef(v);
      if (ref?.iid) out[`${key}_iid`] = ref.iid;
      if (ref?.url) out[`${key}_url`] = ref.url;
      if (ref?.project) out[`${key}_project`] = ref.project;
      if (ref?.host) out[`${key}_host`] = ref.host;
    }
  }
  return { ...out, ...extra };
}

/** Var key → environment variable name (`mrUrl` → `MR_URL`, `mr-url` → `MR_URL`). */
export function envName(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .replace(/[^A-Za-z0-9_]/g, '')
    .toUpperCase();
}

/**
 * `KEY='value' ` env prefix for a launched command — workflow vars ride the
 * shell env, so `command:` scripts read `$MR` and agent processes pass the
 * vars down to anything they spawn. `AXN_WORKFLOW`/`AXN_STATE`/`AXN_ACTION`
 * join in, namespaced.
 */
export function envPrefix(vars: Record<string, string>): string {
  return Object.entries(vars)
    .filter(([k]) => envName(k))
    .map(([k, v]) => `${envName(k)}=${shellWord(v)} `)
    .join('');
}

function actionEnv(ctx: Ctx, def: WorkflowDef, action: WorkflowAction, state: string): string {
  return envPrefix({
    ...(bindingOf(ctx).vars ?? {}),
    // namespaced built-ins always win — a user var can't spoof them
    axn_workflow: def.id,
    axn_state: state,
    axn_action: action.name,
    axn_workflow_token: bindingOf(ctx).token ?? '',
  });
}

async function actionVars(
  ctx: Ctx,
  def: WorkflowDef,
  action: WorkflowAction,
  state: string,
): Promise<Record<string, string>> {
  const cwd = (await ctx.getCwd().catch(() => null)) ?? ctx.getSession().cwd ?? '';
  return {
    // user vars first — built-ins win name collisions
    ...(bindingOf(ctx).vars ?? {}),
    state,
    workflow: def.id,
    action: action.name,
    workflow_token: bindingOf(ctx).token ?? '',
    cwd,
    tracking: (await stateFilePath(ctx, def)) ?? '',
    model: resolveAgentSpec(action.agent).model ?? '',
    promptFile: actionPromptSource(action).promptFile
      ? `${(await trackingBase(ctx))?.replace(/\/+$/, '') ?? ''}/${actionPromptSource(action).promptFile}`
      : '',
  };
}

/** Compact display for a var value — MR/PR urls collapse to `!N`/`#N` chips. */
export function varChipFor(
  value: string,
): { label: string; href?: string; tip: string } | undefined {
  const v = value.trim();
  const ref = parseMrRef(v);
  if (ref?.iid) {
    const host = ref.host ? `${ref.host} ` : '';
    return {
      label: `${v.includes('/pull/') ? '#' : '!'}${ref.iid}`,
      href: ref.url,
      tip: ref.url ?? `${host}${v}`,
    };
  }
  if (/^https?:\/\/\S+$/.test(v)) {
    const bare = v.replace(/^https?:\/\//, '');
    const label = bare.length > 32 ? `${bare.slice(0, 16)}…${bare.slice(-12)}` : bare;
    return { label, href: v, tip: v };
  }
  return undefined;
}

export async function actionPrompt(
  ctx: Ctx,
  action: WorkflowAction,
  vars: Record<string, string>,
): Promise<string | undefined> {
  const src = actionPromptSource(action);
  const raw =
    src.prompt ??
    (src.promptFile
      ? await ctx.readFile(src.promptFile, await trackingBase(ctx)).catch(() => undefined)
      : undefined);
  return raw ? renderTemplate(raw, vars) : raw;
}

async function actionCommand(
  ctx: Ctx,
  def: WorkflowDef,
  action: WorkflowAction,
  state: string,
): Promise<string | undefined> {
  const vars = await actionVars(ctx, def, action, state);
  const prompt = await actionPrompt(ctx, action, vars);
  if (action.command) {
    return renderCommandTemplate(
      action.command,
      { ...vars, prompt: prompt ? promptArg(prompt) : '' },
      ['prompt'],
    );
  }
  if (action.agent) {
    const spec = resolveAgentSpec(action.agent);
    return agentLaunchLine(spec.cli ?? 'devin', spec, prompt, ctx, vars.cwd);
  }
  return undefined;
}

/**
 * The typed line for a `run-in: shell` action. Command actions get a
 * reporter trailer that captures the exit code and prints a whole-line
 * `axn-workflow-check[<token>]:` marker — the plugin's onOutput scans it back into
 * the checks record. The leading `\n` guarantees the marker starts a fresh
 * line even when the command's output lacked a trailing newline.
 */
export function shellLine(action: WorkflowAction, state: string, cmd: string, token: string): string {
  if (!action.command) return cmd;
  return `${cmd}; rc=$?; printf '\\naxn-workflow-check[%s]: %s:%s %d\\n' ${shellWord(token)} ${shellWord(state)} ${shellWord(action.name)} "$rc"`;
}

export interface ActionRunInfo {
  /** 'launch' types the command, 'prompt' injects into the running agent, 'blocked' refuses. */
  kind: 'launch' | 'prompt' | 'blocked';
  /** Tooltip text — the reason when blocked, the action description otherwise. */
  tip: string;
  label: string;
}

/**
 * Resolve an action's agent spec against the persona registry: `profile`
 * names an `agents.personas` entry, inline `cli`/`model`/`args` override
 * its values, and an unresolved profile falls back to `cli: <name>` so a
 * bare `agent: claude` keeps working with no personas configured.
 */
export function resolveAgentSpec(spec: WorkflowAgentSpec | undefined): WorkflowAgentSpec {
  if (!spec) return {};
  const persona = spec.profile ? resolvePersona(spec.profile) : undefined;
  return {
    cli: spec.cli ?? persona?.cli ?? spec.profile,
    model: spec.model ?? persona?.model,
    args: spec.args ?? persona?.args,
    instructions: spec.instructions ?? persona?.instructions,
    instructionsFile: spec.instructionsFile ?? persona?.instructionsFile,
    profile: spec.profile,
  };
}

/** The action's prompt fields with persona defaults applied underneath. */
function actionPromptSource(action: WorkflowAction): {
  prompt?: string;
  promptFile?: string;
} {
  const persona = action.agent?.profile ? resolvePersona(action.agent.profile) : undefined;
  return {
    prompt: action.prompt ?? persona?.prompt,
    promptFile: action.promptFile ?? persona?.promptFile,
  };
}

/**
 * Display label for an action — the name, or for the anonymous sugar form
 * `Run <agent>` (persona name, else cli) so several agent steps stay
 * distinguishable.
 */
export function actionLabel(action: WorkflowAction): string {
  if (action.name !== ANONYMOUS_ACTION) return action.name;
  if (!action.agent) return 'Run step';
  return `Run ${action.agent.profile ?? action.agent.cli ?? 'agent'}`;
}

/**
 * What the Run action would do for an action given the session's foreground
 * process. `sub-shell`/`headless` actions never touch the main PTY so they
 * are always launchable; `shell` actions need a free prompt — except when
 * the running process IS the action's agent, where the prompt can be handed
 * to it directly (queued as its next input). Anything else blocks the
 * button.
 */
export function actionRunInfo(
  action: WorkflowAction,
  process: string | undefined,
  state: string,
): ActionRunInfo {
  const label = actionLabel(action);
  // A declared step description leads the tooltip; the mechanics follow.
  const tip = (mechanics: string) =>
    action.description ? `${action.description}\n${mechanics}` : mechanics;
  if ((action.runIn ?? 'shell') !== 'shell' || !process) {
    return { kind: 'launch', label, tip: tip(`run '${action.name}' in state '${state}'`) };
  }
  const cli = action.agent
    ? (resolveAgentSpec(action.agent).cli ?? 'devin').toLowerCase()
    : undefined;
  if (cli && process.toLowerCase() === cli) {
    const src = actionPromptSource(action);
    if (!src.prompt && !src.promptFile) {
      return {
        kind: 'blocked',
        label,
        tip: tip(`'${process}' is running — '${action.name}' has no prompt to send`),
      };
    }
    return {
      kind: 'prompt',
      label,
      tip: tip(`send '${action.name}'s prompt to the running '${process}'`),
    };
  }
  return {
    kind: 'blocked',
    label,
    tip: tip(`'${process}' is running — stop it to run '${action.name}'`),
  };
}

/**
 * Key identifying the current banner Run affordances — per-action
 * eligibility plus check status. Compared in onOutput so a
 * foreground-process change or a landing check result re-renders the banner
 * without waiting for the next transition.
 */
function affordanceKey(ctx: Ctx, def: WorkflowDef, state: string, checks?: Record<string, ActionCheck>): string {
  const actions = def.steps[state] ?? [];
  if (actions.length === 0) return 'none';
  const checksMap = checks ?? bindingOf(ctx).checks ?? {};
  const proc = ctx.getSession().process;
  return actions
    .map(
      (a) =>
        `${a.name}:${actionRunInfo(a, proc, state).kind}:${checksMap[checkKey(state, a.name)]?.status ?? '-'}`,
    )
    .join('|');
}

/**
 * Sub-shell tabs running a command check — tab id → the check to record on
 * exit. Kept after the first exit so Enter re-runs keep updating the badge;
 * pruned with the session.
 */
const pendingChecks = new Map<string, { sessionId: string; state: string; name: string }>();

/**
 * Wrap `text` in bracketed-paste markers for an agent's input. ESC (and the
 * 8-bit CSI) are dropped from the text first: a prompt — possibly from a
 * repo's `promptFile` — carrying `ESC[201~` would otherwise end the paste
 * early and the rest would arrive as raw keystrokes.
 */
export function bracketedPaste(text: string): string {
  return `\x1b[200~${text.replace(/[\x1b\x9b]/g, '')}\x1b[201~`;
}

/**
 * Execute the Run action for one named action. `shell` actions type the
 * launch command at a free prompt; when the action's agent already owns the
 * terminal the prompt is injected via bracketed paste + CR (a busy agent
 * queues it, an idle one runs it immediately). A foreign foreground process
 * refuses — the button is disabled in the UI, this is the click-path guard.
 * `sub-shell`/`headless` dispatch regardless. Never interrupts a running
 * process. Command actions record a `running` check first and resolve it to
 * ok/failed via the exit-code channel for their run-in (output marker for
 * shell, exec result for headless, subshell-exited for sub-shell).
 */
async function runAction(
  ctx: Ctx,
  def: WorkflowDef,
  state: string,
  action: WorkflowAction,
): Promise<void> {
  const mode = action.runIn ?? 'shell';
  // A launcher's refusal (an unreadable instructions file) throws —
  // surface it on the session instead of
  // failing silently behind a spinner.
  const cmd = await actionCommand(ctx, def, action, state).catch((e) => {
    const msg = String(e instanceof Error ? e.message : e).split('\n')[0].slice(0, 300);
    ctx.setAttention({ level: 'warning', message: msg });
    axnLog('warn', 'dev-workflow', `action '${action.name}' could not build its command: ${msg}`);
    return undefined;
  });
  if (!cmd) return;
  const cwd = (await ctx.getCwd().catch(() => null)) ?? ctx.getSession().cwd;
  // workflow vars ride the process env: `MR=… axn_state=… <cmd>` — applies to
  // the launched command only (`A=1 cmd; trailer` binds to `cmd`)
  const env = actionEnv(ctx, def, action, state);
  if (mode === 'sub-shell') {
    // Command checks run one-shot so the tab's exit code IS the check result
    // (no `exec $SHELL -l` continuation); agent runs keep the shell after the
    // seed exits, and `agent` marks the tab so re-spawns resume the agent.
    const seed = action.command ? `${env}${cmd}` : `${env}${cmd}; exec "\${SHELL:-sh}" -l`;
    // Resolve the persona so `agent: <profile>` marks the tab too —
    // resumable agent CLIs only (`normalizeReviewAgent`).
    const agent = action.agent
      ? (normalizeReviewAgent(resolveAgentSpec(action.agent).cli) ?? undefined)
      : undefined;
    const label =
      action.name === ANONYMOUS_ACTION ? `${def.id}:${state}` : `${def.id}:${action.name}`;
    const tabId = ctx.openSubShell(seed, cwd, label, agent);
    if (action.command) {
      if (tabId) {
        pendingChecks.set(tabId, { sessionId: ctx.session.id, state, name: action.name });
        recordCheck(ctx, def, state, action.name, { status: 'running', at: Date.now() });
      } else {
        recordCheck(ctx, def, state, action.name, {
          status: 'failed',
          at: Date.now(),
          message: 'could not open sub-shell',
        });
      }
    }
    return;
  }
  if (mode === 'headless') {
    if (action.command) {
      recordCheck(ctx, def, state, action.name, { status: 'running', at: Date.now() });
    }
    void ctx
      .exec(`${env}${cmd}`, cwd)
      .then(() => {
        if (action.command) {
          recordCheck(ctx, def, state, action.name, { status: 'ok', rc: 0, at: Date.now() });
        }
      })
      .catch((e) => {
        if (action.command) {
          recordCheck(ctx, def, state, action.name, {
            status: 'failed',
            at: Date.now(),
            message: String(e).split('\n')[0].slice(0, 300),
          });
        }
        axnLog('warn', 'dev-workflow', `headless action '${action.name}' failed: ${String(e)}`);
      });
    return;
  }
  // `axn-*` commands are pure command-line dispatch — they never type into
  // the PTY, so the foreign-process/free-prompt gate doesn't apply to them
  // (and `session.process` can transiently report the shell itself during
  // startup — `run 'x' refused: 'zsh' is running`).
  const isAxn = /^\s*axn-\S*(?:\s|$)/.test(cmd);
  const process = ctx.getSession().process;
  const info = actionRunInfo(action, process, state);
  if (!isAxn && info.kind === 'blocked') {
    axnLog('warn', 'dev-workflow', `run '${action.name}' refused: ${info.tip}`);
    return;
  }
  if (!isAxn && info.kind === 'prompt') {
    const prompt = await actionPrompt(ctx, action, await actionVars(ctx, def, action, state));
    if (!prompt) {
      axnLog('warn', 'dev-workflow', `run '${action.name}': no prompt to send to '${process}'`);
      return;
    }
    await ctx.writeToSession(`${bracketedPaste(prompt)}\r`).catch(() => {});
    return;
  }
  try {
    // `axn-*` hidden/plugin commands are intercepted at the input line, so a
    // raw `writeToSession` would deliver them to the shell verbatim
    // (`axn-git` → `command not found`). Dispatch them the way a typed line
    // is handled instead: a string result is a replacement shell command
    // (runs with the check trailer for a real rc), `false` was fully
    // handled, `undefined` falls through to the shell as-is.
    let line = cmd;
    if (isAxn && ctx.runCommand) {
      const resolved = await ctx.runCommand(cmd.trim());
      if (resolved === false) {
        if (action.command) {
          recordCheck(ctx, def, state, action.name, { status: 'done', at: Date.now() });
        }
        return;
      }
      if (typeof resolved === 'string') line = resolved;
    }
    await ctx.writeToSession(`${env}${shellLine(action, state, line, bindingOf(ctx).token ?? '')}\r`);
    if (action.command) {
      recordCheck(ctx, def, state, action.name, { status: 'running', at: Date.now() });
    }
  } catch {
    // backend write failed — no marker will arrive either
  }
}

/** Resolve an action of `state` by name; `undefined` arg picks the sole action. */
function findAction(
  def: WorkflowDef,
  state: string,
  name: string | undefined,
): WorkflowAction | undefined {
  const actions = def.steps[state] ?? [];
  if (name === undefined || name === '') return actions.length === 1 ? actions[0] : undefined;
  return actions.find((a) => a.name === name);
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/**
 * Whether moving `from` → `to` is valid: `to` must be a declared state, and
 * when `transitions` is declared and lists the current state, `to` must be
 * in that list (a state absent from `transitions` allows any move).
 */
export function transitionAllowed(
  def: WorkflowDef,
  from: string | undefined,
  to: string,
): boolean {
  if (!def.states.includes(to)) return false;
  if (from && def.transitions?.[from] && !def.transitions[from].includes(to)) return false;
  return true;
}

interface TransitionResult {
  record?: WorkflowStateRecord;
  error?: string;
}

/**
 * Validate + persist a move to `target`, then update binding/banner/board
 * mirror and fire the entered state's `auto` actions ("on-enter" — command
 * steps re-run on every entry; agent steps too, so keep `auto` off them
 * unless a respawn-per-entry is really wanted). `waitForPrompt` delays the
 * actions until the session's first output — used by start paths where the
 * PTY may not have printed a prompt yet.
 */
async function transitionTo(
  ctx: Ctx,
  def: WorkflowDef,
  target: string,
  opts?: { waitForPrompt?: boolean },
): Promise<TransitionResult> {
  if (!def.states.includes(target)) {
    return { error: `unknown state '${target}' for workflow '${def.id}'` };
  }
  const from = bindingOf(ctx).state;
  if (target === from) {
    return { error: `already in state '${target}'` };
  }
  if (!transitionAllowed(def, from, target)) {
    return { error: `transition '${from}' → '${target}' not allowed by '${def.id}'` };
  }
  const now = Date.now();
  const existing = (await readRecord(ctx, def)).record;
  const rec: WorkflowStateRecord = {
    workflow: def.id,
    state: target,
    updated: now,
    history: [...(existing?.history ?? []), { state: target, at: now }],
  };
  try {
    await writeRecord(ctx, def, rec);
  } catch (e) {
    return { error: `could not write state: ${String(e)}` };
  }
  showState(ctx, def, rec, { freshEntry: true });
  axnLog('info', 'dev-workflow', `${ctx.session.id}: ${def.id} → ${target}`);
  runAutoActions(ctx, def, target, opts?.waitForPrompt === true);
  return { record: rec };
}

/**
 * Re-read the tracked state (file or store) and adopt it when it moved
 * externally — e.g. an agent wrote a new state into the repo file.
 * Invalid content flags the session instead of being applied.
 */
async function reconcile(ctx: Ctx): Promise<void> {
  const defs = workflowsOf(ctx);
  const bound = bindingOf(ctx);
  if (bound.workflow) {
    const def = defs.find((d) => d.id === bound.workflow);
    if (!def) {
      ctx.setAttention({ level: 'warning', message: `workflow '${bound.workflow}' not defined` });
      return;
    }
    const { record, invalid } = await readRecord(ctx, def);
    if (invalid) {
      ctx.setAttention({ level: 'warning', message: `invalid state file for '${def.id}'` });
      return;
    }
    ctx.setAttention(null);
    if (record && record.state !== bound.state) {
      if (def.states.includes(record.state)) showState(ctx, def, record, { freshEntry: true });
      else ctx.setAttention({ level: 'warning', message: `'${def.id}' file holds unknown state '${record.state}'` });
    }
    return;
  }
  // Unbound: adopt a state file that names a defined workflow.
  for (const def of defs) {
    if (!def.trackingFile) continue;
    const { record } = await readRecord(ctx, def);
    if (record?.workflow === def.id && def.states.includes(record.state)) {
      showState(ctx, def, record, { freshEntry: true });
      return;
    }
  }
}

const reconcileTimers = new Map<string, ReturnType<typeof setTimeout>>();
const RECONCILE_DELAY_MS = 800;

/**
 * Agent handoff without a tracking file: an agent prints a whole output line
 * `axn-workflow-state[<token>]: <state>` and the session adopts it — the file-free
 * equivalent of editing the state file. The whole-line anchor keeps prose
 * ("I will now emit axn-workflow-state[…]: impl") from triggering it; the
 * token keeps text that merely scrolls past (a hostile file being `cat`ed)
 * from triggering it. Like the
 * file channel, `transitions` does not gate this — interactive moves only.
 */
const STATE_MARKER = /^axn-workflow-state\[([A-Za-z0-9]+)\]:\s*([A-Za-z0-9_-]+)\s*$/;
/**
 * Check-result report: `axn-workflow-check[<token>]: <name> <rc>` or with an
 * explicit state `axn-workflow-check[<token>]: <state>:<name> <rc>` (shell-run actions emit
 * this form via their printf trailer so a check outliving a move still lands
 * under the right state). Agents may print the bare-name form to report a
 * check themselves — it resolves against the current state.
 */
const CHECK_MARKER =
  /^axn-workflow-check\[([A-Za-z0-9]+)\]:\s*([A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)?)\s+(-?\d+)\s*$/;
/**
 * Agent-triggered action launch: `axn-workflow-run[<token>]: <name>` runs the named
 * action of the current state — the agent-side counterpart of the Run
 * button. `sub-shell`/`headless` actions dispatch regardless of the
 * foreground process; `shell` actions follow the same rules as the button
 * (send-prompt to the running agent cli, refused under a foreign process).
 */
const RUN_MARKER = /^axn-workflow-run\[([A-Za-z0-9]+)\]:\s*([A-Za-z0-9_-]+)\s*$/;
/**
 * Var write-back: `axn-workflow-var[<token>]: <key> <value>` lets a step or agent set
 * a workflow var from its output (e.g. a computed branch or verdict path).
 * `kind` derivation applies for declared vars; undeclared keys store
 * verbatim.
 */
const VAR_MARKER = /^axn-workflow-var\[([A-Za-z0-9]+)\]:\s*([A-Za-z0-9_-]+)\s+(.*)$/;
/** Any marker-shaped line, token or not — to log the ones that don't count. */
const ANY_MARKER = /^axn-workflow-(state|check|run|var)\b/;

/** 16 hex chars from the platform CSPRNG. */
export function newWorkflowToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Per-session leftover of an output chunk that split a marker mid-line. */
const markerTails = new Map<string, string>();

/**
 * Last Run-action affordance rendered into the banner per session —
 * per-action `kind` + check status. Compared in onOutput so a
 * foreground-process change (agent started/finished) re-renders the banner's
 * buttons enabled/disabled without waiting for the next transition.
 */
const lastRunKey = new Map<string, string>();

/** Re-render the banner when the foreground process flips Run eligibility. */
function refreshRunAffordance(ctx: Ctx, def: WorkflowDef): void {
  const bound = bindingOf(ctx);
  if (!bound.state) return;
  const key = affordanceKey(ctx, def, bound.state);
  if (lastRunKey.get(ctx.session.id) === key) return;
  showState(ctx, def, {
    workflow: def.id,
    state: bound.state,
    updated: bound.updated ?? Date.now(),
    history: bound.history ?? [],
  });
}

/** Run a marker-requested action, flagging the session when the run-in can't fire. */
async function markerRun(ctx: Ctx, def: WorkflowDef, name: string): Promise<void> {
  const bound = bindingOf(ctx);
  if (!bound.state) return;
  const action = findAction(def, bound.state, name);
  if (!action) {
    axnLog(
      'warn',
      'dev-workflow',
      `run marker: no action '${name}' in state '${bound.state}'`,
    );
    return;
  }
  const info = actionRunInfo(action, ctx.getSession().process, bound.state);
  if (info.kind === 'blocked') {
    ctx.setAttention({
      level: 'warning',
      message: `agent requested '${name}' — ${info.tip}`,
    });
    axnLog('warn', 'dev-workflow', `run marker '${name}' refused: ${info.tip}`);
    return;
  }
  await runAction(ctx, def, bound.state, action);
}

/**
 * A `axn-workflow-check[<token>]:` marker line. `key` is `<name>` (current state) or
 * `<state>:<name>` (explicit — the shell trailer's form).
 */
function recordCheckMarker(ctx: Ctx, def: WorkflowDef, key: string, rc: number): void {
  const colon = key.indexOf(':');
  const state = colon >= 0 ? key.slice(0, colon) : bindingOf(ctx).state;
  const name = colon >= 0 ? key.slice(colon + 1) : key;
  if (!state || !name) return;
  recordCheck(ctx, def, state, name, {
    status: rc === 0 ? 'ok' : 'failed',
    rc,
    at: Date.now(),
  });
}

/**
 * Scan output for the plugin's whole-line markers:
 * `axn-workflow-state[<token>]: <state>` (agent handoff — adopt the state),
 * `axn-workflow-check[<token>]: <name> <rc>` (check result report),
 * `axn-workflow-run[<token>]: <name>` (agent-requested action run) and
 * `axn-workflow-var[<token>]: <key> <value>`. Lines carrying no or another
 * binding's token are ignored.
 */
function scanMarkers(ctx: Ctx, def: WorkflowDef, text: string): boolean {
  const id = ctx.session.id;
  const lines = ((markerTails.get(id) ?? '') + text).split('\n');
  markerTails.set(id, lines.pop() ?? '');
  const token = bindingOf(ctx).token;
  for (const raw of lines) {
    const line = raw.trim();
    if (!ANY_MARKER.test(line)) continue;
    const marked = (m: RegExpExecArray | null) => (m && token && m[1] === token ? m : null);
    const sm = marked(STATE_MARKER.exec(line));
    if (sm) {
      const target = sm[2];
      if (!def.states.includes(target) || target === bindingOf(ctx).state) continue;
      const now = Date.now();
      const rec: WorkflowStateRecord = {
        workflow: def.id,
        state: target,
        updated: now,
        history: [...(bindingOf(ctx).history ?? []), { state: target, at: now }],
      };
      // mirror to tracking.file when configured — fire-and-forget
      void writeRecord(ctx, def, rec).catch((e) =>
        axnLog('warn', 'dev-workflow', `state mirror failed: ${String(e)}`),
      );
      showState(ctx, def, rec, { freshEntry: true });
      axnLog('info', 'dev-workflow', `${id}: ${def.id} → ${target} (output marker)`);
      // Agent-driven transition — an entry like any other, so the entered
      // state's `auto` actions fire (e.g. axn-focus back to the shell).
      runAutoActions(ctx, def, target, false);
      return true;
    }
    const cm = marked(CHECK_MARKER.exec(line));
    if (cm) {
      recordCheckMarker(ctx, def, cm[2], parseInt(cm[3], 10));
      continue;
    }
    const rm = marked(RUN_MARKER.exec(line));
    if (rm) {
      void markerRun(ctx, def, rm[2]).catch((e) =>
        axnLog('warn', 'dev-workflow', `run marker '${rm[2]}' failed: ${String(e)}`),
      );
      continue;
    }
    const vm = marked(VAR_MARKER.exec(line));
    if (vm && vm[3] !== undefined) {
      setVar(ctx, def, vm[2], vm[3].trim());
      continue;
    }
    axnLog('info', 'dev-workflow', `${id}: ignored marker without this binding's token`);
  }
  return false;
}

function scheduleReconcile(ctx: Ctx): void {
  const id = ctx.session.id;
  if (reconcileTimers.has(id)) return;
  reconcileTimers.set(
    id,
    setTimeout(() => {
      reconcileTimers.delete(id);
      void reconcile(ctx).catch((e) =>
        axnLog('warn', 'dev-workflow', `reconcile failed for ${id}: ${String(e)}`),
      );
    }, RECONCILE_DELAY_MS),
  );
}

// ---------------------------------------------------------------------------
// Commands + menu items
// ---------------------------------------------------------------------------

const echo = (msg: string) => `echo ${JSON.stringify(msg)}`;

/** Shell-ish tokenizer for command args — honours single/double quotes. */
export { shellTokens };

/**
 * Parse `axn-workflow start <wf>` trailing args into var values: `key=value`
 * pairs set by name (keys camelized), bare tokens fill declared vars in
 * declaration order — `axn-workflow start mr-review <mr-url>` lands in the
 * first declared var.
 */
export function parseStartVars(
  def: WorkflowDef,
  rest: string,
): { vars: Record<string, string>; error?: string } {
  const vars: Record<string, string> = {};
  const positional: string[] = [];
  for (const t of shellTokens(rest)) {
    const eq = t.indexOf('=');
    if (eq > 0) vars[camelKey(t.slice(0, eq))] = t.slice(eq + 1);
    else positional.push(t);
  }
  const unfilled = (def.vars ?? []).filter((s) => vars[s.key] === undefined);
  positional.forEach((v, i) => {
    const spec = unfilled[i];
    if (spec) vars[spec.key] = v;
  });
  if (positional.length > unfilled.length) {
    const extra = positional.slice(unfilled.length).join(' ');
    return { vars, error: `unexpected argument${unfilled.length === 0 ? 's' : ''} '${extra}' — no declared var for it` };
  }
  return { vars };
}

/** Missing `required` vars after start args — usage text names them. */
function missingRequiredVars(def: WorkflowDef, vars: Record<string, string>): string[] {
  return (def.vars ?? [])
    .filter((s) => s.required && !(vars[s.key] ?? '').trim())
    .map((s) => s.key);
}

function findWorkflow(ctx: Ctx, arg: string | undefined): WorkflowDef | undefined {
  const defs = workflowsOf(ctx);
  if (!arg) return defs.length === 1 ? defs[0] : undefined;
  const clean = arg.replace(/^["']+|["']+$/g, '');
  return defs.find((d) => d.id === clean || d.title === clean);
}

function findBound(ctx: Ctx): WorkflowDef | undefined {
  const bound = bindingOf(ctx);
  return bound.workflow
    ? workflowsOf(ctx).find((d) => d.id === bound.workflow)
    : undefined;
}

/**
 * Sessions with a transition in flight — interactive moves serialize per
 * session so a double-click (or a re-dispatched synthetic click landing on
 * the re-rendered card) can't ping-pong the state file.
 */
const moveInFlight = new Set<string>();

/**
 * Menu/board/banner path: transition + the entered state's `auto` actions
 * (the on-enter hook — e.g. `axn-focus`); non-auto steps still start via the
 * explicit Run action (card/banner button).
 */
function menuMove(ctx: Ctx, def: WorkflowDef, state: string): void {
  if (moveInFlight.has(ctx.session.id)) return;
  moveInFlight.add(ctx.session.id);
  void (async () => {
    const res = await transitionTo(ctx, def, state);
    if (res.error) {
      // not a banner — that slot shows the workflow state (non-dismissible)
      ctx.setAttention({ level: 'warning', message: res.error });
    }
  })()
    .catch((e) => axnLog('warn', 'dev-workflow', `move to '${state}' failed: ${String(e)}`))
    .finally(() => moveInFlight.delete(ctx.session.id));
}

/**
 * Attach to an already-tracked state instead of restarting — a session
 * (re)entering a workflow should continue where the tracking backend is.
 */
async function attachExisting(ctx: Ctx, def: WorkflowDef): Promise<string | undefined> {
  const { record, invalid } = await readRecord(ctx, def);
  if (invalid || !record || record.workflow !== def.id) return undefined;
  if (!def.states.includes(record.state)) return undefined;
  showState(ctx, def, record, { freshEntry: true });
  return record.state;
}

/**
 * Fire the `auto` actions of `state` — an "on-enter" hook: runs when the
 * workflow starts (start state) and on every later transition into a state,
 * whether the move came from a command, the board, or an agent's
 * `axn-workflow-state[<token>]:` marker. `waitForPrompt` (start paths) delays until
 * the session's first output so a `shell` action isn't typed before the
 * prompt exists; later entries fire immediately — the session is live.
 */
function runAutoActions(ctx: Ctx, def: WorkflowDef, state: string, waitForPrompt: boolean): void {
  const auto = (def.steps[state] ?? []).filter((a) => a.auto);
  if (auto.length === 0) return;
  const run = () => {
    for (const a of auto) {
      void runAction(ctx, def, state, a).catch((e) =>
        axnLog('warn', 'dev-workflow', `auto action '${a.name}' failed: ${String(e)}`),
      );
    }
  };
  if (!waitForPrompt) {
    run();
    return;
  }
  void ctx
    .waitForSessionOutput(5000)
    .catch(() => {})
    .then(run);
}

function menuStart(ctx: Ctx, def: WorkflowDef): void {
  void (async () => {
    if ((await attachExisting(ctx, def)) !== undefined) return;
    const res = await transitionTo(ctx, def, def.start, { waitForPrompt: true });
    if (res.error) {
      ctx.setAttention({ level: 'warning', message: res.error });
    }
  })().catch((e) =>
    axnLog('warn', 'dev-workflow', `start '${def.id}' failed: ${String(e)}`),
  );
}

// ---------------------------------------------------------------------------
// MR review action — contributed onto glab-mr's MR rows via mrActions
// ---------------------------------------------------------------------------

/**
 * Worktree path → binding a freshly opened session should adopt. Staged by
 * `startMrReview` before `openSession` so `onSessionOpen` binds the review
 * session with the MR vars already in place.
 */
const pendingReviews = new Map<
  string,
  { workflow: string; vars: Record<string, string>; /** Start state; default `def.start`. */ state?: string }
>();

/**
 * The main checkout behind `root`, given git's absolute common dir
 * (`git rev-parse --path-format=absolute --git-common-dir`). A linked
 * worktree's common dir is the main checkout's `.git`, so its parent is the
 * repo every review worktree hangs off — without this, a review started from
 * a session in `…/worktrees/foo` nested its worktree at
 * `…/worktrees/worktrees/foo-mr-N`. Bare repos and unexpected output keep
 * `root`.
 */
export function mainCheckoutOf(root: string, commonDir: string): string {
  const dir = commonDir.trim().replace(/\/+$/, '');
  if (!dir.startsWith('/') || !dir.endsWith('/.git')) return root;
  return dir.slice(0, -'/.git'.length) || root;
}

/** `mainCheckoutOf` through git; any failure keeps `root`. */
async function resolveMainCheckout(api: Ctx, root: string): Promise<string> {
  const out = await api
    .exec(`git -C ${shellQuote(root)} rev-parse --path-format=absolute --git-common-dir`, root)
    .catch(() => '');
  return mainCheckoutOf(root, String(out ?? ''));
}

/**
 * The 'review' contribution rendered on MR rows in glab-mr: resolve the
 * session whose repo hosts the MR, fetch the merge/pull-request head ref
 * (GitLab `merge-requests/N/head`, GitHub `pull/N/head`), create a worktree
 * on the worktrees-plugin conventions (`axn-dev`-discoverable), open a
 * session there and bind this workflow with the MR vars pre-filled. The
 * originating session is never touched.
 */
/**
 * The open session whose repo hosts a review of `project` (any repo session
 * for a project-less ref). Several clones of one repo are common
 * (`ai-accelerator-1` … `-14`), so the order matters — the first match used to
 * win, which put every review off the same arbitrary clone:
 *   1. the session the click came from (`env.selectedSessionId`),
 *   2. a session whose `origin` is exactly the project,
 *   3. a session whose repo folder is named after the project,
 *   4. a session whose remote merely contains the project path.
 */
export function mrReviewSession(env: MrRowEnv, project: string | undefined): ShellSession | undefined {
  const projShort = project?.split('/').pop();
  const inProject = (s: ShellSession) =>
    project === undefined
      ? Boolean(s.repo?.root)
      : remoteMatchesProject(s.repo?.remote, project) ||
        (projShort !== undefined && Boolean(s.repo?.root.endsWith(`/${projShort}`))) ||
        Boolean(s.repo?.remote?.includes(project));
  const selected = env.sessions.find((s) => s.id === env.selectedSessionId);
  if (selected && inProject(selected)) return selected;
  if (project === undefined) return env.sessions.find(inProject);
  return (
    env.sessions.find((s) => remoteMatchesProject(s.repo?.remote, project)) ??
    env.sessions.find((s) => projShort !== undefined && s.repo?.root.endsWith(`/${projShort}`)) ??
    env.sessions.find((s) => s.repo?.remote?.includes(project))
  );
}

export async function startMrReview(
  mr: MrActionProps['mr'],
  def: WorkflowDef,
  env: MrRowEnv,
  workspaceId?: string,
): Promise<string | undefined> {
  const ref = parseMrRef(mr.url);
  const project = mr.project ?? ref?.project;
  // A known project only accepts a session inside that project's repo —
  // falling back to any repo session would run the fetch (and possibly the
  // whole review) in the wrong repository: refs like merge-requests/N/head
  // can exist there too, and a missing target branch then fails with a
  // misleading 'couldn't find remote ref' error. The any-repo fallback is
  // for project-less refs (session MR rows, bare `!N`), where the repo is
  // implied by the session the row lives on.
  const sess = mrReviewSession(env, project);
  const api = sess ? env.apiFor(sess.id) : undefined;
  let root = sess?.repo?.root;
  let remote = sess?.repo?.remote;
  let host = root ? api : undefined;
  if (!root && project && env.checkouts) {
    // No session inside the repo: a local clone known to repo discovery
    // (repo-dir providers such as axn-dev + the forge plugin's repo-roots).
    // The git work runs through any session — every command names the repo
    // explicitly with `git -C`.
    const clone = checkoutsOf(await env.checkouts().catch(() => []), project)[0];
    host = env.sessions.map((s) => env.apiFor(s.id)).find(Boolean);
    if (clone && host) {
      root = clone.path;
      remote = clone.remote ?? undefined;
    }
  }
  if (!root || !host) {
    const msg = env.checkouts && project
      ? `review ${mr.reference} — no local clone of ${project}: no open session in it, and none under the plugin's repo roots or from repo providers such as axn-dev`
      : `review ${mr.reference} — no session inside ${project ?? 'the MR project'}'s repo`;
    env.sessions
      .map((s) => env.apiFor(s.id))
      .find(Boolean)
      ?.setAttention({ level: 'warning', message: msg });
    axnLog('warn', 'dev-workflow', `MR review: no repo checkout for ${project ?? mr.url}`);
    return msg;
  }
  // A session in a linked worktree reports that worktree as its root —
  // review worktrees always hang off the main checkout.
  root = await resolveMainCheckout(host, root);
  // Already reviewing this MR: its worktree has a session — go there
  // instead of opening a second one.
  const dir = normPath(worktreeDirFor(root, `mr-${mr.iid}`));
  const open = env.sessions.find((s) => normPath(s.repo?.root ?? s.cwd) === dir);
  if (open) {
    env.selectSession(open.id);
    return undefined;
  }
  return reviewMr(host, root, mr, def, workspaceId, remote);
}

/**
 * Fetch the merge/pull-request head ref into a fresh worktree, open a
 * session there and stage the workflow binding (vars pre-filled) so
 * `onSessionOpen` adopts it. GitLab heads live under
 * `merge-requests/<iid>/head`, GitHub's under `pull/<iid>/head`; for a bare
 * ref see `reviewFetchRef` (`#45` → GitHub, `!123` → GitLab unless the
 * checkout is on GitHub).
 */
async function reviewMr(
  api: Ctx,
  root: string,
  mr: MrRef,
  def: WorkflowDef,
  workspaceId?: string,
  remote: string | undefined = api.session?.repo?.remote,
  /** Further start vars (`axn-workflow start <wf> <mr> key=value …`). */
  extraVars: Record<string, string> = {},
): Promise<string | undefined> {
  const ref = parseMrRef(mr.url);
  const slug = `mr-${mr.iid}`;
  const dir = worktreeDirFor(root, slug);
  const branch = worktreeBranchFor(slug);
  const fetchRef = reviewFetchRef(ref, mr.iid, remote);
  try {
    // Fetch the target branch first and best-effort: `origin/<target>` is
    // only the compare base for the worktree's git tab (`axn-git
    // origin/<target>`), so a remote without it (renamed or deleted target,
    // a fork as origin) must not fail the review. It goes first so the
    // required MR-head fetch leaves FETCH_HEAD on the review head.
    if (mr.targetBranch) {
      await api
        .exec(
          `git -C ${shellQuote(root)} fetch origin ${shellQuote(mr.targetBranch)}`,
          root,
        )
        .catch(() => {});
    }
    await api.exec(
      `git -C ${shellQuote(root)} fetch origin ${shellQuote(fetchRef)}`,
      root,
    );
    if ((await api.statPath(dir, root).catch(() => null))?.isDir) {
      // Re-review: the worktree/branch already exists — reuse it and
      // fast-forward to the just-fetched head when the tree is clean
      // (a dirty or diverged review worktree stays as-is).
      const inside = await api
        .exec(`git -C ${shellQuote(dir)} rev-parse --is-inside-work-tree`, root)
        .then(() => true)
        .catch(() => false);
      if (!inside) return `${mr.reference}: ${dir} exists but is not a git worktree`;
      await api
        .exec(`git -C ${shellQuote(dir)} merge --ff-only FETCH_HEAD`, root)
        .catch(() => {});
    } else {
      // `-B` re-creates `wt/mr-N` when a stale branch outlived its worktree.
      await api.exec(
        `git -C ${shellQuote(root)} worktree add ${shellQuote(dir)} -B ${shellQuote(branch)} FETCH_HEAD`,
        root,
      );
    }
  } catch (e) {
    const msg = `${mr.reference} worktree failed: ${String(e).split('\n')[0].slice(0, 200)}`;
    api.setAttention({ level: 'warning', message: msg });
    return msg;
  }
  const key = mrVarOf(def)?.key ?? def.vars?.[0]?.key ?? 'mr';
  const role = peekMrDetails(mr.url)?.role;
  const vars = expandVars(def, { ...extraVars, [key]: mr.url }, {
    [`${key}_title`]: mr.title,
    // your role on the MR (author | reviewer | other) — `{{mr_role}}`, MR_ROLE
    ...(role ? { [`${key}_role`]: role } : {}),
    ...(mr.sourceBranch ? { [`${key}_branch`]: mr.sourceBranch } : {}),
    ...(mr.targetBranch ? { [`${key}_target`]: mr.targetBranch } : {}),
    worktree: dir,
    branch,
  });
  pendingReviews.set(normPath(dir), { workflow: def.id, vars });
  axnLog(
    'info',
    'dev-workflow',
    `review staged: ${mr.reference} → ${dir} (workflow ${def.id}, workspace ${workspaceId ?? 'inherit'})`,
  );
  api.openSession(dir, `${mr.reference} ${mr.title}`.trim().slice(0, 80), workspaceId);
  return undefined;
}

/**
 * First workspace (panel order) belonging to the MR's project — scoped to
 * the repo via `defaultFolder`, or hosting a session whose repo matches.
 * Undefined when no workspace hosts the repo (caller falls back to a
 * workspace picker).
 */
export function mrWorkspace(env: MrRowEnv, mr: MrRef): Workspace | undefined {
  const project = mr.project ?? parseMrRef(mr.url)?.project;
  const short = project?.split('/').pop();
  if (!project) return undefined;
  return (env.workspaces ?? []).find(
    (ws) =>
      // A workspace scoped to the repo via defaultFolder is its home even
      // before any session there has been repo-probed.
      (short !== undefined &&
        normPath(ws.defaultFolder).split('/').pop() === short) ||
      env.sessions.some(
        (s) =>
          s.workspaceId === ws.id &&
          (s.repo?.remote?.includes(project) ||
            (short !== undefined && s.repo?.root.endsWith(`/${short}`))),
      ),
  );
}

/** Session-less environment `startTicket` needs from the board. */
export interface TicketStartEnv {
  sessions: ShellSession[];
  apiFor: (sessionId: string) => Ctx | undefined;
  selectSession: (sessionId: string) => void;
  settings: PluginSettings;
}

/**
 * Main checkouts a ticket can start in: repo-dir providers (axn-dev) plus the
 * forge plugins' `repo-roots`, and the repos of open sessions that are not
 * themselves linked worktrees.
 */
async function ticketRepoCandidates(host: Ctx, env: TicketStartEnv): Promise<string[]> {
  const roots = [
    ...parseRepoRoots(env.settings['glab-mr']?.repoRoots),
    ...parseRepoRoots(env.settings['gh-pr']?.repoRoots),
  ];
  const found = await localCheckouts((c, cwd) => host.exec(c, cwd), roots).catch(() => []);
  const paths = new Set<string>();
  for (const c of found) if (c.isMain !== false) paths.add(normPath(c.path));
  for (const s of env.sessions) {
    const root = s.repo?.root;
    if (root && !/\/worktrees\//.test(root)) paths.add(normPath(root));
  }
  return [...paths].sort((a, b) => a.localeCompare(b));
}

/** Shell script: reuse or create the ticket worktree off the default branch. */
export function ticketWorktreeScript(root: string, dir: string, branch: string): string {
  const r = shellQuote(root);
  const d = shellQuote(dir);
  const b = shellQuote(branch);
  return [
    `if git -C ${d} rev-parse --is-inside-work-tree >/dev/null 2>&1; then exit 0; fi`,
    `git -C ${r} fetch origin >/dev/null 2>&1 || true`,
    `base=$(git -C ${r} symbolic-ref -q --short refs/remotes/origin/HEAD || echo HEAD)`,
    `if git -C ${r} show-ref --verify --quiet ${shellQuote(`refs/heads/${branch}`)}; then`,
    `  git -C ${r} worktree add ${d} ${b}`,
    'else',
    `  git -C ${r} worktree add -b ${b} ${d} "$base"`,
    'fi',
  ].join('\n');
}

/**
 * Start a backlog ticket: pick a repo, reuse or create
 * `<parent>/worktrees/<repo>-<KEY>` on `wt/<KEY>` (off origin's default
 * branch), open a session there and stage the binding — the ticket var
 * filled, started in the state its tracker status enters at. A session
 * already open in that worktree is selected instead. Resolves an error
 * message, or undefined (also when the picker is dismissed).
 */
export async function startTicket(
  def: WorkflowDef,
  ticket: Ticket,
  env: TicketStartEnv,
): Promise<string | undefined> {
  const host = env.sessions.map((s) => env.apiFor(s.id)).find(Boolean);
  if (!host) return 'open any session first — it runs the git commands';
  const candidates = await ticketRepoCandidates(host, env);
  if (candidates.length === 0) {
    return 'no local repo found — open a session in the repo, or set repo-roots on glab-mr/gh-pr';
  }
  const root = await pickFromList({
    title: `Start ${ticket.key} in…`,
    placeholder: 'Repository',
    items: candidates.map((p) => ({
      key: p,
      label: p.split('/').pop() ?? p,
      detail: p,
    })),
  });
  if (!root) return undefined;
  const dir = worktreeDirFor(root, ticket.key);
  const open = env.sessions.find((s) => normPath(s.repo?.root ?? s.cwd) === normPath(dir));
  if (open) {
    env.selectSession(open.id);
    return undefined;
  }
  const branch = worktreeBranchFor(ticket.key);
  try {
    await host.exec(ticketWorktreeScript(root, dir, branch), root);
  } catch (e) {
    return `${ticket.key} worktree failed: ${String(e).split('\n')[0].slice(0, 200)}`;
  }
  const varKey = def.tickets?.var ?? 'ticket';
  const vars = expandVars(def, { [varKey]: ticket.key }, {
    [`${varKey}_summary`]: ticket.summary,
    [`${varKey}_url`]: ticket.url,
    worktree: dir,
    branch,
  });
  const entry = ticketRange(def, ticket.status, ticket.statusCategory)?.entry;
  pendingReviews.set(normPath(dir), { workflow: def.id, vars, state: entry });
  axnLog('info', 'dev-workflow', `ticket staged: ${ticket.key} → ${dir} (workflow ${def.id}, state ${entry ?? def.start})`);
  host.openSession(dir, `${ticket.key} ${ticket.summary}`.trim().slice(0, 80));
  return undefined;
}

/** Tickets of `list` no instance of `def` is bound to yet. */
export function backlogTickets(
  def: WorkflowDef,
  tickets: Ticket[],
  instances: Record<string, WorkflowInstance>,
): Ticket[] {
  const varKey = def.tickets?.var ?? 'ticket';
  const bound = new Set(
    Object.values(instances)
      .filter((i) => i.workflow === def.id)
      .map((i) => i.vars?.[varKey]?.trim().toUpperCase())
      .filter(Boolean),
  );
  return tickets.filter((t) => !bound.has(t.key.toUpperCase()));
}

/**
 * What clicking 'review' should do: launch straight into the workspace the
 * click came from (the selected session's), else the workspace hosting the MR
 * repo (or, when the host has no workspaces to choose from, wherever the
 * session lands), or ask the user to pick one. Extracted so the branch is
 * unit-testable — a click that does none of these is a bug.
 */
export function mrReviewLaunch(
  env: MrRowEnv,
  mr: MrRef,
): { kind: 'launch'; workspaceId?: string } | { kind: 'pick' } {
  // The first workspace hosting the repo used to win, so reviews landed in
  // whichever workspace happened to hold some clone of it (VectorDB rather
  // than the one being worked in) — where nobody looked for them.
  const from = env.sessions.find((s) => s.id === env.selectedSessionId)?.workspaceId;
  if (from && (env.workspaces ?? []).some((w) => w.id === from)) {
    return { kind: 'launch', workspaceId: from };
  }
  const ws = mrWorkspace(env, mr);
  if (ws) return { kind: 'launch', workspaceId: ws.id };
  if ((env.workspaces ?? []).length === 0) return { kind: 'launch' };
  return { kind: 'pick' };
}

/**
 * Workflows that start from an MR row: those whose first `kind: mr` var is
 * *required* and whose `when` holds for `role` (your role on that MR;
 * undefined while unknown — then only workflows without a role condition).
 * A workflow that only records its MR later (an optional var, e.g. a
 * development flow that opens its own MR) gets no row button. Nothing is
 * offered unless a workflow in plugins.yaml declares it.
 */
export function mrStartWorkflows(
  settings: Record<string, unknown> | undefined,
  role?: MrRole,
): WorkflowDef[] {
  if (settings?.enabled !== true) return [];
  return parseWorkflows(settings).filter((d) => {
    const v = mrVarOf(d);
    return v?.required === true && mrConditionMet(v.when, role);
  });
}

/**
 * Provider registered with glab-mr — renders one button per workflow from
 * `mrStartWorkflows`, labelled with the workflow's title so several stay
 * distinguishable. Reads dev-workflow's settings through the
 * provider tree, so it honours live plugins.yaml edits and the plugin's
 * `enabled` flag without a session-bound ctx.
 */
function MrReviewButton({ mr, env }: MrActionProps) {
  const { pluginSettings } = usePluginSettings();
  const [pick, setPick] = useState<{ x: number; y: number; def: WorkflowDef } | null>(null);
  // Fetch + worktree + session spawn take seconds — without feedback the
  // button looks dead. `busy` holds the launching workflow's id; `err`
  // surfaces a failure the row-level attention banner would hide (the MR
  // overview doesn't show session banners): a 'failed' label on the row plus
  // a modal with the message while `errOpen` is set.
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [errOpen, setErrOpen] = useState(false);
  const backdropDown = useRef(false);
  useEffect(() => {
    if (!errOpen) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setErrOpen(false);
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [errOpen]);
  const settings = pluginSettings['dev-workflow'] as Record<string, unknown> | undefined;
  // Your role on this MR, from the forge plugin's cache (fetched once on a
  // miss) — workflows whose `when` needs a role wait until it is known.
  const details = useMrDetails(mr.url);
  const defs = mrStartWorkflows(settings, details?.role);
  if (defs.length === 0) return null;
  const workspaces = env.workspaces ?? [];
  const fail = (msg: string) => {
    axnLog('warn', 'dev-workflow', `review ${mr.reference} failed: ${msg}`);
    setErr(msg);
    setErrOpen(true);
  };
  const launch = (def: WorkflowDef, workspaceId?: string) => {
    setBusy(def.id);
    setErr(null);
    setErrOpen(false);
    void startMrReview(mr, def, env, workspaceId)
      .then((e) => {
        if (e) fail(e);
      })
      // A rejection (apiFor/openSession throwing, …) used to clear `busy`
      // with nothing shown — the 'preparing' flicker. Surface it like any
      // returned error.
      .catch((e) =>
        fail(`unexpected error: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`),
      )
      .finally(() => setBusy(null));
  };
  return (
    <>
      {defs.map((def) => (
        <button
          key={def.id}
          type="button"
          disabled={busy !== null}
          data-tip={
            err ??
            `${def.title}: open a worktree session on ${mr.reference}`
          }
          aria-label={`${def.title} for ${mr.reference}`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const target = mrReviewLaunch(env, mr);
            if (target.kind === 'launch') {
              launch(def, target.workspaceId);
            } else {
              setPick({ x: e.clientX, y: e.clientY, def });
            }
          }}
          className="flex shrink-0 items-center gap-1 rounded border border-[var(--border)] px-1 py-px text-[10px] text-[var(--text-secondary)] transition hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:cursor-wait disabled:opacity-70"
        >
          {busy === def.id ? (
            <>
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
              preparing…
            </>
          ) : err ? (
            <span className="text-[var(--red)]">failed</span>
          ) : (
            <>
              <Workflow className="h-2.5 w-2.5" />
              {def.title}
            </>
          )}
        </button>
      ))}
      {pick && (
        <WorkspacePicker
          x={pick.x}
          y={pick.y}
          workspaces={workspaces}
          title={`Review ${mr.reference} in`}
          onPick={(ws) => launch(pick.def, ws.id)}
          onClose={() => setPick(null)}
        />
      )}
      {err && errOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50"
          // Close only on a click that starts AND ends on the backdrop: a
          // text selection dragged out of the dialog ends on the backdrop too,
          // and its click used to close the dialog mid-copy.
          onMouseDown={(e) => {
            backdropDown.current = e.target === e.currentTarget;
          }}
          onClick={(e) => {
            if (backdropDown.current && e.target === e.currentTarget) setErrOpen(false);
            backdropDown.current = false;
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="mr-review-error-title"
            className="w-full max-w-md rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-5 text-[var(--text-primary)] shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="mr-review-error-title" className="font-semibold">
              Could not start the review
            </h2>
            <p className="my-3 text-sm">
              Preparing {mr.reference} failed — no review session was opened.
            </p>
            <p
              role="alert"
              className="my-3 select-text break-all rounded border border-[var(--border)] bg-[var(--surface)] p-2 font-mono text-[13px] text-[var(--red)]"
            >
              {err}
            </p>
            <div className="flex justify-end gap-3 text-sm">
              {shellServices() && (
                <button type="button" onClick={() => void shellServices()?.copyText(err)}>
                  Copy
                </button>
              )}
              <button
                autoFocus
                type="button"
                onClick={() => setErrOpen(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

registerMrActions('dev-workflow', MrReviewButton);

// ---------------------------------------------------------------------------
// Kanban view
// ---------------------------------------------------------------------------

/** A var value rendered compactly — MR/PR urls collapse to a `!N`/`#N` chip. */
/** A ticket without a session: dimmed, with a Start button. */
function BacklogCard({ def, ticket, env }: { def: WorkflowDef; ticket: Ticket; env: TicketStartEnv }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div
      className="rounded border border-dashed border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-[11px] opacity-75 transition hover:opacity-100"
      data-tip={[ticket.summary, [ticket.type, ticket.assignee ?? 'Unassigned'].filter(Boolean).join(' · ')].join('\n')}
    >
      <div className="flex items-center gap-1.5">
        <ChipView
          chip={{
            label: `${ticket.key} · ${ticket.status}`,
            href: ticket.url,
            color: ticket.color,
          }}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setErr(null);
            void startTicket(def, ticket, env)
              .then((e) => setErr(e ?? null))
              .catch((e) => setErr(String(e instanceof Error ? e.message : e).slice(0, 200)))
              .finally(() => setBusy(false));
          }}
          data-tip={err ?? `Start ${ticket.key}: worktree + session, workflow bound`}
          className="ml-auto flex shrink-0 items-center gap-0.5 rounded border border-[var(--border)] px-1 py-px text-[9px] text-[var(--text-secondary)] transition hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:cursor-wait"
        >
          {busy ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Play className="h-2.5 w-2.5" />}
          {err ? <span className="text-[var(--red)]">failed</span> : 'Start'}
        </button>
      </div>
      <div className="mt-0.5 line-clamp-2 break-words text-[10px] text-[var(--text-secondary)]">
        {ticket.summary}
      </div>
    </div>
  );
}

/**
 * Enricher chips for a kanban card plus, for a workflow with a `tickets`
 * link, a drift badge when the session's state lies outside the range the
 * ticket's tracker status covers.
 */
function TicketCardInfo({
  def,
  state,
  subject,
}: {
  def: WorkflowDef;
  state: string;
  subject: CardSubject;
}) {
  const enrichments = useCardEnrichment(subject);
  const source = def.tickets?.source;
  const fields = Object.assign({}, ...enrichments.map((e) => e.fields ?? {})) as Record<string, string>;
  const drift = source
    ? ticketDrift(def, state, fields[`${source}.status`] || undefined, fields[`${source}.statusCategory`] || undefined)
    : undefined;
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-1">
      <CardChips subject={subject} />
      {drift && (
        <span
          data-tip={drift}
          className="inline-flex items-center gap-0.5 rounded border border-[var(--orange)] px-1 py-px text-[9px] text-[var(--orange)]"
        >
          <AlertTriangle className="h-2.5 w-2.5" />
          drift
        </span>
      )}
    </div>
  );
}

function VarValue({ value }: { value: string }) {
  const chip = varChipFor(value);
  const cls = 'truncate font-semibold text-[var(--accent)]';
  if (!chip) return <span className="truncate">{value}</span>;
  return chip.href ? (
    <a
      href={chip.href}
      target="_blank"
      rel="noreferrer"
      data-tip={chip.tip}
      onClick={(e) => e.stopPropagation()}
      className={`${cls} hover:underline`}
    >
      {chip.label}
    </a>
  ) : (
    <span className={cls} data-tip={chip.tip}>
      {chip.label}
    </span>
  );
}

/**
 * One declared var on a kanban card: label, the value (smart-rendered), and
 * click-to-edit inline. Enter/blur saves, Escape cancels.
 */
function CardVarRow({
  spec,
  value,
  onSave,
}: {
  spec: WorkflowVarSpec;
  value: string | undefined;
  onSave: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const empty = !(value ?? '').trim();
  return (
    <div className="flex items-center gap-1 text-[10px] text-[var(--text-secondary)]">
      <span className="shrink-0" data-tip={spec.hint ?? spec.key}>
        {spec.label ?? spec.key}
        {spec.required && empty ? <span className="text-[var(--orange)]"> *</span> : ''}:
      </span>
      {editing ? (
        <input
          autoFocus
          value={draft}
          placeholder={spec.hint ?? spec.key}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              onSave(draft);
              setEditing(false);
            } else if (e.key === 'Escape') {
              setEditing(false);
            }
          }}
          onBlur={() => {
            onSave(draft);
            setEditing(false);
          }}
          className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--bg)] px-1 py-px font-mono text-[10px] text-[var(--text-primary)]"
        />
      ) : (
        <button
          type="button"
          data-tip={value ? `${value}\nclick to edit` : `set ${spec.key}`}
          onClick={(e) => {
            e.stopPropagation();
            setDraft(value ?? '');
            setEditing(true);
          }}
          className={`min-w-0 flex-1 truncate text-left ${empty ? 'italic opacity-60' : ''}`}
        >
          {empty ? (spec.hint ?? 'unset') : <VarValue value={value!} />}
        </button>
      )}
    </div>
  );
}

function DevWorkflowRail({
  appState,
  updateAppState,
  sessions,
  viewActive,
  toggleView,
}: {
  appState: unknown;
  updateAppState: (patch: Record<string, unknown>) => void;
  sessions: ShellSession[];
  viewActive: boolean;
  toggleView: () => void;
}) {
  const instances =
    (appState as { instances?: Record<string, WorkflowInstance> } | undefined)?.instances ?? {};

  // Instances keyed by a session that no longer exists are stale: explicit
  // closes un-mirror via onClose, but sessions can also disappear without it
  // (state import on reload, replaced PTY session). The repo tracking file
  // stays authoritative, so pruning here loses nothing. The rail is always
  // mounted, so this runs even while the board is closed.
  useEffect(() => {
    const liveIds = new Set(sessions.map((s) => s.id));
    const stale = Object.keys(instances).filter((id) => !liveIds.has(id));
    if (stale.length === 0) return;
    const next = { ...instances };
    for (const id of stale) delete next[id];
    updateAppState({ instances: next });
  }, [sessions]);

  const liveIds = new Set(sessions.map((s) => s.id));
  const count = Object.keys(instances).filter((id) => liveIds.has(id)).length;
  return (
    <>
      <RailItem
        title="Dev workflows"
        onClick={toggleView}
        active={viewActive}
        badge={count > 0 ? count : undefined}
      >
        <Columns3 />
      </RailItem>
      <PublishPanelStatus
        source={devWorkflowPlugin.id}
        group={
          count > 0
            ? {
                title: 'Dev workflows',
                icon: 'Columns3',
                meters: [
                  {
                    label: 'Active',
                    value: String(count),
                    detail: sessions
                      .filter((s) => instances[s.id] !== undefined)
                      .map((s) => s.name)
                      .join(', '),
                  },
                ],
              }
            : null
        }
      />
    </>
  );
}

function DevWorkflowView({
  pluginSettings,
  appState,
  updateAppState,
  sessions,
  selectSession,
  sessionApi,
  close,
}: {
  pluginSettings: unknown;
  appState: unknown;
  updateAppState: (patch: Record<string, unknown>) => void;
  sessions: ShellSession[];
  selectSession: (sessionId: string) => void;
  sessionApi: (sessionId: string) => Ctx | undefined;
  close: () => void;
}) {
  const defs = parseWorkflows(pluginSettings);
  const instances =
    (appState as { instances?: Record<string, WorkflowInstance> } | undefined)?.instances ?? {};
  const liveIds = new Set(sessions.map((s) => s.id));
  // Backlog: tickets of linked workflows that no session works on yet.
  const { pluginSettings: allSettings } = usePluginSettings();
  const ticketRequests = defs
    .filter((d) => d.tickets?.query)
    .map((d) => ({ sourceId: d.tickets!.source, query: d.tickets!.query! }));
  const ticketLists = useTicketLists(ticketRequests, allSettings);
  const ticketEnv: TicketStartEnv = {
    sessions,
    apiFor: sessionApi,
    selectSession,
    settings: allSettings,
  };
  // Drag & drop: card being dragged + the column currently hovered.
  const [drag, setDrag] = useState<{ sessionId: string; workflow: string; from: string } | null>(
    null,
  );
  const [over, setOver] = useState<string | null>(null);

  const dropInstance = (sessionId: string) => {
    const next = { ...instances };
    delete next[sessionId];
    updateAppState({ instances: next });
  };

  if (defs.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-[var(--text-secondary)]">
        <p>No workflows defined.</p>
        <p>
          Add <code className="text-[var(--accent)]">dev-workflow.workflows</code> to plugins.yaml —
          see docs/dev-workflow.md.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">Workflows</h2>
        <button
          type="button"
          onClick={close}
          className="ml-auto rounded px-2 py-1 text-[11px] text-[var(--text-secondary)] transition hover:bg-[var(--surface)] hover:text-[var(--text-primary)]"
        >
          Close
        </button>
      </div>
      {defs.map((def) => {
        const cards = Object.entries(instances).filter(([, i]) => i.workflow === def.id);
        const ticketList = def.tickets?.query
          ? ticketLists.get(ticketListKey(def.tickets.source, def.tickets.query))
          : undefined;
        const backlog = ticketList ? backlogTickets(def, ticketList.tickets, instances) : [];
        const backlogEntry = (t: Ticket) =>
          ticketRange(def, t.status, t.statusCategory)?.entry ?? def.start;
        return (
          <div key={def.id} className="mb-6">
            <div className="mb-2 text-xs font-semibold text-[var(--text-secondary)]">
              {def.title}
            </div>
            <div className="flex items-stretch gap-2 overflow-x-auto pb-1">
              {def.states.map((state) => {
                const overKey = `${def.id}:${state}`;
                const canDrop =
                  drag !== null &&
                  drag.workflow === def.id &&
                  drag.from !== state &&
                  transitionAllowed(def, drag.from, state);
                const dropCls = drag
                  ? canDrop
                    ? over === overKey
                      ? ' border-[var(--accent)] bg-[var(--surface-hover)]'
                      : ' border-dashed border-[var(--accent)]'
                    : ' opacity-60'
                  : '';
                return (
                <div
                  key={state}
                  onDragOver={(e) => {
                    if (!canDrop) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    if (over !== overKey) setOver(overKey);
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                      setOver((o) => (o === overKey ? null : o));
                    }
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const d = drag;
                    setDrag(null);
                    setOver(null);
                    if (!d || !canDrop) return;
                    const api = sessionApi(d.sessionId);
                    if (api) menuMove(api, def, state);
                  }}
                  className={`flex min-w-[9rem] flex-1 flex-col gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2${dropCls}`}
                >
                  <div className="text-[11px] font-semibold text-[var(--text-secondary)]">
                    {state}
                  </div>
                  {cards
                    .filter(([, i]) => i.state === state)
                    .map(([sessionId, inst]) => {
                      const live = liveIds.has(sessionId);
                      const session = sessions.find((s) => s.id === sessionId);
                      const proc = session?.process;
                      const idx = def.states.indexOf(inst.state);
                      const move = (target: string) => {
                        const api = sessionApi(sessionId);
                        if (api) menuMove(api, def, target);
                      };
                      const runActionOnCard = (action: WorkflowAction) => {
                        const api = sessionApi(sessionId);
                        if (!api) return;
                        void runAction(api, def, inst.state, action);
                        // surface the launch — the board hides the terminal
                        selectSession(sessionId);
                      };
                      const remove = () => {
                        if (!live) return dropInstance(sessionId);
                        const api = sessionApi(sessionId);
                        if (api) clearBinding(api);
                      };
                      const prev = idx > 0 ? def.states[idx - 1] : undefined;
                      const next = idx < def.states.length - 1 ? def.states[idx + 1] : undefined;
                      const canPrev =
                        prev !== undefined && transitionAllowed(def, inst.state, prev);
                      const canNext =
                        next !== undefined && transitionAllowed(def, inst.state, next);
                      const actions = live ? (def.steps[inst.state] ?? []) : [];
                      const checks = live
                        ? (
                            (sessionApi(sessionId)?.pluginState as BindingState | undefined)
                              ?.checks ?? {}
                          )
                        : {};
                      return (
                        <div
                          key={sessionId}
                          draggable={live}
                          onDragStart={(e) => {
                            e.dataTransfer.setData('application/x-axn-workflow-session', sessionId);
                            e.dataTransfer.effectAllowed = 'move';
                            setDrag({ sessionId, workflow: def.id, from: inst.state });
                          }}
                          onDragEnd={() => {
                            setDrag(null);
                            setOver(null);
                          }}
                          className={`select-none rounded border border-[var(--border)] px-2 py-1.5 text-xs ${
                            live
                              ? 'cursor-grab bg-[var(--bg)] active:cursor-grabbing'
                              : 'bg-[var(--bg)] opacity-50'
                          }`}
                        >
                          <div className="flex items-center gap-1.5">
                            {/* flex wrapper blockifies SessionIcon's inline
                                span so its h-/w- classes apply — without it a
                                raw-svg icon (width=100%) resolves against the
                                card and renders huge */}
                            <span className="flex shrink-0" data-tip={proc ?? 'no process'}>
                              <SessionIcon process={proc} className="h-3 w-3 shrink-0" />
                            </span>
                            {/* span, not button — a button child can swallow the
                                mousedown that starts the card's HTML5 drag */}
                            <span
                              role="button"
                              tabIndex={live ? 0 : -1}
                              onClick={() => live && selectSession(sessionId)}
                              className="block min-w-0 flex-1 cursor-pointer truncate text-left font-semibold text-[var(--text-primary)]"
                              data-tip={inst.cwd ?? sessionId}
                            >
                              {inst.sessionName ?? sessionId}
                            </span>
                          </div>
                          {session?.summary && (
                            <div
                              className="line-clamp-3 whitespace-pre-line break-words text-[11px] text-[var(--text-secondary)]"
                              data-tip={session.summary}
                            >
                              {session.summary}
                            </div>
                          )}
                          <TicketCardInfo
                            def={def}
                            state={inst.state}
                            subject={{
                              vars: live
                                ? ((sessionApi(sessionId)?.pluginState as BindingState | undefined)
                                    ?.vars ?? inst.vars)
                                : inst.vars,
                              session: {
                                name: inst.sessionName ?? session?.name,
                                cwd: inst.cwd,
                              },
                            }}
                          />
                          {(def.vars?.length ?? 0) > 0 && (
                            <div className="mt-0.5 flex flex-col gap-0.5">
                              {def.vars!.map((spec) => {
                                const vars = live
                                  ? (((sessionApi(sessionId)?.pluginState as BindingState | undefined)
                                      ?.vars) ??
                                    inst.vars ??
                                    {})
                                  : (inst.vars ?? {});
                                return (
                                  <CardVarRow
                                    key={spec.key}
                                    spec={spec}
                                    value={vars[spec.key]}
                                    onSave={(v) => {
                                      const api = sessionApi(sessionId);
                                      if (api) setVar(api, def, spec.key, v.trim());
                                    }}
                                  />
                                );
                              })}
                            </div>
                          )}
                          <div className="mt-1 flex items-center justify-between">
                            <span className="flex w-4 justify-start">
                              {live && canPrev && (
                                <button
                                  type="button"
                                  data-tip={`move to ${prev}`}
                                  aria-label={`move to ${prev}`}
                                  onClick={() => move(prev!)}
                                  className="text-[var(--text-secondary)] transition hover:text-[var(--text-primary)]"
                                >
                                  <ChevronLeft className="h-3 w-3" />
                                </button>
                              )}
                            </span>
                            <button
                              type="button"
                              data-tip={
                                live
                                  ? 'remove session from workflow'
                                  : 'session closed — remove card'
                              }
                              onClick={remove}
                              className="text-[11px] text-[var(--text-secondary)] transition hover:text-[var(--red)]"
                            >
                              remove
                            </button>
                            <span className="flex w-4 justify-end">
                              {live && canNext && (
                                <button
                                  type="button"
                                  data-tip={`move to ${next}`}
                                  aria-label={`move to ${next}`}
                                  onClick={() => move(next!)}
                                  className="text-[var(--text-secondary)] transition hover:text-[var(--text-primary)]"
                                >
                                  <ChevronRight className="h-3 w-3" />
                                </button>
                              )}
                            </span>
                          </div>
                          {actions.length > 0 && (
                            <div className="mt-1 flex flex-col gap-1">
                              {actions.map((action) => {
                                const info = actionRunInfo(action, proc, inst.state);
                                const check = checks[checkKey(inst.state, action.name)];
                                return (
                                  /* wrapper carries the tip — a disabled
                                     button swallows pointer events */
                                  <span
                                    key={action.name}
                                    data-tip={
                                      check
                                        ? `${info.tip} — last run: ${checkTip(check)}`
                                        : info.tip
                                    }
                                    className="block"
                                  >
                                    <button
                                      type="button"
                                      disabled={info.kind === 'blocked'}
                                      onClick={() => runActionOnCard(action)}
                                      className="flex w-full items-center justify-center gap-1.5 rounded border border-[var(--border)] px-2 py-1 text-[11px] font-semibold text-[var(--text-primary)] transition hover:bg-[var(--surface-hover)] disabled:opacity-40"
                                    >
                                      <Play className="h-3 w-3 shrink-0" />
                                      <span className="truncate">{info.label}</span>
                                      {check && (
                                        <span
                                          className={`ml-auto shrink-0 font-bold ${
                                            check.status === 'ok'
                                              ? 'text-[var(--green)]'
                                              : check.status === 'failed'
                                                ? 'text-[var(--red)]'
                                                : 'text-[var(--text-secondary)]'
                                          }`}
                                        >
                                          {checkBadge(check).trim()}
                                        </span>
                                      )}
                                    </button>
                                  </span>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  {backlog
                    .filter((tk) => backlogEntry(tk) === state)
                    .map((tk) => (
                      <BacklogCard key={tk.key} def={def} ticket={tk} env={ticketEnv} />
                    ))}
                </div>
                );
              })}
            </div>
            {ticketList?.error && (
              <div className="text-[10px] text-[var(--red)]" data-tip={ticketList.error}>
                tickets could not be loaded — see the app log ({def.tickets?.source})
              </div>
            )}
            {cards.length === 0 && backlog.length === 0 && (
              <div className="text-[10px] text-[var(--text-secondary)]">
                no sessions on this workflow — start one with axn-workflow start {def.id}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// `axn-workflow <sub>` — the one command for every workflow operation
// ---------------------------------------------------------------------------

type CommandResult = string | false | void | Promise<string | false | void>;

interface WorkflowSubcommand {
  /** One-line usage shown by `axn-workflow help` and unknown subcommands. */
  usage: string;
  run: (ctx: Ctx, arg: string | undefined) => CommandResult;
  complete?: (ctx: Ctx, prefix: string) => string[] | Promise<string[]>;
}

const unquote = (v: string | undefined) => v?.replace(/^["']+|["']+$/g, '');
const unbound = (sub: string) =>
  echo(`axn-workflow ${sub}: no workflow bound — start one with axn-workflow start <workflow>`);

/**
 * `axn-workflow start <wf> <mr>` — the value for the workflow's `kind: mr`
 * var names an MR: check the var's `when` against your role on it, then
 * fetch it into its review worktree and open a session there (what the MR
 * row button does). Returns undefined when the current session already is
 * that worktree — the caller then binds in place.
 */
async function startOnMr(
  ctx: Ctx,
  def: WorkflowDef,
  spec: WorkflowVarSpec,
  raw: string,
  extraVars: Record<string, string>,
): Promise<string | false | undefined> {
  const ref = parseMrRef(raw);
  if (!ref) return undefined;
  const cwd = (await ctx.getCwd()) ?? ctx.session.cwd;
  const here =
    ctx.session.repo?.root ??
    (cwd ? (await ctx.exec('git rev-parse --show-toplevel', cwd).catch(() => '')).trim() : '');
  if (!here) return echo('axn-workflow start: session is not inside a git repository');
  const main = await resolveMainCheckout(ctx, here);
  if (normPath(worktreeDirFor(main, `mr-${ref.iid}`)) === normPath(here)) return undefined;
  let warning: string | undefined;
  if (spec.when?.role) {
    const role = ref.url ? (await resolveMrDetails(ref.url))?.role : undefined;
    if (role === undefined) {
      warning = `could not determine your role on ${raw} — started without checking 'when'`;
    } else if (!mrConditionMet(spec.when, role)) {
      return echo(
        `axn-workflow start: '${def.id}' accepts MRs where you are ${spec.when.role.join(' or ') || 'nobody'} — you are ${role} on ${raw}`,
      );
    }
  }
  // URL form: GitHub (incl. GHES hosts) is the `/pull/N` shape.
  const github = reviewFetchRef(ref, Number(ref.iid), ctx.session.repo?.remote).startsWith('pull/');
  const mr: MrRef = {
    iid: Number(ref.iid),
    reference: github ? `#${ref.iid}` : `!${ref.iid}`,
    title: ref.project ?? '',
    url: ref.url ?? raw,
    ...(ref.project ? { project: ref.project } : {}),
  };
  const err = await reviewMr(ctx, main, mr, def, undefined, ctx.session.repo?.remote, extraVars);
  if (err) return echo(err);
  return warning ? echo(`axn-workflow start: ${warning}`) : false;
}

const startSubcommand: WorkflowSubcommand = {
  usage: 'start <workflow> [arg|key=value …]',
  complete: (ctx, prefix) => {
    const clean = (prefix ?? '').replace(/^["']/, '');
    return workflowsOf(ctx)
      .map((d) => d.id)
      .filter((n) => n.startsWith(clean) && n !== clean);
  },
  run: async (ctx, arg) => {
    const defs = workflowsOf(ctx);
    if (defs.length === 0) {
      return echo('axn-workflow start: no workflows defined — see dev-workflow in plugins.yaml');
    }
    const raw = (arg ?? '').trim();
    // The whole arg may be the workflow name (titles contain spaces) —
    // else split at the first whitespace: `<wf> [arg|key=value …]`.
    let def = findWorkflow(ctx, raw);
    let rest = '';
    if (!def && raw) {
      const split = raw.search(/\s/);
      if (split > 0) {
        def = findWorkflow(ctx, raw.slice(0, split));
        rest = raw.slice(split + 1);
      }
    }
    if (!def) {
      return echo(
        `axn-workflow start: usage — axn-workflow start <${defs.map((d) => d.id).join('|')}> [arg|key=value …]`,
      );
    }
    const parsed = parseStartVars(def, rest);
    if (parsed.error) return echo(`axn-workflow start: ${parsed.error}`);
    // An MR for the `kind: mr` var: start in the MR's own worktree session.
    const spec = mrVarOf(def);
    const mrValue = spec ? parsed.vars[spec.key] : undefined;
    if (spec && mrValue) {
      const { [spec.key]: _mr, ...others } = parsed.vars;
      const routed = await startOnMr(ctx, def, spec, mrValue, others);
      if (routed !== undefined) return routed;
    }
    const vars = expandVars(def, parsed.vars);
    const missing = missingRequiredVars(def, vars);
    if (missing.length > 0) {
      return echo(`axn-workflow start: '${def.id}' requires ${missing.map((k) => `<${k}>`).join(' ')}`);
    }
    if (Object.keys(vars).length > 0) writeBinding(ctx, { vars });
    const attached = await attachExisting(ctx, def);
    if (attached !== undefined) {
      return echo(`workflow '${def.id}' attached — state '${attached}'`);
    }
    const res = await transitionTo(ctx, def, def.start, { waitForPrompt: true });
    if (res.error) return echo(`axn-workflow start: ${res.error}`);
    return echo(`workflow '${def.id}' started — state '${def.start}'`);
  },
};

const WORKFLOW_SUBCOMMANDS: Record<string, WorkflowSubcommand> = {
  status: {
    usage: 'status',
    run: (ctx) => {
      const bound = bindingOf(ctx);
      if (!bound.workflow) return echo('no workflow bound — start one with axn-workflow start <workflow>');
      const prefix = `${bound.state ?? ''}:`;
      const report = Object.entries(bound.checks ?? {})
        .filter(([k]) => prefix !== ':' && k.startsWith(prefix))
        .map(
          ([k, c]) =>
            `${k.slice(prefix.length)} ${
              c.status === 'ok' ? 'ok' : c.status === 'failed' ? `FAILED (${c.rc ?? '?'})` : c.status
            }`,
        );
      return echo(
        `${bound.workflow}: ${bound.state ?? 'unknown'}${report.length ? ` — ${report.join(', ')}` : ''}`,
      );
    },
  },
  start: startSubcommand,
  set: {
    usage: 'set <var> <value>',
    complete: (ctx, prefix) => {
      const def = findBound(ctx);
      const clean = (prefix ?? '').replace(/^["']/, '');
      if (clean.includes(' ')) return [];
      return (def?.vars ?? []).map((s) => s.key).filter((k) => k.startsWith(clean) && k !== clean);
    },
    run: (ctx, arg) => {
      const def = findBound(ctx);
      if (!def) return unbound('set');
      const [key, ...rest] = shellTokens(arg ?? '');
      const value = rest.join(' ');
      if (!key || !value) return echo('axn-workflow set: usage — axn-workflow set <var> <value>');
      setVar(ctx, def, key, value);
      return echo(`${def.id}: ${camelKey(key)} set`);
    },
  },
  move: {
    usage: 'move <state>',
    complete: (ctx, prefix) => {
      const def = findBound(ctx);
      if (!def) return [];
      const clean = (prefix ?? '').replace(/^["']/, '');
      return def.states.filter((st) => st.startsWith(clean) && st !== clean);
    },
    run: async (ctx, arg) => {
      const def = findBound(ctx);
      if (!def) return unbound('move');
      const target = unquote(arg);
      if (!target) return echo(`axn-workflow move: usage — axn-workflow move <${def.states.join('|')}>`);
      const res = await transitionTo(ctx, def, target);
      if (res.error) return echo(`axn-workflow move: ${res.error}`);
      // only the entered state's `auto` actions ran — other steps still
      // wait for the explicit Run action
      return echo(`workflow '${def.id}' → ${target}`);
    },
  },
  run: {
    usage: 'run <action>',
    complete: (ctx, prefix) => {
      const def = findBound(ctx);
      const bound = bindingOf(ctx);
      if (!def || !bound.state) return [];
      const clean = (prefix ?? '').replace(/^["']/, '');
      return (def.steps[bound.state] ?? []).map((a) => a.name).filter((n) => n.startsWith(clean) && n !== clean);
    },
    run: async (ctx, arg) => {
      const def = findBound(ctx);
      const bound = bindingOf(ctx);
      if (!def || !bound.state) return unbound('run');
      const action = findAction(def, bound.state, unquote(arg));
      if (!action) {
        const actions = def.steps[bound.state] ?? [];
        return echo(
          actions.length === 0
            ? `axn-workflow run: state '${bound.state}' has no actions`
            : `axn-workflow run: usage — axn-workflow run <${actions.map((a) => a.name).join('|')}>`,
        );
      }
      // Only reachable at a free prompt (a foreground agent gates the line
      // to /exit), so a shell action can be returned as the replacement
      // line — the user sees the real command, including its check trailer.
      if ((action.runIn ?? 'shell') === 'shell') {
        let cmd: string | undefined;
        try {
          cmd = await actionCommand(ctx, def, action, bound.state);
        } catch (e) {
          const msg = String(e instanceof Error ? e.message : e).split('\n')[0].slice(0, 300);
          return `echo ${shellQuote(`axn-workflow run: ${msg}`)}`;
        }
        if (!cmd) return echo(`axn-workflow run: nothing to run for '${action.name}'`);
        if (action.command) {
          recordCheck(ctx, def, bound.state, action.name, { status: 'running', at: Date.now() });
        }
        return `${actionEnv(ctx, def, action, bound.state)}${shellLine(action, bound.state, cmd, bound.token ?? '')}`;
      }
      await runAction(ctx, def, bound.state, action);
      return echo(`workflow '${def.id}' running '${action.name}'`);
    },
  },
  stop: {
    usage: 'stop',
    run: (ctx) => {
      const bound = bindingOf(ctx);
      clearBinding(ctx);
      return echo(bound.workflow ? `workflow '${bound.workflow}' stopped` : 'no workflow bound');
    },
  },
};

const workflowUsage = () =>
  `usage — axn-workflow ${Object.values(WORKFLOW_SUBCOMMANDS)
    .map((c) => c.usage)
    .join(' | ')}`;

/** Split `<sub> [rest]` — `rest` undefined when only the subcommand was given. */
export function splitSubcommand(arg: string | undefined): { sub: string; rest?: string } {
  const t = (arg ?? '').trim();
  const at = t.search(/\s/);
  if (at < 0) return { sub: t };
  return { sub: t.slice(0, at), rest: t.slice(at + 1).trim() || undefined };
}

/** The plugin's one command: `axn-workflow <status|start|set|move|run|stop>`. */
const WORKFLOW_COMMANDS: PluginCommand[] = [
  {
    name: 'axn-workflow',
    takesArg: true,
    completeArg: (ctx, prefix) => {
      const { sub, rest } = splitSubcommand(prefix);
      if (rest === undefined && !/\s$/.test(prefix ?? '')) {
        return Object.keys(WORKFLOW_SUBCOMMANDS).filter((n) => n.startsWith(sub) && n !== sub);
      }
      const found = WORKFLOW_SUBCOMMANDS[sub]?.complete?.(ctx, rest ?? '') ?? [];
      const withSub = (list: string[]) => list.map((c) => `${sub} ${c}`);
      return Array.isArray(found) ? withSub(found) : found.then(withSub);
    },
    run: (ctx, arg) => {
      const { sub, rest } = splitSubcommand(arg);
      if (!sub) return WORKFLOW_SUBCOMMANDS.status.run(ctx, undefined);
      const cmd = WORKFLOW_SUBCOMMANDS[sub];
      return cmd ? cmd.run(ctx, rest) : echo(`axn-workflow: ${workflowUsage()}`);
    },
  },
];

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const devWorkflowPlugin: SessionViewPlugin = {
  id: 'dev-workflow',
  title: 'dev workflow',
  version: '0.1.0',
  stateKey: 'dev-workflow',
  settingsKey: 'dev-workflow',
  defaultEnabled: false,

  commands: WORKFLOW_COMMANDS,

  sessionMenuItems: (ctx): RepoMenuItem[] => {
    const bound = bindingOf(ctx);
    if (!bound.workflow) {
      const defs = workflowsOf(ctx);
      if (defs.length === 0) return [];
      if (defs.length === 1) {
        return [{ label: 'Start workflow', onClick: () => menuStart(ctx, defs[0]) }];
      }
      // One row opening a searchable workflow picker, not a row per workflow.
      return [
        {
          label: i18n._(t`Start workflow…`),
          onClick: () =>
            void pickFromList({
              title: 'Start workflow',
              placeholder: 'Search workflows…',
              items: defs.map((d) => ({
                key: d.id,
                label: d.title,
                detail: d.states.join(' → '),
              })),
            }).then((key) => {
              const def = defs.find((d) => d.id === key);
              if (def) menuStart(ctx, def);
            }),
        },
      ];
    }
    const def = findBound(ctx);
    if (!def) return [{ label: 'Stop workflow', onClick: () => clearBinding(ctx) }];
    const actions = bound.state ? (def.steps[bound.state] ?? []) : [];
    return [
      ...actions.map((a) => ({
        label: `Run ${actionLabel(a)}`,
        onClick: () => {
          if (!bound.state) return;
          void runAction(ctx, def, bound.state, a).catch((e) =>
            axnLog('warn', 'dev-workflow', `run '${a.name}' failed: ${String(e)}`),
          );
        },
      })),
      ...def.states
        .filter((s) => s !== bound.state && transitionAllowed(def, bound.state, s))
        .map((s) => ({
          label: `Workflow ${def.id} → ${s}`,
          onClick: () => menuMove(ctx, def, s),
        })),
      { label: 'Stop workflow', onClick: () => clearBinding(ctx) },
    ];
  },

  // Under the selected session: "workflow · state" chip + set var chips.
  sessionFields: [
    {
      id: 'state',
      label: 'Workflow state',
      kind: 'block',
      zone: 'selected',
      // Searchable: workflow, state and the declared vars the block shows.
      search: (ctx) => {
        const bound = bindingOf(ctx);
        if (!bound.workflow) return null;
        const def = workflowsOf(ctx).find((d) => d.id === bound.workflow);
        return [
          def?.title ?? bound.workflow,
          bound.state ?? '',
          ...(def?.vars ?? []).map((spec) => bound.vars?.[spec.key] ?? ''),
        ];
      },
      value: (ctx) => {
        const bound = bindingOf(ctx);
        if (!bound.workflow) return null;
        const def = workflowsOf(ctx).find((d) => d.id === bound.workflow);
        const specs = def?.vars ?? [];
        return (
          <div className="mb-2 flex flex-wrap items-baseline gap-x-2 text-[10px] text-[var(--text-secondary)]">
            <span>
              workflow:{' '}
              <span className="text-[var(--accent)]">
                {def?.title ?? bound.workflow} · {bound.state ?? '?'}
              </span>
            </span>
            {specs.map((spec) => {
              const v = bound.vars?.[spec.key];
              if (!v) return null;
              return (
                <span key={spec.key}>
                  {spec.label ?? spec.key}: <VarValue value={v} />
                </span>
              );
            })}
          </div>
        );
      },
    },
  ],
  // Banner buttons declared by showState: ‹/› move through states, the
  // trailing `run:<name>` buttons launch the current state's actions.
  onBannerAction: (ctx, actionId) => {
    const def = findBound(ctx);
    const bound = bindingOf(ctx);
    if (!def || !bound.state) return;
    if (actionId.startsWith('run:')) {
      const action = findAction(def, bound.state, actionId.slice(4));
      if (!action) return;
      void runAction(ctx, def, bound.state, action).catch((e) =>
        axnLog('warn', 'dev-workflow', `run '${action.name}' failed: ${String(e)}`),
      );
      return;
    }
    const idx = def.states.indexOf(bound.state);
    const dir = actionId === 'prev' ? -1 : actionId === 'next' ? 1 : 0;
    const target = dir !== 0 && idx >= 0 ? def.states[idx + dir] : undefined;
    if (target) menuMove(ctx, def, target);
  },

  onSessionOpen: (ctx) => {
    // A session opened by startMrReview binds the workflow with the staged
    // MR vars instead of reconciling — the fresh worktree has no state yet.
    const pending = pendingReviews.get(normPath(ctx.getSession().cwd ?? ''));
    if (pending) {
      pendingReviews.delete(normPath(ctx.getSession().cwd ?? ''));
      const def = workflowsOf(ctx).find((d) => d.id === pending.workflow);
      if (!def) {
        // The workflow was removed/disabled between the click and the spawn —
        // without this the session opens bare with no hint why.
        axnLog(
          'warn',
          'dev-workflow',
          `review binding dropped in ${ctx.getSession().cwd}: workflow '${pending.workflow}' is gone`,
        );
        ctx.setAttention({
          level: 'warning',
          message: `review workflow '${pending.workflow}' is no longer configured`,
        });
      } else {
        writeBinding(ctx, { vars: pending.vars });
        void (async () => {
          if ((await attachExisting(ctx, def)) !== undefined) return;
          const res = await transitionTo(
            ctx,
            def,
            pending.state && def.states.includes(pending.state) ? pending.state : def.start,
            { waitForPrompt: true },
          );
          if (res.error) {
            ctx.setAttention({ level: 'warning', message: res.error });
          }
        })().catch((e) =>
          axnLog('warn', 'dev-workflow', `review bind failed: ${String(e)}`),
        );
        return;
      }
    }
    void reconcile(ctx).catch((e) =>
      axnLog('warn', 'dev-workflow', `open reconcile failed for ${ctx.session.id}: ${String(e)}`),
    );
  },

  onSubShellExit: (ctx, tabId, exitCode) => {
    const pending = pendingChecks.get(tabId);
    if (!pending || pending.sessionId !== ctx.session.id) return;
    const def = findBound(ctx);
    if (!def) return;
    recordCheck(ctx, def, pending.state, pending.name, {
      status: exitCode == null ? 'done' : exitCode === 0 ? 'ok' : 'failed',
      rc: exitCode ?? undefined,
      at: Date.now(),
    });
    // keep the mapping — Enter re-runs the check and reports again
  },

  onOutput: (ctx, text) => {
    const bound = bindingOf(ctx);
    if (!bound.workflow) return;
    const def = workflowsOf(ctx).find((d) => d.id === bound.workflow);
    if (!def) return;
    // File-tracked sessions: the file may have been written by an agent.
    if (def.trackingFile) scheduleReconcile(ctx);
    // Every bound session: scan for the state/check/run handoff markers.
    // A state move already rendered the banner — and the session read back
    // here would still be the pre-move snapshot (the host commits plugin
    // state asynchronously), so re-rendering from it would undo the move.
    if (scanMarkers(ctx, def, text)) return;
    // A foreground-process change (agent launch/exit) flips Run eligibility.
    refreshRunAffordance(ctx, def);
  },

  onClose: (ctx) => {
    const timer = reconcileTimers.get(ctx.session.id);
    if (timer) {
      clearTimeout(timer);
      reconcileTimers.delete(ctx.session.id);
    }
    markerTails.delete(ctx.session.id);
    uncommitted.delete(ctx.session.id);
    lastRunKey.delete(ctx.session.id);
    for (const [tabId, p] of pendingChecks) {
      if (p.sessionId === ctx.session.id) pendingChecks.delete(tabId);
    }
    unmirrorInstance(ctx);
  },

  renderRail: ({ appState, updateAppState, sessions, viewActive, toggleView }) => (
    <DevWorkflowRail
      appState={appState}
      updateAppState={updateAppState}
      sessions={sessions}
      viewActive={viewActive}
      toggleView={toggleView}
    />
  ),

  renderView: ({ pluginSettings, appState, updateAppState, sessions, selectSession, sessionApi, close }) => (
    <DevWorkflowView
      pluginSettings={pluginSettings}
      appState={appState}
      updateAppState={updateAppState}
      sessions={sessions}
      selectSession={selectSession}
      sessionApi={sessionApi}
      close={close}
    />
  ),
};
