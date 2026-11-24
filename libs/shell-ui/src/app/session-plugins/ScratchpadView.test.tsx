// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { ShellSession } from '../../types';
import { StoryShellProviders } from '../storyMocks';
import { ScratchpadView, resetScratchpadCache, scratchpadPlugin } from './scratchpad';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  resetScratchpadCache();
});

const NOW = Date.now();
const HOUR = 3_600_000;

/** A session in `/work/<name>` whose remote is `<project>` and whose drafts are `files` (name → age in ms). */
const listed = { count: 0 };

function fixture(name: string, project: string, files: Record<string, number>) {
  const dir = `/work/${name}/.local-drafts`;
  const session = {
    id: name,
    workspaceId: 'w',
    name,
    cwd: `/work/${name}`,
    repo: { root: `/work/${name}`, branch: 'main', remote: `git@h:g/${project}.git` },
    pluginState: {},
  } as unknown as ShellSession;
  const api = {
    session,
    pluginSettings: { patterns: '*: .local-drafts' },
    getSession: () => session,
    getCwd: async () => session.cwd,
    exec: async () => '',
    statPath: async (path: string) => {
      if (path === '.local-drafts') return { path: dir, isFile: false, isDir: true };
      const file = path.split('/').pop() ?? '';
      return file in files ? { path, isFile: true, isDir: false, modifiedAt: NOW - files[file] } : null;
    },
    listDir: async () => {
      listed.count += 1;
      return Object.keys(files).map((n) => ({ name: n, isFile: true, isDirectory: false, isSymlink: false }));
    },
  };
  return { session, api };
}

async function render(fixtures: ReturnType<typeof fixture>[]) {
  const openTab = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await mount(fixtures, openTab);
  return openTab;
}

