// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { StoryShellProviders } from '../storyMocks';
import { TagColorSettings } from './TagColorSettings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
});

async function open(settings: Record<string, unknown>) {
  const update = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <StoryShellProviders>
        <TagColorSettings settings={settings} update={update} />
      </StoryShellProviders>,
    ),
  );
  return update;
}

const byLabel = (label: string) => container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
const byPlaceholder = (p: string) => container.querySelector<HTMLInputElement>(`[placeholder="${p}"]`)!;
const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === text)!;

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('writes a typed tag with the chosen colour, keeping existing overrides', async () => {
  const update = await open({ colors: { old: '#111111' } });
  await type(byLabel('New tag colour'), '#abcdef');
  await type(byPlaceholder('Tag name'), ' Urgent ');
  await act(async () => button('Set colour').click());
  expect(update).toHaveBeenCalledWith({ colors: { old: '#111111', urgent: '#abcdef' } });
});

it('does not add a blank name', async () => {
  const update = await open({});
  await type(byPlaceholder('Tag name'), '   ');
  await act(async () => button('Set colour').click());
  expect(update).not.toHaveBeenCalled();
});

it('changes and resets an existing entry', async () => {
  const update = await open({ colors: { urgent: '#111111', other: '#222222' } });
  await type(byLabel('Colour of urgent'), '#333333');
  expect(update).toHaveBeenLastCalledWith({ colors: { urgent: '#333333', other: '#222222' } });
  await act(async () => byLabel('Reset colour of urgent').click());
  expect(update).toHaveBeenLastCalledWith({ colors: { other: '#222222' } });
});
