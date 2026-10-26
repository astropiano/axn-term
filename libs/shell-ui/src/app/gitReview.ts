import type { ShellServices } from '@axn-term/session-backend';
import { promptArg } from '../shellQuote';

/**
 * Agent-powered review helpers for the git inspect view: prompt building,
 * explain/talk agent commands, and the persisted explanation store
 * (ShellServices.storage — ~/.axn-term/kv.json on desktop, localStorage on
 * web).
 */

/** Agent CLIs usable for explain/talk/resume — a sub-shell tab's `agent`. */
export type ReviewAgent = 'devin' | 'claude' | 'agy' | 'codex' | 'opencode';

export interface Explanation {
  /** The agent's answer text. */
  text: string;
  /** Which agent produced it. */
  agent: string;
  /** Content hash of the explained diff — staleness hint for worktree keys. */
  diffHash: string;
  /** Epoch ms. */
  at: number;
}

export type ExplanationMap = Record<string, Explanation>;

const STORE_KEY = 'git-review-explanations';
/** Keep the store bounded; oldest entries drop first (insertion order). */
const MAX_ENTRIES = 200;
/** Diff text is truncated to this size inside the prompt. */
const MAX_DIFF_CHARS = 16000;

export function normalizeReviewAgent(value: unknown): ReviewAgent | null {
  return value === 'devin' || value === 'claude' || value === 'agy' || value === 'codex'
    ? value
    : null;
}

/**
 * Per-CLI command shapes — each agent's own launch vocabulary: `print` is
 * one-shot stdout mode for headless `exec`, `seed` starts an interactive
 * REPL with the prompt as the first message, `resume` continues the tab's
 * conversation on re-spawn (devin alone names its session, captured from
 * its own exit hint).
 */
const AGENT_CMDS: Record<
  ReviewAgent,
  { print: (p: string) => string; seed: (p: string) => string; resume: (name?: string) => string }
> = {
  devin: {
    print: (p) => `devin -p ${p}`,
    seed: (p) => `devin -- ${p}`,
    resume: (name) => (name ? `devin -r ${name}` : 'devin -c'),
  },
  claude: {
    print: (p) => `claude -p ${p}`,
    seed: (p) => `claude ${p}`,
    resume: (id) => (id ? `claude --resume ${id}` : 'claude -c'),
  },
  agy: {
    print: (p) => `agy -p ${p}`,
    seed: (p) => `agy -i ${p}`,
    resume: () => 'agy -c',
  },
  codex: {
    print: (p) => `codex exec ${p}`,
    seed: (p) => `codex ${p}`,
    resume: () => 'codex resume --last',
  },
  opencode: {
    print: (p) => `opencode run ${p}`,
    seed: (p) => `opencode --prompt ${p}`,
    resume: (id) => (id ? `opencode -s ${id}` : 'opencode -c'),
  },
};

/** FNV-1a 32-bit hex — cheap stable key over diff content. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Explanation key for a whole commit — addressed by SHA, immutable. */
export function explainKeyForCommit(sha: string): string {
  return `commit:${sha}`;
}

/** Explanation key for one file inside a commit. */
export function explainKeyForCommitFile(sha: string, path: string): string {
  return `commit:${sha}:${path}`;
}

/**
 * Explanation key for a worktree file — path-keyed so the badge survives
 * refreshes; `diffHash` inside the entry records which revision it
 * described, letting the UI flag stale explanations.
 */
export function explainKeyForWorktreeFile(path: string): string {
  return `wt:${path}`;
}

/**
 * The prompt file content handed to the agent. `subject` identifies the
 * change (commit subject + sha, or the file path + area).
 */
export function buildExplainPrompt(subject: string, diffText: string): string {
  const body =
    diffText.length > MAX_DIFF_CHARS
      ? `${diffText.slice(0, MAX_DIFF_CHARS)}\n… [diff truncated]`
      : diffText;
  return (
    `Explain the motivation behind this change in 2-4 sentences. ` +
    `Focus on the intent, not a line-by-line walkthrough.\n\n` +
    `Change: ${subject}\n\n${body}\n`
  );
}

/** Prompt for the interactive "talk about this" session. */
export function buildTalkPrompt(subject: string, diffText: string): string {
  const body =
    diffText.length > MAX_DIFF_CHARS
      ? `${diffText.slice(0, MAX_DIFF_CHARS)}\n… [diff truncated]`
      : diffText;
  return (
    `I want to discuss this change. Start by briefly summarizing what it ` +
    `does and what might be worth a closer look, then wait for my ` +
    `questions.\n\nChange: ${subject}\n\n${body}\n`
  );
}

/**
 * One-shot command printing the explanation on stdout — run via the
 * backend `exec` (`sh -c`) in the repo root.
 */
export function explainCommand(agent: ReviewAgent, prompt: string): string {
  return AGENT_CMDS[agent].print(promptArg(prompt));
}

/**
 * Interactive command for a sub-shell tab: seeds the agent REPL with the
 * prompt, then drops into a login shell when it exits so the tab stays
 * usable (also covers agents that print-and-exit instead of staying in a
 * REPL).
 */
export function talkCommand(agent: ReviewAgent, prompt: string): string {
  return `${AGENT_CMDS[agent].seed(promptArg(prompt))}; exec "\${SHELL:-sh}" -l`;
}

/**
 * Command a "talk" sub-shell runs on every spawn after the first — resume
 * the existing conversation instead of re-seeding a new one. Devin resumes
 * the captured session by name once known (`devin -r <name>`), falling back
 * to the most recent session in the tab's directory (`devin -c`); the other
 * CLIs continue their most recent conversation (`claude -c`,
 * `agy -c`, `codex resume --last`).
 */
export function talkResumeCommand(agent: ReviewAgent, name?: string): string {
  return `${AGENT_CMDS[agent].resume(name)}; exec "\${SHELL:-sh}" -l`;
}

export async function loadExplanations(
  storage: NonNullable<ShellServices['storage']>,
): Promise<ExplanationMap> {
  const raw = await storage.get(STORE_KEY).catch(() => null);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as ExplanationMap) : {};
  } catch {
    return {};
  }
}

export async function saveExplanation(
  storage: NonNullable<ShellServices['storage']>,
  map: ExplanationMap,
  key: string,
  entry: Explanation,
): Promise<ExplanationMap> {
  const next = { ...map, [key]: entry };
  const keys = Object.keys(next);
  if (keys.length > MAX_ENTRIES) {
    const sorted = keys.sort(
      (a, b) => (next[a].at ?? 0) - (next[b].at ?? 0),
    );
    for (const k of sorted.slice(0, keys.length - MAX_ENTRIES)) delete next[k];
  }
  await storage.set(STORE_KEY, JSON.stringify(next)).catch(() => {});
  return next;
}

export async function removeExplanation(
  storage: NonNullable<ShellServices['storage']>,
  map: ExplanationMap,
  key: string,
): Promise<ExplanationMap> {
  const next = { ...map };
  delete next[key];
  await storage.set(STORE_KEY, JSON.stringify(next)).catch(() => {});
  return next;
}
