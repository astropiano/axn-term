import { dump } from 'js-yaml';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { SessionItem } from './SessionPanel';
import { PluginSettingsProvider } from './PluginSettingsProvider';
import { StoryShellProviders } from './storyMocks';
import { TooltipHost } from './Tooltip';
import type { SessionCardLayout } from './sessionCardLayout';
import type { RepoInfo, ShellSession } from '../types';
import type { TaskStateSnapshot } from './useAgentTasks';
import type { SessionViewPlugin } from './session-plugins/plugin';
import { gitStatusPlugin } from './session-plugins/gitStatus';
import { glabMrPlugin } from './session-plugins/glabMr';
import { ghPrPlugin } from './session-plugins/ghPr';
import { agentsPlugin } from './session-plugins/agents';
import { worktreesPlugin } from './session-plugins/worktrees';
import { devWorkflowPlugin } from './session-plugins/devWorkflow';
import { jiraPlugin, issueEnrichment, parseStatusColors } from './session-plugins/jira';
import { registerCardEnricher } from './session-plugins/cardEnrichers';

/**
 * The session card as the panel assembles it from session fields — real
 * plugins, canned session state. Plugins only provide the fields; the
 * `layout` control swaps the `sessionCard` setting that places them.
 */

// --- Jira: canned issues instead of the real enricher (never calls Jira) --
const JIRA = 'https://example.atlassian.net';
const ISSUES: Record<string, [string, string, string, string | null]> = {
  'AIACC-755': ['C2PA content credentials', 'In Progress', 'indeterminate', 'Ann'],
  'AIACC-891': ['Send declared model', 'Reviewed', 'indeterminate', 'Ben'],
  'VECTORDB-28': ['Mark weak search results', 'In Progress', 'indeterminate', 'Ann'],
  'VECTORDB-24': ['Run the e2e suite', 'Closed', 'done', 'Cleo'],
};
registerCardEnricher({
  id: 'jira',
  enabled: () => true,
  match: () => undefined,
  // Same contract as the real enricher: status-colors from the jira section.
  settingsKey: (s) => JSON.stringify(parseStatusColors(s.jira?.statusColors)),
  enrich: async (keys, settings) =>
    Object.fromEntries(
      keys
        .filter((k) => ISSUES[k])
        .map((k) => {
          const [summary, name, cat, who] = ISSUES[k];
          return [
            k,
            issueEnrichment(
              {
                key: k,
                fields: {
                  summary,
                  status: { name, statusCategory: { key: cat } },
                  assignee: who ? { displayName: who } : null,
                  issuetype: { name: 'Story' },
                },
              },
              JIRA,
              parseStatusColors(settings.jira?.statusColors),
            ),
          ];
        }),
    ),
});

/** `status-colors` presets — the jira plugin's per-status chip colors. */
const COLORS: Record<string, string> = {
  default: '',
  custom: '  status-colors: "In Progress: blue; Reviewed: #8e44ad; Closed: #1f9d55"\n',
};

const pluginsYaml = (colors: string) => `jira:
  enabled: true
  base-url: ${JIRA}
  email: story@example.com
  project-keys: AIACC, VECTORDB
  token: story-token
${COLORS[colors] ?? ''}dev-workflow:
  enabled: true
  workflows:
    development:
      title: Development
      states: [triage, adr, plan, implement, impl-review, done]
      vars:
        ticket: { label: Jira key }
`;

// --- Sessions ---------------------------------------------------------------
const repo = (name: string, branch: string, extra: Partial<RepoInfo> = {}): RepoInfo => ({
  name,
  group: 'ai',
  branch,
  ahead: 0,
  behind: 0,
  dirty: false,
  untracked: 0,
  remoteBranchMissing: false,
  root: `/work/${name}`,
  ...extra,
});

