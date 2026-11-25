// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { StoryShellProviders } from '../storyMocks';
import { scratchpadPlugin } from './scratchpad';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
});

async function renderCard() {
  const openTab = vi.fn();
  const ctx = {
    pluginSettings: {},
    pluginState: { currentDrafts: [{ dir: 'd', name: 'AIACC-1-a.md', path: '/x/AIACC-1-a.md' }] },
    openTab,
  };
  const field = scratchpadPlugin.sessionFields!.find((f) => f.id === 'currentDrafts')!;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<StoryShellProviders>{field.value(ctx as never) as never}</StoryShellProviders>));
  return openTab;
}

const draft = () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'AIACC-1-a.md')!;

it('opens a current draft as a preview on click', async () => {
  const openTab = await renderCard();
  await act(async () => (draft() as HTMLButtonElement).click());
  expect(openTab).toHaveBeenCalledWith({ path: '/x/AIACC-1-a.md', kind: 'preview' });
});

it('right-click offers preview, edit and copy path', async () => {
  const openTab = await renderCard();
  await act(async () => {
    draft().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 4, clientY: 4 }));
  });
  const labels = [...document.body.querySelectorAll('button')].map((b) => b.textContent);
  expect(labels).toEqual(expect.arrayContaining(['Open preview', 'Edit', 'Copy path']));
  const edit = [...document.body.querySelectorAll('button')].find((b) => b.textContent === 'Edit')!;
  await act(async () => (edit as HTMLButtonElement).click());
  expect(openTab).toHaveBeenCalledWith({ path: '/x/AIACC-1-a.md', kind: 'editor' });
});
