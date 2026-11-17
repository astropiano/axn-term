// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '@lingui/react';
import { bindAppRuntime } from '../appRuntime';
import { i18n } from '../../i18n';
import { glabMrPlugin, refreshMrOverview, resetMrOverview } from './glabMr';

// Only a stand-in action: the real dev-workflow button needs the settings provider.
vi.mock('./mrActions', async (orig) => ({
  ...(await orig<typeof import('./mrActions')>()),
  mrActionProviders: () => [() => <button data-testid="review-btn">review</button>],
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mr = (iid: string, extra: object = {}) => ({
  iid, reference: `!${iid}`, title: `title ${iid}`, description: `body of ${iid}`, webUrl: `u${iid}`,
  draft: false, conflicts: false, detailedMergeStatus: 'mergeable', sourceBranch: 'b', targetBranch: 'main',
  updatedAt: '2026-11-03T00:00:00Z', approved: false, userNotesCount: 0, resolvableDiscussionsCount: 0,
  resolvedDiscussionsCount: 0, approvedBy: { nodes: [] }, author: { username: 'other' },
  assignees: { nodes: [] }, reviewers: { nodes: [] }, project: { fullPath: 'g/p' }, headPipeline: null,
  ...extra,
});

let root: Root;
let host: HTMLDivElement;

beforeEach(async () => {
  bindAppRuntime({
    exec: async (cmd?: string) =>
      /'i\d+=/.test(cmd ?? '')
        ? JSON.stringify({ data: { m0: { mergeRequest: { discussions: { nodes: [] } } } } })
        : JSON.stringify({ data: { currentUser: {
            username: 'me',
            assignedMergeRequests: { nodes: [] },
            authoredMergeRequests: { nodes: [] },
            reviewRequestedMergeRequests: { nodes: [mr('3')] },
          } } }),
    statPath: async () => null,
    resolveSessionId: () => null,
  });
  await refreshMrOverview();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  bindAppRuntime(null);
  resetMrOverview();
});

async function render(appState: unknown, updateAppState = vi.fn()) {
  const view = glabMrPlugin.renderView!({
    pluginSettings: {},
    close: () => {},
    sessions: [],
    workspaces: [],
    selectSession: () => {},
    sessionApi: () => undefined,
    appState,
    updateAppState,
  } as unknown as Parameters<NonNullable<typeof glabMrPlugin.renderView>>[0]);
  await act(async () => root.render(<>{view}</>));
  // MrDescription parses markdown in a lazy chunk.
  await act(async () => new Promise((r) => setTimeout(r, 50)));
  return updateAppState;
}

const toggle = () => host.querySelector<HTMLButtonElement>('[aria-label$="descriptions"]')!;

it('aligns row actions with the title line', async () => {
  await render({});
  const btn = host.querySelector('[data-testid="review-btn"]')!;
  const actions = btn.parentElement!;
  const row = actions.parentElement!;
  expect(row.className).toContain('items-start');
  expect(actions.className).toContain('pt-1.5');
  expect(row.textContent).toContain('title 3');
});

it('shows descriptions by default and the toggle persists hiding them', async () => {
  const update = await render({});
  expect(host.textContent).toContain('body of 3');
  expect(toggle().getAttribute('aria-pressed')).toBe('true');
  await act(async () => toggle().click());
  expect(update).toHaveBeenCalledWith({ showDescriptions: false });
});

it('hides descriptions when turned off, and the toggle turns them back on', async () => {
  const update = await render({ showDescriptions: false });
  expect(host.textContent).toContain('title 3');
  expect(host.textContent).not.toContain('body of 3');
  expect(toggle().getAttribute('aria-label')).toBe('Show descriptions');
  await act(async () => toggle().click());
  expect(update).toHaveBeenCalledWith({ showDescriptions: true });
});

it('declares its own repo-roots setting, as gh-pr does', async () => {
  const { ghPrPlugin } = await import('./ghPr');
  for (const p of [glabMrPlugin, ghPrPlugin]) {
    expect(p.settings?.find((f) => f.key === 'repoRoots')).toMatchObject({ type: 'string' });
  }
  expect(glabMrPlugin.settings?.find((f) => f.key === 'repoRoots')?.description).toContain('GitLab');
  expect(ghPrPlugin.settings?.find((f) => f.key === 'repoRoots')?.description).toContain('GitHub');
});

it('shows the setup steps instead of an error card when not signed in', async () => {
  // glab answers, but without a user: not signed in on the host it asked.
  bindAppRuntime({
    exec: async () => JSON.stringify({ data: { currentUser: null } }),
    statPath: async () => null,
    resolveSessionId: () => null,
  });
  resetMrOverview();
  await refreshMrOverview({ hostname: 'gitlab.example.com' });
  const selectSession = vi.fn();
  const openSubShell = vi.fn();
  const view = glabMrPlugin.renderView!({
    pluginSettings: { hostname: 'gitlab.example.com' },
    close: () => {},
    sessions: [{ id: 's1', repo: { remote: 'git@gitlab.example.com:g/p.git' } }],
    workspaces: [],
    selectedSessionId: 's1',
    selectSession,
    sessionApi: () => ({ openSubShell }),
    appState: {},
    updateAppState: vi.fn(),
  } as unknown as Parameters<NonNullable<typeof glabMrPlugin.renderView>>[0]);
  // The onboarding is localized — it needs the app's i18n provider.
  await act(async () => root.render(<I18nProvider i18n={i18n}>{view}</I18nProvider>));

  expect(host.textContent).toContain('Connect GitLab');
  expect(host.textContent).toContain('glab is installed');
  // The host that was asked is visible, in the header and in the command.
  expect(host.textContent).toContain('gitlab.example.com');
  expect(host.textContent).toContain('glab auth login --hostname gitlab.example.com');
  expect(host.textContent).not.toContain('Not signed in to GitLab');

  const run = Array.from(host.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('Run in a shell tab'),
  )!;
  await act(async () => run.click());
  expect(openSubShell).toHaveBeenCalledWith(
    'glab auth login --hostname gitlab.example.com',
    undefined,
    'glab login',
  );
  expect(selectSession).toHaveBeenCalledWith('s1');
});
