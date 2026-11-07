import { useState, type ReactNode } from 'react';
import type { MemoryStats, SessionBackend, ShellServices } from '@axn-term/session-backend';
import type { ShellPlatform } from '../platform';
import { AlertOctagon, AlertTriangle, Menu, Settings } from 'lucide-react';
import type { ShellSession } from '../types';
import { SessionBackendProvider, ShellPlatformProvider, ShellServicesProvider, bindShellServices } from '../services';
import { SettingsProvider } from '../SettingsProvider';
import { PluginSettingsProvider } from './PluginSettingsProvider';
import { MemoryStatsProvider } from './useMemoryStats';
import { AttentionDot } from './AttentionDot';
import { setAppAttention, summarizeAttention, useAppAttention } from './attention';
import { bindAppRuntime } from './appRuntime';
import { orderRailPlugins } from './railOrder';
import { getSessionViewPlugins } from './session-plugins';

// ---------------------------------------------------------------------------
// Canned data — every rail plugin gets something to show without real
// CLIs/PTYs. `exec` answers the docker probe; `appRuntime.exec` answers the
// glab GraphQL call; `getMemoryStats` feeds the RAM bar.
// ---------------------------------------------------------------------------

// Fast-probe output: 6 running / 2 exited. The ==vm== exec supplies the
// strip values — ~71% VM memory (yellow); cpuStat deltas produce a VM CPU
// reading from the second poll on. The ==stats== container sums stay in
// the tooltips.
const STORY_DOCKER_LIVE = `==states==
running
running
running
running
running
running
exited
exited
==limits==
{"NCPU":6,"MemTotal":16734031872}
==stats==
180.50%|5.5GiB / 15.58GiB
35.20%|2.1GiB / 15.58GiB
12.30%|1.2GiB / 15.58GiB
8.00%|1.5GiB / 15.58GiB
4.10%|512MiB / 15.58GiB
1.90%|340MiB / 15.58GiB
==vm==
6
MemTotal:       16734032 kB
MemAvailable:    4900000 kB
cpu  120000 300 480000 9200000 40000 0 12000 0 0 0`;

// Slow disk-probe output: ~48 GB of docker objects, ~91 GB free (~35%, green).
const STORY_DOCKER_DISK = `==sizes==
8.9GB
290MB
37GB
1.9GB
==disk==
/dev/disk3s3s1 482797652 12346740 88640772 13% 458735 886407720 0% /`;

const STORY_MEM_STATS: MemoryStats = {
  totalKb: 32 * 1024 * 1024,
  availableKb: 10 * 1024 * 1024,
  swapTotalKb: 2 * 1024 * 1024,
  swapFreeKb: 1900 * 1024,
  appRssKb: 280 * 1024,
  sessions: [
    { sessionId: 'sess-1', rssKb: 420 * 1024 },
    { sessionId: 'sess-2', rssKb: 180 * 1024 },
  ],
};

const STORY_AXN_DEV_LIST = `Global scenarios:
  demo-mock                     ○ stopped — Full-stack mock: API server + hardware EPD emulator
  demo-full                     ● running — Single-port full stack with Caddy routing
    store                http://store.localhost:8091
    user-management      http://usermgmt.localhost:8091

Project scenarios:
  axn-term:
    axn-term-online              ○ stopped — axn-term online — web frontend + gateway
    axn-term-storybook           ● running — axn-term Storybook: component catalog
      storybook            http://localhost:8098
    axn-term-online              ○ stopped — axn-term online [worktree: feat/vibe @ worktrees/axn-term-feat-vibe]`;

const mr = (iid: number, over: Record<string, unknown> = {}) => ({
  iid: String(iid),
  reference: `!${iid}`,
  title: `Merge request ${iid}`,
  webUrl: `https://gitlab.com/axn-term/axn-term/-/merge_requests/${iid}`,
  draft: false,
  conflicts: false,
  detailedMergeStatus: 'mergeable',
  sourceBranch: `feat/mr-${iid}`,
  targetBranch: 'develop',
  updatedAt: new Date().toISOString(),
  approved: false,
  approvedBy: { nodes: [] },
  author: { username: 'alice' },
  assignees: { nodes: [] },
  reviewers: { nodes: [] },
  project: { fullPath: 'axn-term/axn-term' },
  headPipeline: null,
  discussions: { nodes: [] },
  ...over,
});

const STORY_GLAB_GQL = JSON.stringify({
  data: {
    currentUser: {
      username: 'alice',
      assignedMergeRequests: {
        nodes: [
          mr(101, { headPipeline: { status: 'FAILED' } }),
          mr(98, { headPipeline: { status: 'SUCCESS' } }),
        ],
      },
      authoredMergeRequests: {
        nodes: [mr(100, { approved: true, approvedBy: { nodes: [{ username: 'bob' }] } })],
      },
      reviewRequestedMergeRequests: {
        nodes: [
          mr(97, { author: { username: 'bob' } }),
          mr(96, {
            author: { username: 'carol' },
            discussions: {
              nodes: [
                {
                  resolvable: true,
                  resolved: false,
                  notes: { nodes: [{ author: { username: 'alice' } }] },
                },
              ],
            },
          }),
        ],
      },
    },
  },
});

