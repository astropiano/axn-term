// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { ShellSession } from '../../types';
import { StoryShellProviders } from '../storyMocks';
import { ScratchpadView } from './scratchpad';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
});

const NOW = Date.now();
const HOUR = 3_600_000;

/** A session in `/work/<name>` whose remote is `<project>` and whose drafts are `files` (name → age in ms). */
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
  const openTab = vi.fn();
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
    listDir: async () =>
      Object.keys(files).map((n) => ({ name: n, isFile: true, isDirectory: false, isSymlink: false })),
    openTab,
  };
  return { session, api, openTab };
}

async function render(fixtures: ReturnType<typeof fixture>[]) {
  const selectSession = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <StoryShellProviders>
        <ScratchpadView
          sessions={fixtures.map((f) => f.session)}
          sessionApi={(id) => fixtures.find((f) => f.session.id === id)?.api as never}
          selectSession={selectSession}
        />
      </StoryShellProviders>,
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return selectSession;
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
  expect(container.querySelector('select[aria-label="Repo"]')).not.toBeNull();
});

it('hides the repo filter when only one repo has drafts', async () => {
  await render([fixture('only-1', 'only', { 'a.md': HOUR })]);
  expect(container.querySelector('select[aria-label="Repo"]')).toBeNull();
});

it('filters by repo', async () => {
  await render([
    fixture('zeta-1', 'zeta', { 'plan.md': HOUR }),
    fixture('alpha-1', 'alpha', { 'notes.md': HOUR }),
  ]);
  const select = container.querySelector('select[aria-label="Repo"]') as HTMLSelectElement;
  await act(async () => {
    select.value = 'zeta';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(rows().map((r) => r.textContent)).toEqual([expect.stringContaining('plan.md')]);
});

it('opens a draft as preview from the context menu in its session', async () => {
  const f = fixture('only-1', 'only', { 'a.md': HOUR });
  const selectSession = await render([f]);
  await act(async () => {
    rows()[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
  });
  const item = [...document.body.querySelectorAll('button')].find((b) => b.textContent === 'Open preview')!;
  await act(async () => item.click());
  expect(f.openTab).toHaveBeenCalledWith({ path: '/work/only-1/.local-drafts/a.md', kind: 'preview' });
  expect(selectSession).toHaveBeenCalledWith('only-1');
});