const mr = (iid: number, title: string, extra: Record<string, unknown> = {}) => ({
  iid,
  reference: `!${iid}`,
  title,
  url: `https://gitlab.example.com/ai/ai-accelerator/-/merge_requests/${iid}`,
  draft: false,
  conflicts: false,
  discussionsResolved: false,
  openThreads: 2,
  mergeStatus: 'mergeable',
  pipeline: 'success',
  ...extra,
});

// Header-chip colours: [id, what it shows, MR overrides].
const WAIT_OTHERS = { waitingForMe: 0, waitingForOther: 2 };
const WAIT_ME = { waitingForMe: 1, waitingForOther: 1 };
const MR_TONES: Array<[string, string, Record<string, unknown>]> = [
  ['red-pipeline', 'red · pipeline failed', { pipeline: 'failed', mergeStatus: 'ci_must_pass' }],
  ['red-conflict', 'red · merge conflicts', { conflicts: true, mergeStatus: 'conflict' }],
  ['red-comment', 'red · thread answered, your move', { openThreads: 2, threadSummary: WAIT_ME, mergeStatus: 'discussions_not_resolved' }],
  ['red-ready', 'red · green + ready to merge', { mergeStatus: 'mergeable' }],
  ['orange-dep', 'orange · waiting on another MR', { mergeStatus: 'blocked_status' }],
  ['yellow-threads', 'yellow · waiting on others', { openThreads: 2, threadSummary: WAIT_OTHERS, mergeStatus: 'discussions_not_resolved' }],
  ['yellow-ci', 'yellow · pipeline running', { pipeline: 'running', mergeStatus: 'ci_still_running' }],
  ['green', 'green · nothing to do', { mergeStatus: 'not_approved' }],
  ['gray-draft', 'gray · draft', { draft: true, mergeStatus: 'draft_status' }],
];

const base = (id: string, name: string, extra: Partial<ShellSession>): ShellSession => ({
  id,
  workspaceId: 'w1',
  name,
  topic: '',
  summary: '',
  tasks: [],
  progress: 0,
  output: '',
  ...extra,
});

const SESSIONS: ShellSession[] = [
  // GitLab MR + Jira (from the MR title) + running agent + workflow + tasks.
  base('mr', '!622 fix(AIACC-755): C2PA content credentials', {
    process: 'claude',
    status: 'running',
    progress: 40,
    cwd: '/work/worktrees/ai-accelerator-AIACC-755',
    summary: 'Wiring the C2PA manifest into the asset upload path.',
    repo: repo('ai-accelerator', 'feature/AIACC-755-c2pa', { ahead: 3, dirty: true }),
    tasks: [
      { id: 't1', title: 'Read the C2PA spec section', done: true },
      { id: 't2', title: 'Sign manifests on upload', done: false },
      { id: 't3', title: 'Add the e2e test', done: false },
    ],
    pluginState: {
      'glab-mr': { mrs: [mr(622, 'fix(AIACC-755): C2PA content credentials')] },
      agents: { persona: 'ai-team-writer' },
      'dev-workflow': { workflow: 'development', state: 'implement', vars: { ticket: 'AIACC-755' } },
    },
  }),
  // GitHub PR, idle, Jira from the PR title.
  base('pr', '#82 feat(VECTORDB-28): mark weak search results', {
    process: 'zsh',
    status: 'idle',
    repo: repo('vectordb', 'feat/weak-search', { behind: 2 }),
    pluginState: {
      'gh-pr': {
        prs: [
          {
            number: 82,
            reference: '#82',
            title: 'feat(VECTORDB-28): mark weak search results',
            url: 'https://github.com/example/vectordb/pull/82',
            draft: false,
            conflicts: false,
            discussionsResolved: true,
            openThreads: 0,
            mergeStatus: 'clean',
            checks: 'success',
            reviewDecision: 'APPROVED',
          },
        ],
      },
    },
  }),
  // MR chip tones — one session per colour.
  ...MR_TONES.map(([id, label, extra]) =>
    base(`tone-${id}`, `${label}`, {
      process: 'zsh',
      repo: repo('ai-accelerator', `feature/tone-${id}`),
      pluginState: { 'glab-mr': { mrs: [mr(700 + MR_TONES.length, label, { openThreads: 0, discussionsResolved: true, ...extra })] } },
    }),
  ),
  // Plain feature branch: no MR — Jira key from the branch, dirty + ahead.
  base('branch', 'ai-accelerator', {
    process: 'zsh',
    repo: repo('ai-accelerator', 'feature/AIACC-891-declared-model', {
      ahead: 1,
      dirty: true,
      untracked: 2,
      remoteBranchMissing: true,
    }),
  }),
  // Linked worktree with an agent persona; ticket from the session name.
  base('wt', 'VECTORDB-24 e2e run', {
    process: 'devin',
    status: 'completed',
    repo: repo('vectordb', 'wt/e2e-run'),
    pluginState: {
      agents: { persona: 'ast-code-reviewer' },
      worktrees: {
        worktree: { repoRoot: '/work/vectordb', path: '/work/worktrees/vectordb-wt-e2e-run', branch: 'wt/e2e-run' },
      },
    },
  }),
  // Nothing to show beyond the name.
  base('plain', 'scratch shell', { process: 'zsh' }),
  // Needs you: a critical attention flag via the workflow plugin's stateKey.
  base('attn', 'axn-term · devin', {
    process: 'devin',
    status: 'running',
    pluginState: {
      'dev-workflow': {
        attention: { level: 'critical', message: 'quiet for 45s — likely waiting for input' },
      },
    },
  }),
  // Same, only a warning — the orange ring, no badge.
  base('warn', 'axn-term · tests', {
    process: 'vitest',
    status: 'running',
    pluginState: {
      'dev-workflow': {
        attention: { level: 'warning', message: 'quiet for 45s — possibly finished' },
      },
    },
  }),
];

