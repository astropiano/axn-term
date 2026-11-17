// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionPanel } from './SessionPanel';
import { StoryShellProviders } from './storyMocks';
import { ShellServicesProvider } from '../services';
import type { ShellSession, Workspace } from '../types';
import { TINT_CLASS, TINT_HOVER_CLASS } from './session-plugins/tint';
import type { SessionViewPlugin } from './session-plugins/plugin';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const workspaces: Workspace[] = [{ id: 'ws-1', name: 'api', collapsed: false }];
const session = (id: string, name: string): ShellSession => ({
  id,
  workspaceId: 'ws-1',
  name,
  topic: '',
  summary: '',
  tasks: [],
  progress: 0,
  output: '',
});
const sessions = [session('s-1', 'server'), session('s-2', 'tests')];

let root: Root | undefined;
let container: HTMLDivElement;

afterEach(async () => {
  localStorage.removeItem('axn-term:settings');
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
});

async function render(props: Partial<ComponentProps<typeof SessionPanel>>) {
  const noop = () => {};
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <StoryShellProviders>
        <ShellServicesProvider services={{ copyText: noop, openExternal: noop }} fileReader={() => undefined}>
        <SessionPanel
          workspaces={workspaces}
          sessions={sessions}
          selectedSessionId="s-1"
          taskState={null}
          onSelectWorkspace={noop}
          onSelectSession={noop}
          onAddWorkspace={noop}
          onSaveWorkspaceSet={noop}
          onLoadWorkspaceSet={noop}
          onRenameWorkspace={noop}
          onDeleteWorkspace={noop}
          onToggleWorkspace={noop}
          updateWorkspace={noop}
          onAddSession={noop}
          onMoveSession={noop}
          onReorderWorkspace={noop}
          onMoveWorkspace={noop}
          onRenameSession={noop}
          onDuplicateSession={noop}
          onCloseSession={noop}
          updateSession={noop}
          mergePluginState={noop}
          plugins={[]}
          onOpenBrowser={noop}
          onOpenTab={noop}
          onOpenSubShell={() => undefined}
          onTurnIntoWorkspace={noop}
          pluginData={{}}
          mergePluginData={noop}
          {...props}
        />
        </ShellServicesProvider>
      </StoryShellProviders>,
    ),
  );
}

const colourPlugin = (id: string, over: Partial<SessionViewPlugin>): SessionViewPlugin => ({
  id,
  title: id,
  ...over,
});

const cards = () => [...container.querySelectorAll<HTMLElement>('div.relative.cursor-pointer')];
const header = () => container.querySelector<HTMLElement>('[data-tip$="right-click for options)"]')!;

it('tints the selected card body lighter than its solid title row, and an unselected card in between', async () => {
  await render({ plugins: [colourPlugin('c', { sessionColors: () => ['#ff0000'] })] });
  const [selected, idle] = cards();
  expect(selected.style.getPropertyValue('--tint')).toContain('#ff0000 var(--tint-selected-card, 50%)');
  const title = selected.querySelector<HTMLElement>('[class*="group/row"]')!;
  expect(title.style.getPropertyValue('--tint')).toContain('#ff0000 var(--tint-selected-title, 100%)');
  // the accent edge sits on an overlay over the whole card, above the solid row
  expect(selected.className).toContain('after:shadow-[inset_2px_0_0_0_var(--accent)');
  expect(title.className).not.toContain('inset_2px_0_0_0_var(--accent)');
  // the icon tile follows the row's contrast text, not the theme accent
  const icon = title.querySelector<HTMLElement>('span.rounded-\\[6px\\]')!;
  expect(icon.className).toContain('text-[var(--text-primary)]');
  expect(icon.className).not.toContain('text-[var(--accent)]');
  // #ff0000: 5.3:1 against black beats 4.0:1 against white
  expect(title.style.getPropertyValue('--text-primary')).toBe('#111111');
  expect(idle.style.getPropertyValue('--tint')).toContain('#ff0000 var(--tint-card, 32%)');
  expect(idle.querySelector<HTMLElement>('[class*="group/row"]')!.style.getPropertyValue('--tint')).toBe('');
});

it('keeps hover feedback on a tinted card: the hover fill layers over the tint', async () => {
  await render({ plugins: [colourPlugin('c', { sessionColors: () => ['#ff0000'] })] });
  const [selected, idle] = cards();
  expect(idle.className).toContain(TINT_CLASS);
  expect(idle.className).toContain(TINT_HOVER_CLASS);
  expect(idle.style.backgroundImage).toBe('');
  expect(selected.className).not.toContain(TINT_HOVER_CLASS);
});

it('keeps the plain hover on an untinted card', async () => {
  await render({ plugins: [] });
  const idle = cards()[1];
  expect(idle.className).toContain('hover:bg-[var(--fill-1)]');
  expect(idle.className).not.toContain(TINT_CLASS);
});

it('tints the whole workspace block faintly, behind its sessions, even when it holds the selected session', async () => {
  const workspaceColors = vi.fn(() => ['#00ff00']);
  await render({ plugins: [colourPlugin('c', { workspaceColors })] });
  const block = header().closest<HTMLElement>('[data-workspace-block]')!;
  expect(block.style.getPropertyValue('--tint')).toContain('#00ff00 var(--tint-workspace, 20%)');
  expect(block.contains(cards()[0])).toBe(true);
  expect(block.className).toContain('-mx-1 ');
  expect(header().style.getPropertyValue('--tint')).toBe('');
  expect(workspaceColors).toHaveBeenCalledWith(expect.objectContaining({ workspace: workspaces[0] }));
});

it('combines colours of several plugins in plugin order', async () => {
  await render({
    plugins: [
      colourPlugin('a', { sessionColors: () => ['#ff0000'] }),
      colourPlugin('b', { sessionColors: () => ['#00ff00'] }),
    ],
  });
  const css = cards()[0].style.getPropertyValue('--tint');
  expect(css.indexOf('#ff0000')).toBeGreaterThan(-1);
  expect(css.indexOf('#ff0000')).toBeLessThan(css.indexOf('#00ff00'));
});

it('ignores a throwing hook and colours that are neither hex nor a theme slot', async () => {
  await render({
    plugins: [
      colourPlugin('a', {
        sessionColors: () => {
          throw new Error('boom');
        },
        workspaceColors: () => {
          throw new Error('boom');
        },
      }),
      colourPlugin('b', { sessionColors: () => ['nope', 'url(x)'] }),
    ],
  });
  expect(cards()).toHaveLength(2);
  for (const card of cards()) expect(card.style.getPropertyValue('--tint')).toBe('');
  expect(header().style.getPropertyValue('--tint')).toBe('');
});

it('adds no background-image without colour hooks', async () => {
  await render({ plugins: [] });
  for (const card of cards()) expect(card.style.getPropertyValue('--tint')).toBe('');
  expect(header().style.getPropertyValue('--tint')).toBe('');
});

it('draws a theme slot colour in the active theme\'s shade', async () => {
  await render({ plugins: [colourPlugin('c', { sessionColors: () => ['blue'] })] });
  const css = cards()[1].style.getPropertyValue('--tint');
  expect(css).toMatch(/color-mix\(in srgb, #[0-9a-f]{3,8} var\(--tint-card, 32%\)/i);
  expect(css).not.toContain('blue');
});