const pr = (num: number, over: Record<string, unknown> = {}) => ({
  number: num,
  title: `Pull request ${num}`,
  url: `https://github.com/axn-term/axn-term/pull/${num}`,
  isDraft: false,
  mergeable: 'MERGEABLE',
  headRefName: `feat/pr-${num}`,
  baseRefName: 'develop',
  updatedAt: new Date().toISOString(),
  reviewDecision: null,
  author: { login: 'alice' },
  assignees: { nodes: [] },
  reviewRequests: { nodes: [] },
  repository: { nameWithOwner: 'axn-term/axn-term' },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  reviewThreads: { nodes: [] },
  reviews: { nodes: [] },
  ...over,
});

const STORY_GH_GQL = JSON.stringify({
  data: {
    viewer: { login: 'alice' },
    assigned: {
      nodes: [
        pr(101, { commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] } }),
        pr(98),
      ],
    },
    authored: {
      nodes: [
        pr(100, {
          reviewDecision: 'APPROVED',
          reviews: { nodes: [{ author: { login: 'bob' } }] },
        }),
      ],
    },
    review: {
      nodes: [
        pr(97, { author: { login: 'bob' } }),
        pr(96, {
          author: { login: 'carol' },
          reviewThreads: {
            nodes: [
              {
                isResolved: false,
                comments: { nodes: [{ author: { login: 'alice' } }] },
              },
            ],
          },
        }),
      ],
    },
  },
});

export const storySessions: ShellSession[] = [
  { id: 'sess-1', workspaceId: 'w1', name: 'axn-term · zsh', topic: '', summary: '', tasks: [], progress: 0, output: '' },
  { id: 'sess-2', workspaceId: 'w1', name: 'gateway · devin', topic: '', summary: '', tasks: [], progress: 0, output: '' },
  { id: 'sess-3', workspaceId: 'w2', name: 'docs · claude', topic: '', summary: '', tasks: [], progress: 0, output: '' },
];

/** pluginData.<settingsKey> — what plugins read as `appState`. */
export const storyPluginData: Record<string, unknown> = {
  'awesome-list': {
    items: [
      { id: 'a1', path: '~/dev' },
      { id: 'a2', path: 'https://gitlab.com/axn-term', label: 'GitLab' },
      { id: 'a3', path: '/tmp/notes.md' },
      { id: 'a4', path: 'git status --short --branch', label: 'status', type: 'command' },
      { id: 'a5', path: 'docker compose logs -f --tail 50', type: 'command' },
    ],
  },
  'dev-workflow': {
    instances: {
      'sess-1': {
        workflow: 'release',
        state: 'verify',
        sessionName: 'axn-term',
        updatedAt: Date.now(),
      },
      'sess-3': {
        workflow: 'review',
        state: 'draft',
        sessionName: 'docs',
        updatedAt: Date.now(),
      },
    },
  },
};

/** plugins.yaml-style sections, keyed by settingsKey — feeds renderView. */
export const storyPluginSettings: Record<string, unknown> = {
  'dev-workflow': {
    workflows: {
      release: {
        title: 'Release',
        states: ['plan', 'implement', 'verify', 'ship'],
        start: 'plan',
        steps: {
          implement: { agent: { cli: 'devin' }, prompt: 'Implement the plan.' },
          verify: { command: 'pnpm test' },
        },
      },
      review: {
        title: 'Review',
        states: ['draft', 'review', 'done'],
        start: 'draft',
        steps: {
          review: { agent: { cli: 'claude' }, prompt: 'Review the diff.' },
        },
      },
    },
  },
};

/** No-op backend that answers the canned probes — stories never spawn PTYs. */
export const storyBackend: SessionBackend = {
  createSession: () => Promise.resolve(false),
  write: () => {},
  resize: () => {},
  close: () => {},
  onOutput: () => () => {},
  exec: (_id, command) =>
    Promise.resolve(
      command.includes('docker stats')
        ? STORY_DOCKER_LIVE
        : command.includes('docker system df')
          ? STORY_DOCKER_DISK
          : '',
    ),
  getMemoryStats: () => Promise.resolve(STORY_MEM_STATS),
};

export const storyPlatform: ShellPlatform = {
  homeDir: () => Promise.resolve('/home/story'),
  stateStore: {
    load: () => Promise.resolve(null),
    save: () => Promise.resolve(),
  },
  pluginSettingsStore: {
    read: () => Promise.resolve(null),
    write: () => Promise.resolve(),
  },
  workspaceSetStorage: {
    save: () => Promise.resolve(),
    load: () => Promise.resolve(null),
  },
  configFileStorage: {
    save: () => Promise.resolve(),
    load: () => Promise.resolve(null),
  },
};