const PLUGINS: SessionViewPlugin[] = [
  gitStatusPlugin,
  glabMrPlugin,
  ghPrPlugin,
  agentsPlugin,
  worktreesPlugin,
  devWorkflowPlugin,
  jiraPlugin,
];

/** `plugins` control — `none` is the card with every plugin off. */
const PLUGIN_SETS: Record<string, SessionViewPlugin[]> = {
  all: PLUGINS,
  none: [],
};

// --- Layout presets (the `sessionCard` setting) -----------------------------
const LAYOUTS: Record<string, SessionCardLayout | undefined> = {
  /** No sessionCard: today's card. */
  default: undefined,
  /** Title stays lean; refs + tickets on one `·` row under it. */
  'refs-row': {
    title: ['core.name', 'core.status'],
    always: [
      ['core.summary'],
      ['glab-mr.mr', 'gh-pr.pr', 'git-status.branch', 'jira.tickets'],
    ],
  },
  /** Tickets only on the selected card. */
  'tickets-selected': { selected: [['jira.tickets'], ['core.process'], ['dev-workflow.state']] },
  /** Hide the badges, keep name + status + summary. */
  minimal: {
    hidden: ['git-status.branch', 'agents.persona', 'worktrees.worktree', 'jira.tickets', 'glab-mr.mr', 'gh-pr.pr'],
  },
};

/** The agent-task snapshot the card's task list renders (core.tasks). */
const taskSnapshot = (s: ShellSession): TaskStateSnapshot => ({
  currentTaskId: s.tasks.find((t) => !t.done)?.id ?? null,
  tasks: s.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.done ? 'completed' : 'pending',
    mode: '',
    summary: '',
    steps: [],
    decisions: [],
    openQuestions: [],
    nextAction: '',
    updatedAt: '',
  })),
});