async function mount(fixtures: ReturnType<typeof fixture>[], openTab: (tab: { path: string; kind: "editor" | "browser" | "preview" }) => void) {
  await act(async () => {
    root!.render(
      <StoryShellProviders>
        <ScratchpadView
          sessions={fixtures.map((f) => f.session)}
          sessionApi={(id) => fixtures.find((f) => f.session.id === id)?.api as never}
          openTab={openTab}
        />
      </StoryShellProviders>,
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const rows = () =>
  [...container.querySelectorAll('button')].filter((b) => b.textContent?.includes('.md'));

it('groups by repo name, newest first, shows ages, and offers the repo filter only with several repos', async () => {
  await render([
    fixture('zeta-1', 'zeta', { 'old.md': 5 * 24 * HOUR, 'new.md': 2 * HOUR }),
    fixture('alpha-1', 'alpha', { 'a.md': HOUR }),
  ]);
  const text = container.textContent ?? '';
  expect(text.indexOf('alpha')).toBeLessThan(text.indexOf('zeta'));
  expect(rows().map((r) => r.textContent)).toEqual([
    expect.stringContaining('a.md'),
    expect.stringContaining('new.md'),
    expect.stringContaining('old.md'),
  ]);
  expect(rows()[1].textContent).toContain('2h ago');
  expect(rows()[2].textContent).toContain('5d ago');
  expect(container.querySelector('button[aria-label="Repo"]')).not.toBeNull();
});

it('hides the repo filter when only one repo has drafts', async () => {
  await render([fixture('only-1', 'only', { 'a.md': HOUR })]);
  expect(container.querySelector('button[aria-label="Repo"]')).toBeNull();
});

it('filters by repo', async () => {
  await render([
    fixture('zeta-1', 'zeta', { 'plan.md': HOUR }),
    fixture('alpha-1', 'alpha', { 'notes.md': HOUR }),
  ]);
  expect(container.querySelector('select')).toBeNull();
  await act(async () => (container.querySelector('button[aria-label="Repo"]') as HTMLButtonElement).click());
  const zeta = [...document.body.querySelectorAll('[role="option"]')].find((o) => o.textContent?.includes('zeta'))!;
  await act(async () => (zeta as HTMLButtonElement).click());
  expect(rows().map((r) => r.textContent)).toEqual([expect.stringContaining('plan.md')]);
});

it('opens a draft as a preview tab inside the view from the context menu', async () => {
  const openTab = await render([fixture('only-1', 'only', { 'a.md': HOUR })]);
  await act(async () => {
    rows()[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
  });
  const item = [...document.body.querySelectorAll('button')].find((b) => b.textContent === 'Open preview')!;
  await act(async () => item.click());
  expect(openTab).toHaveBeenCalledWith({ path: '/work/only-1/.local-drafts/a.md', kind: 'preview' });
});

it('opens a draft as a preview tab on click', async () => {
  const openTab = await render([fixture('only-1', 'only', { 'a.md': HOUR })]);
  await act(async () => rows()[0].click());
  expect(openTab).toHaveBeenCalledWith({ path: '/work/only-1/.local-drafts/a.md', kind: 'preview' });
});

it('the context menu offers preview, edit and copy path (reveal only where the platform has it)', async () => {
  const openTab = await render([fixture('only-1', 'only', { 'a.md': HOUR })]);
  await act(async () => {
    rows()[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
  });
  const labels = () => [...document.body.querySelectorAll('button')].map((b) => b.textContent);
  expect(labels()).toEqual(expect.arrayContaining(['Open preview', 'Edit', 'Copy path']));
  const edit = [...document.body.querySelectorAll('button')].find((b) => b.textContent === 'Edit')!;
  await act(async () => (edit as HTMLButtonElement).click());
  expect(openTab).toHaveBeenCalledWith({ path: '/work/only-1/.local-drafts/a.md', kind: 'editor' });
});

it('collapses and expands a repo from its header', async () => {
  await render([fixture('zeta-1', 'zeta', { 'plan.md': HOUR }), fixture('alpha-1', 'alpha', { 'notes.md': HOUR })]);
  const header = [...container.querySelectorAll('button[aria-expanded]')].find((b) => b.textContent?.includes('alpha'))!;
  await act(async () => (header as HTMLButtonElement).click());
  expect(rows().map((r) => r.textContent)).toEqual([expect.stringContaining('plan.md')]);
  expect(header.getAttribute('aria-expanded')).toBe('false');
  await act(async () => (header as HTMLButtonElement).click());
  expect(rows()).toHaveLength(2);
});

it('shows the last scan at once when the view is opened again, without rescanning', async () => {
  const fixtures = [fixture('only-1', 'only', { 'a.md': HOUR })];
  await render(fixtures);
  const scans = listed.count;
  expect(scans).toBeGreaterThan(0);
  await act(async () => root!.unmount());
  container.remove();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // First paint after remount already has the rows — no "Scanning…" state.
  await act(async () => {
    root!.render(
      <StoryShellProviders>
        <ScratchpadView
          sessions={fixtures.map((f) => f.session)}
          sessionApi={(id) => fixtures.find((f) => f.session.id === id)?.api as never}
          openTab={vi.fn()}
        />
      </StoryShellProviders>,
    );
  });
  expect(container.textContent).not.toContain('Scanning');
  expect(rows()).toHaveLength(1);
  expect(listed.count).toBe(scans);
});

it('the rail scans in the background, so the view opens with its list ready', async () => {
  const fixtures = [fixture('only-1', 'only', { 'a.md': HOUR })];
  const rail = scratchpadPlugin.renderRail!({
    backend: {} as never,
    pluginSettings: {},
    setAppAttention: () => {},
    viewActive: false,
    toggleView: () => {},
    appState: {},
    updateAppState: () => {},
    sessions: fixtures.map((f) => f.session),
    sessionApi: (id: string) => fixtures.find((f) => f.session.id === id)?.api as never,
  });
  const before = listed.count;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<StoryShellProviders>{rail}</StoryShellProviders>));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(listed.count).toBeGreaterThan(before);

  // Now the view opens: its very first paint already lists the draft.
  await act(async () => root!.unmount());
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <StoryShellProviders>
        <ScratchpadView
          sessions={fixtures.map((f) => f.session)}
          sessionApi={(id) => fixtures.find((f) => f.session.id === id)?.api as never}
          openTab={vi.fn()}
        />
      </StoryShellProviders>,
    );
  });
  expect(container.textContent).not.toContain('Scanning');
  expect(rows()).toHaveLength(1);
});
