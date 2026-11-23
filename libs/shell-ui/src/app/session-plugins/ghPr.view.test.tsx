// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '@lingui/react';
import { bindAppRuntime } from '../appRuntime';
import { i18n } from '../../i18n';
import { ghPrPlugin, refreshPrOverview, resetPrOverview } from './ghPr';

// Only a stand-in action: the real dev-workflow button needs the settings provider.
vi.mock('./mrActions', async (orig) => ({
  ...(await orig<typeof import('./mrActions')>()),
  mrActionProviders: () => [() => <button data-testid="review-btn">review</button>],
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const node = (n: number, extra: object = {}) => ({
  number: n, title: `title ${n}`, bodyText: `body of ${n}`, url: `https://github.com/o/r/pull/${n}`,
  isDraft: false, mergeable: 'MERGEABLE', headRefName: 'b', baseRefName: 'main',
  updatedAt: '2026-11-03T00:00:00Z', reviewDecision: null, author: { login: 'other' },
  assignees: { nodes: [] }, reviewRequests: { nodes: [] }, repository: { nameWithOwner: 'o/r' },
  commits: { nodes: [] }, reviewThreads: { nodes: [] }, latestOpinionatedReviews: { nodes: [] },
  ...extra,
});

let root: Root;
let host: HTMLDivElement;

const answer = (body: unknown) =>
  bindAppRuntime({
    exec: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    statPath: async () => null,
    resolveSessionId: () => null,
  });

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  bindAppRuntime(null);
  resetPrOverview();
});

async function render(pluginSettings: object = {}) {
  const view = ghPrPlugin.renderView!({
    pluginSettings,
    close: () => {},
    sessions: [],
    workspaces: [],
    selectSession: () => {},
    sessionApi: () => undefined,
    appState: {},
    updateAppState: vi.fn(),
  } as unknown as Parameters<NonNullable<typeof ghPrPlugin.renderView>>[0]);
  await act(async () => root.render(<I18nProvider i18n={i18n}>{view}</I18nProvider>));
  // MrDescription parses markdown in a lazy chunk.
  await act(async () => new Promise((r) => setTimeout(r, 50)));
}

it('lists a PR requested from my team under review, with its row action', async () => {
  // Requested from a team I'm on: reviewRequests only names another user.
  answer({
    data: {
      viewer: { login: 'me' },
      assigned: { nodes: [] },
      authored: { nodes: [] },
      review: { nodes: [node(7, { reviewRequests: { nodes: [{ requestedReviewer: { login: 'carol' } }, { requestedReviewer: {} }] } })] },
    },
  });
  await refreshPrOverview();
  await render();
  expect(host.textContent).toContain('title 7');
  expect(host.querySelector('[data-testid="review-btn"]')).not.toBeNull();
});

it('keeps partial results and shows a warning when an org withholds some', async () => {
  answer({
    data: {
      viewer: { login: 'me' },
      assigned: { nodes: [] },
      authored: { nodes: [node(8, { author: { login: 'me' } }), null] },
      review: { nodes: [] },
    },
    errors: [{ message: 'Resource protected by organization SAML enforcement.' }],
  });
  await refreshPrOverview();
  await render();
  expect(host.textContent).toContain('title 8');
  expect(host.querySelector('[role="status"]')?.textContent).toContain('SAML enforcement');
  expect(host.textContent).not.toContain('Failed to load pull requests');
});

it('names truncated output instead of a parse error, without the auth hint', async () => {
  answer('{"data":{"viewer":{"login":"me"},"assigned":{"nodes":[\n[axn-term: output truncated at 1048576 bytes]');
  await refreshPrOverview();
  await render();
  expect(host.textContent).toContain('Failed to load pull requests');
  expect(host.textContent).toContain('gh output too large');
  expect(host.textContent).not.toContain('gh auth status');
});

it('keeps the auth hint for ordinary gh errors', async () => {
  bindAppRuntime({
    exec: async () => {
      throw new Error('error connecting to api.github.com');
    },
    statPath: async () => null,
    resolveSessionId: () => null,
  });
  await refreshPrOverview();
  await render();
  expect(host.textContent).toContain('Failed to load pull requests');
  expect(host.textContent).toContain('gh auth status');
});