const storyServices: ShellServices = {
  copyText: () => Promise.resolve(),
  openExternal: () => {},
};

/**
 * Bind the module-level runtime/services stubs plugins read outside React
 * context. Call during render — child effects (e.g. the glab rail's first
 * refresh) run before the story component's own effects.
 */
export function bindStoryRuntime() {
  bindAppRuntime({
    exec: (command) =>
      Promise.resolve(
        command.includes('glab api graphql')
          ? STORY_GLAB_GQL
          : command.includes('gh api graphql')
            ? STORY_GH_GQL
            : command.includes('axn-dev list')
              ? STORY_AXN_DEV_LIST
              : '',
      ),
    statPath: (path) =>
      Promise.resolve({ path, isDir: !path.includes('.'), isFile: path.includes('.') }),
    resolveSessionId: () => storySessions[0]?.id ?? null,
  });
  bindShellServices(storyServices);
}

export function unbindStoryRuntime() {
  bindAppRuntime(null);
  bindShellServices(null);
}

/** Decorator for stories rendering app/* components. */
export function StoryShellProviders({ children }: { children: ReactNode }) {
  return (
    <SessionBackendProvider backend={storyBackend}>
      <ShellPlatformProvider platform={storyPlatform}>
        <ShellServicesProvider services={storyServices} fileReader={() => undefined}>
          <SettingsProvider>
            <PluginSettingsProvider store={storyPlatform.pluginSettingsStore}>
              {children}
            </PluginSettingsProvider>
          </SettingsProvider>
        </ShellServicesProvider>
      </ShellPlatformProvider>
    </SessionBackendProvider>
  );
}

// ---------------------------------------------------------------------------
// The rail column, replicated from ShellApp — all registered plugins with a
// renderRail, fed the canned state above. Must sit inside
// StoryShellProviders (backend + memory stats come from context).
// ---------------------------------------------------------------------------

export function StoryRail({
  activeId,
  onToggle,
  pluginData = storyPluginData,
}: {
  activeId: string | null;
  onToggle: (pluginId: string) => void;
  /** pluginData.<settingsKey> the rail plugins read as appState. */
  pluginData?: Record<string, unknown>;
}) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const plugins = orderRailPlugins(
    getSessionViewPlugins().filter((p) => p.renderRail),
    pluginData,
  );
  const appAttention = useAppAttention();
  const railAttention = summarizeAttention(appAttention);
  const runningCount = 2;

  return (
    <MemoryStatsProvider active>
      <div className="flex h-full w-10 flex-col items-center rounded border border-[var(--border)] bg-[var(--bg-secondary)] py-2">
        <button
          type="button"
          onClick={() => setSidebarOpen((v) => !v)}
          data-tip={sidebarOpen ? 'Hide sessions' : 'Show sessions'}
          className="flex h-7 w-7 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--accent)]"
        >
          <Menu className="h-4 w-4" />
        </button>
        <button
          type="button"
          data-tip={
            (railAttention ? `${railAttention.title}\n—\n` : '') +
            `${storySessions.length} sessions, ${runningCount} with a running process`
          }
          className="relative mt-2 flex h-8 w-7 cursor-default flex-col items-center justify-center gap-px"
        >
          {railAttention && (
            <AttentionDot
              level={railAttention.level}
              className="absolute left-1/2 top-1/2 h-6 w-6 -translate-x-1/2 -translate-y-1/2"
            />
          )}
          {railAttention &&
            (railAttention.level === 'critical' ? (
              <AlertOctagon className="relative h-3 w-3 text-[var(--red)]" />
            ) : (
              <AlertTriangle className="relative h-3 w-3 text-[var(--orange)]" />
            ))}
          <span className="relative select-none text-[8px] font-bold leading-none text-[var(--text-secondary)]">
            {runningCount}/{storySessions.length}
          </span>
        </button>
        {plugins.map((plugin) => {
          const settingsKey = plugin.settingsKey ?? plugin.id;
          return (
            <div key={plugin.id} className="mt-3">
              {plugin.renderRail!({
                backend: storyBackend,
                pluginSettings: storyPluginSettings[settingsKey],
                setAppAttention: (attention) => setAppAttention(plugin.id, attention),
                viewActive: activeId === plugin.id,
                toggleView: () => {
                  if (plugin.renderView) onToggle(plugin.id);
                },
                appState: pluginData[settingsKey],
                updateAppState: () => {},
                sessions: storySessions,
                sessionApi: () => undefined,
              })}
            </div>
          );
        })}
        <div className="flex-1" />
        <button
          type="button"
          data-tip="Settings"
          aria-label="Settings"
          className="flex h-7 w-7 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--accent)]"
        >
          <Settings className="h-4 w-4" />
        </button>
      </div>
    </MemoryStatsProvider>
  );
}