function Panel({
  selected,
  colors,
  plugins,
}: {
  /** Consumed by the decorator (config.yaml seed), not by Panel itself. */
  layout: keyof typeof LAYOUTS;
  selected: string;
  colors: keyof typeof COLORS;
  plugins: keyof typeof PLUGIN_SETS;
}) {
  return (
    <PluginSettingsProvider
      key={colors}
      store={{ read: () => Promise.resolve(pluginsYaml(colors)), write: () => Promise.resolve() }}
    >
      <div className="w-80 bg-[var(--bg)] p-2">
        {SESSIONS.map((s) => (
          <SessionItem
            key={s.id}
            session={s}
            workspaces={[{ id: 'w1', name: 'ai-accelerator' }]}
            allSessions={SESSIONS}
            isSelected={s.id === selected}
            taskState={s.id === selected && s.tasks.length ? taskSnapshot(s) : null}
            onSelect={() => {}}
            onOpenIde={() => {}}
            onAddSession={() => {}}
            onRename={() => {}}
            onDuplicate={() => {}}
            onCloseSession={() => {}}
            onOpenSubShell={() => undefined}
            onTurnIntoWorkspace={() => {}}
            updateSession={() => {}}
            mergePluginState={() => {}}
            plugins={PLUGIN_SETS[plugins]}
            onOpenBrowser={() => {}}
            onOpenTab={() => {}}
            pluginData={{}}
            mergePluginData={() => {}}
            isDragging={false}
            dropBefore={false}
            onDragStart={() => {}}
            onDragEnd={() => {}}
            onDragOver={() => {}}
            onDrop={() => {}}
          />
        ))}
      </div>
    </PluginSettingsProvider>
  );
}

/**
 * Seed the `sessionCard` layout through the real seam — config.yaml via
 * `configYaml`. The theme comes from the Storybook toolbar's global
 * (the app's real theme picker), not from a settings hack.
 */
const configYaml = (layout: keyof typeof LAYOUTS): string =>
  dump(
    { ...(LAYOUTS[layout] ? { sessionCard: LAYOUTS[layout] } : {}) },
    { sortKeys: false },
  );

const meta = {
  title: 'app/Session card',
  component: Panel,
  decorators: [
    (Story, ctx) => (
      <StoryShellProviders
        configYaml={configYaml((ctx.args as { layout: keyof typeof LAYOUTS }).layout)}
      >
        <Story />
        {/* data-tip hovers (chips, badges) need the host the app mounts once. */}
        <TooltipHost />
      </StoryShellProviders>
    ),
  ],
  argTypes: {
    layout: { control: 'inline-radio', options: Object.keys(LAYOUTS) },
    selected: { control: 'select', options: SESSIONS.map((s) => s.id) },
    colors: { control: 'inline-radio', options: Object.keys(COLORS) },
    plugins: { control: 'inline-radio', options: Object.keys(PLUGIN_SETS) },
  },
  args: { layout: 'default', selected: 'mr', colors: 'default', plugins: 'all' },
} satisfies Meta<typeof Panel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** No `sessionCard` setting — today's card, every built-in case. */
export const Default: Story = {};

/** Lean title; MR/PR ref, branch and tickets `·`-joined under it. */
export const RefsRow: Story = { args: { layout: 'refs-row' } };

/** Jira tickets moved to the selected card only. */
export const TicketsOnSelectedCard: Story = { args: { layout: 'tickets-selected' } };

/** Badges hidden — name, status, summary. */
export const Minimal: Story = { args: { layout: 'minimal' } };

/** The GitHub PR session selected (its PR list block shows). */
export const GithubPrSelected: Story = { args: { selected: 'pr' } };

/** The worktree + persona session selected. */
export const WorktreeSelected: Story = { args: { selected: 'wt' } };

/** `jira.status-colors` with a named color and hex values. */
export const CustomStatusColors: Story = { args: { colors: 'custom' }, globals: { theme: 'axn-light' } };

/**
 * Every plugin off: the card falls back to its core fields — name, status,
 * summary/process/tasks/progress — and leaves no phantom zones.
 */
export const NoPlugins: Story = {
  args: { plugins: 'none' },
};
