// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { ShellSession, Workspace } from '../../types';
import { StoryShellProviders } from '../storyMocks';
import { TagFilter } from './TagFilter';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
});

const session = (id: string, tags: string[]) =>
  ({ id, workspaceId: 'w', name: id, pluginState: { tagging: { tags } } }) as unknown as ShellSession;
const workspace = (id: string, tags: string[]) =>
  ({ id, name: id, collapsed: false, pluginState: { tagging: { tags } } }) as unknown as Workspace;

async function renderFilter({
  value = null,
  sessions = [],
  workspaces = [],
  pluginSettings = {},
  onChange = vi.fn(),
}: {
  value?: string | null;
  sessions?: ShellSession[];
  workspaces?: Workspace[];
  pluginSettings?: Record<string, unknown>;
  onChange?: (val: string | null) => void;
} = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <StoryShellProviders>
        <TagFilter
          value={value}
          onChange={onChange}
          sessions={sessions}
          workspaces={workspaces}
          pluginSettings={pluginSettings}
        />
      </StoryShellProviders>,
    ),
  );
  return { container, onChange };
}

it('renders nothing when no tags exist on sessions or workspaces', async () => {
  const { container } = await renderFilter({
    sessions: [session('s1', [])],
    workspaces: [workspace('w1', [])],
  });
  expect(container.children.length).toBe(0);
});

it('renders "All" and tag chips when tags exist', async () => {
  const { container } = await renderFilter({
    sessions: [session('s1', ['frontend'])],
    workspaces: [workspace('w1', ['backend'])],
  });
  const buttons = [...container.querySelectorAll('button')];
  expect(buttons.map((b) => b.textContent?.trim())).toEqual(['All', 'backend', 'frontend']);
});

it('clicking a tag chip calls onChange with that tag', async () => {
  const onChange = vi.fn();
  const { container } = await renderFilter({
    sessions: [session('s1', ['frontend'])],
    onChange,
  });
  const chip = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('frontend'));
  expect(chip).toBeDefined();
  await act(async () => chip?.click());
  expect(onChange).toHaveBeenCalledWith('frontend');
});

it('clicking the active tag chip deselects it (calls onChange(null))', async () => {
  const onChange = vi.fn();
  const { container } = await renderFilter({
    value: 'frontend',
    sessions: [session('s1', ['frontend'])],
    onChange,
  });
  const chip = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('frontend'));
  expect(chip?.getAttribute('aria-pressed')).toBe('true');
  await act(async () => chip?.click());
  expect(onChange).toHaveBeenCalledWith(null);
});

it('clicking "All" deselects the current tag', async () => {
  const onChange = vi.fn();
  const { container } = await renderFilter({
    value: 'frontend',
    sessions: [session('s1', ['frontend'])],
    onChange,
  });
  const allBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'All');
  expect(allBtn).toBeDefined();
  await act(async () => allBtn?.click());
  expect(onChange).toHaveBeenCalledWith(null);
});

it('keeps a dimmed, clearable chip for a selected tag that is no longer in use', async () => {
  const onChange = vi.fn();
  const { container } = await renderFilter({
    value: 'gone',
    sessions: [session('s1', ['frontend'])],
    onChange,
  });
  const chip = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('gone'));
  expect(chip).toBeDefined();
  expect(chip?.getAttribute('aria-pressed')).toBe('true');
  expect(chip?.className).toContain('opacity-60');
  await act(async () => chip?.click());
  expect(onChange).toHaveBeenCalledWith(null);
});

it('still renders the row when the last tag vanishes while selected', async () => {
  const { container } = await renderFilter({
    value: 'gone',
    sessions: [session('s1', [])],
  });
  const chip = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('gone'));
  expect(chip).toBeDefined();
});

it('treats a whitespace-only filter value as no selection', async () => {
  const { container } = await renderFilter({
    value: '   ',
    sessions: [session('s1', ['frontend'])],
  });
  const buttons = [...container.querySelectorAll('button')];
  expect(buttons.map((b) => b.textContent?.trim())).toEqual(['All', 'frontend']);
});
