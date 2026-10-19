/**
 * Central agent-persona schema + registry — the shared definition reused
 * across plugins (the `mrActions.ts` contribution pattern).
 *
 * A persona bundles how an agent launches: `cli`, `model`, extra `args`,
 * an optional seed `prompt`/`prompt-file` and a human-facing `description`.
 * Personas are declared in plugins.yaml under `agents.personas`; the agents
 * plugin owns that section and pushes the parsed list here on every ctx
 * touch, so the registry is live even though plugin settings are scoped.
 * Module state survives the plugin's enabled flag — built-ins ship in the
 * bundle regardless — but a *disabled* agents plugin stops refreshing, so
 * consumers must handle an empty registry (`resolvePersona` → undefined).
 *
 * `dev-workflow` resolves `agent: <name>` / `agent: {profile: <name>}`
 * through this registry; an unresolved name degrades to `cli: <name>`, so
 * `agent: claude` keeps working with no personas configured.
 */

/** One launchable agent persona — the reusable form of WorkflowAgentSpec. */
export interface AgentPersona {
  /** Registry key — also the session/launch name. */
  name: string;
  /** CLI binary invoked on launch (`claude`, `devin`, `codex`, …). */
  cli: string;
  /** `--model <model>` on the launch line. */
  model?: string;
  /** Extra CLI args appended verbatim, e.g. "--permission-mode accept-edits". */
  args?: string;
  /** Seed prompt handed to the agent at launch (inline text). */
  prompt?: string;
  /** Seed prompt file — repo-relative (session cwd). */
  promptFile?: string;
  /**
   * Persistent identity/context — delivered through the CLI's own
   * instructions channel by that CLI's registered launcher
   * (`--append-system-prompt(-file)` for claude,
   * `-c developer_instructions=` for codex, `GEMINI.md` for gemini under
   * `gemini.write-gemini-md`), prepended to the seed prompt for CLIs without
   * one. `instructionsFile` is cwd-relative like `promptFile`. This is the
   * `system`/system-prompt field other tools expose (opencode
   * `agents.<n>.system`, codex `developer_instructions`, Warp/AGENTS.md
   * "rules") — `instructions` keeps the user-facing name.
   */
  instructions?: string;
  /** Instructions file — cwd-relative; claude reads it natively. */
  instructionsFile?: string;
  /** Human-facing purpose — shown on persona cards and tooltips. */
  description?: string;
}

function camelKeys(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    out[k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = v;
  }
  return out;
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/**
 * Parse `agents.personas` — either the plugin's settings section
 * (`{ personas: {…} }`) or the personas map itself. A bare string value is
 * shorthand for `{ cli: <string> }`; an object's `cli` defaults to the
 * persona's name, so `claude: { model: opus }` means the claude cli.
 */
export function parsePersonas(raw: unknown): AgentPersona[] {
  const src = camelKeys(raw).personas ?? raw; // accept the section or the map itself
  if (!src || typeof src !== 'object' || Array.isArray(src)) return [];
  const out: AgentPersona[] = [];
  for (const [name, v] of Object.entries(src as Record<string, unknown>)) {
    if (!name) continue;
    if (typeof v !== 'string' && (!v || typeof v !== 'object' || Array.isArray(v))) continue;
    const s = typeof v === 'string' ? { cli: v } : camelKeys(v);
    out.push({
      name,
      cli: str(s.cli) ?? name,
      model: str(s.model),
      args: str(s.args),
      prompt: str(s.prompt),
      promptFile: str(s.promptFile),
      instructions: str(s.instructions),
      instructionsFile: str(s.instructionsFile),
      description: str(s.description),
    });
  }
  return out;
}

// Module-level registry — the agents plugin refreshes it from its settings
// on each ctx touch; consumers read it lazily at resolution time.
let personas: AgentPersona[] = [];

/** Replace the registry contents (idempotent — cheap to call per ctx). */
export function registerPersonas(list: AgentPersona[]): void {
  personas = list;
}

export function resolvePersona(name: string): AgentPersona | undefined {
  const p = personas.find((x) => x.name === name);
  return p ? { ...p } : undefined;
}

export function listPersonas(): AgentPersona[] {
  return personas.map((p) => ({ ...p }));
}

/** Tests and hot-reload paths — reset to empty. */
export function clearPersonas(): void {
  personas = [];
}

/** The launch-relevant slice of a persona/`agent:` spec. */
export interface AgentLaunchSpec {
  model?: string;
  args?: string;
  instructions?: string;
  instructionsFile?: string;
}

/** fs/tools a launcher may need — a PluginApi-compatible subset. */
export interface AgentLaunchTools {
  readFile: (path: string, cwd?: string) => Promise<string>;
  writeFile?: (path: string, contents: string, cwd?: string) => Promise<void>;
  statPath?: (path: string, cwd?: string) => Promise<{ isDir: boolean } | null>;
}

/**
 * Build the launch line for one CLI — each agent plugin owns its launch
 * semantics: how `instructions`/`instructionsFile` reach the agent (a
 * system-prompt flag, a config override, a context file in the cwd), where
 * the seed prompt goes, and any launch-time side effects. Receives the
 * resolved spec, the seed prompt (may be undefined), fs tools and the
 * launch cwd; returns the shell line. Throws with a user-facing message to
 * refuse the launch (e.g. gemini's GEMINI.md already exists).
 */
export type AgentLauncher = (
  spec: AgentLaunchSpec,
  prompt: string | undefined,
  tools: AgentLaunchTools,
  cwd: string,
) => string | Promise<string>;

// Same registry pattern as personas: built-in agent plugins register their
// cli's launcher at module scope; devWorkflow's `agentLaunchLine` consults
// it and falls back to the generic line for unregistered CLIs.
const launchers = new Map<string, AgentLauncher>();

/** Register the launch semantics for a CLI (built-in plugins, module scope). */
export function registerAgentLauncher(cli: string, launcher: AgentLauncher): void {
  launchers.set(cli, launcher);
}

export function agentLauncherFor(cli: string | undefined): AgentLauncher | undefined {
  return cli ? launchers.get(cli) : undefined;
}
