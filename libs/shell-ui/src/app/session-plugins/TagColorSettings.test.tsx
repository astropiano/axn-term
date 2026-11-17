// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { ShellSession, Workspace } from '../../types';
import { StoryShellProviders } from '../storyMocks';
import { TagColorSettings } from './TagColorSettings';
import { tagColor } from './taggingModel';

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

async function open(
  settings: Record<string, unknown>,
  sessions: ShellSession[] = [],
  workspaces: Workspace[] = [],
) {
  const update = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <StoryShellProviders>
        <TagColorSettings settings={settings} update={update} sessions={sessions} workspaces={workspaces} />
      </StoryShellProviders>,
    ),
  );
  return update;
}

const byLabel = (label: string) => container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const enter = (el: HTMLElement) =>
  act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });

it('lists every tag in use on sessions and workspaces, plus colour-only entries, once each', async () => {
  await open({ colors: { legacy: '#111111' } }, [session('a', ['Urgent', 'x']), session('b', ['urgent'])], [workspace('w', ['Team'])]);
  const names = [...container.querySelectorAll('span.truncate')].map((s) => s.textContent);
  expect(names).toEqual(['legacy', 'Team', 'Urgent', 'x']);
  // a derived colour is a theme slot: its swatch is pressed and the hex box is empty
  expect(byLabel(`Colour of Urgent: theme ${tagColor('Urgent')}`)!.getAttribute('aria-pressed')).toBe('true');
  expect(byLabel('Colour of Urgent (hex)')!.value).toBe('');
  expect(byLabel('Colour of legacy (hex)')!.value).toBe('#111111');
});

it('sets a tag colour from a typed hex, keeping other entries', async () => {
  const update = await open({ colors: { old: '#111111' } }, [session('a', ['Urgent'])]);
  const hex = byLabel('Colour of Urgent (hex)')!;
  await type(hex, '#ABCDEF');
  await enter(hex);
  expect(update).toHaveBeenCalledWith({ colors: { old: '#111111', urgent: '#abcdef' } });
});

it('accepts a pasted hex without #', async () => {
  const update = await open({}, [session('a', ['x'])]);
  const hex = byLabel('Colour of x (hex)')!;
  await act(async () => {
    const event = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    event.clipboardData = { getData: () => ' 0af ' };
    hex.dispatchEvent(event);
  });
  expect(update).toHaveBeenCalledWith({ colors: { x: '#0af' } });
});

it('ignores an invalid hex', async () => {
  const update = await open({}, [session('a', ['x'])]);
  const hex = byLabel('Colour of x (hex)')!;
  await type(hex, 'red');
  await enter(hex);
  expect(update).not.toHaveBeenCalled();
});

it('offers reset only for a tag with a set colour', async () => {
  const update = await open({ colors: { urgent: '#111111' } }, [session('a', ['urgent', 'x'])]);
  expect(byLabel('Reset colour of x')).toBeNull();
  await act(async () => (byLabel('Reset colour of urgent') as unknown as HTMLButtonElement).click());
  expect(update).toHaveBeenCalledWith({ colors: {} });
});

it('colours a tag not in use yet by name', async () => {
  const update = await open({});
  await type(container.querySelector<HTMLInputElement>('[placeholder="Tag name"]')!, ' Later ');
  const hex = byLabel('New tag colour (hex)')!;
  await type(hex, '#222222');
  await enter(hex);
  expect(update).toHaveBeenCalledWith({ colors: { later: '#222222' } });
});

it('picks a theme colour by slot name, so it follows the theme', async () => {
  const update = await open({}, [session('a', ['x'])]);
  const other = tagColor('x') === 'violet' ? 'green' : 'violet';
  await act(async () => (byLabel(`Colour of x: theme ${other}`) as unknown as HTMLButtonElement).click());
  expect(update).toHaveBeenCalledWith({ colors: { x: other } });
});
