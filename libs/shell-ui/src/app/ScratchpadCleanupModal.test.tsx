// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ScratchpadCleanupModal } from './ScratchpadCleanupModal';
import { StoryShellProviders } from './storyMocks';
import type { DraftEntry } from './session-plugins/scratchpadDrafts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
});

const NOW = Date.parse('2026-11-23T12:00:00Z');
const day = 24 * 60 * 60 * 1000;
const entry = (name: string, ageDays?: number): DraftEntry => ({
  repo: 'r',
  dir: 'd',
  inRepo: true,
  name,
  path: `/r/${name}`,
  modifiedAt: ageDays === undefined ? undefined : NOW - ageDays * day,
  sessionId: 's',
});

async function render(entries: DraftEntry[], onConfirm = vi.fn(async () => {})) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <StoryShellProviders>
        <ScratchpadCleanupModal entries={entries} scope="all repos" onCancel={() => {}} onConfirm={onConfirm} now={NOW} />
      </StoryShellProviders>,
    ),
  );
  return onConfirm;
}

const text = () => container.querySelector('[data-testid="cleanup-count"]')!.textContent;

it('says how many drafts the chosen age moves to the trash, and updates with the age', async () => {
  await render([entry('a', 20), entry('b', 5), entry('c', 100), entry('d')]);
  expect(text()).toBe('2 drafts older than 2 weeks in all repos will be moved to the trash.');
  expect(container.querySelector('select')).toBeNull();
  await act(async () => (container.querySelector('button[aria-label="Older than"]') as HTMLButtonElement).click());
  const threeMonths = [...document.body.querySelectorAll('[role="option"]')].find((o) => o.textContent === '3 months')!;
  await act(async () => (threeMonths as HTMLButtonElement).click());
  expect(text()).toBe('1 draft older than 3 months in all repos will be moved to the trash.');
  expect(container.textContent).toContain('1 draft of unknown age is kept.');
});

it('confirms with exactly the picked drafts and disables when none match', async () => {
  const onConfirm = await render([entry('a', 20), entry('b', 5)]);
  const confirm = [...container.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Move 1'))!;
  await act(async () => confirm.click());
  expect(onConfirm).toHaveBeenCalledWith([expect.objectContaining({ name: 'a' })]);
});

it('disables the button when nothing is old enough', async () => {
  await render([entry('b', 1)]);
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Move to trash')!;
  expect(button.disabled).toBe(true);
  expect(text()).toBe('No drafts older than 2 weeks in all repos.');
});
