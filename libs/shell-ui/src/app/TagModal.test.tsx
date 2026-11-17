// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { TagModal } from './TagModal';
import type { TagRequest } from './tagHost';
import { StoryShellProviders } from './storyMocks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
});

async function open(over: Partial<TagRequest> = {}) {
  const onApply = vi.fn();
  const onClose = vi.fn();
  const request: TagRequest = { title: 't', targets: [['x', 'y'], ['x'], []], others: [['z']], onApply: () => {}, ...over };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <StoryShellProviders>
        <TagModal request={request} onApply={onApply} onClose={onClose} />
      </StoryShellProviders>,
    ),
  );
  return { onApply, onClose };
}

const box = (name: string) => container.querySelector<HTMLInputElement>(`input[type="checkbox"][aria-label="${name}"]`)!;
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const input = () => container.querySelector<HTMLInputElement>('input[type="text"]')!;
const applyButton = () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Apply')!;

async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const enter = (el: HTMLElement) =>
  act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });

it('shows tri-state: all / some / none across targets, including others', async () => {
  await open();
  expect(box('x').checked).toBe(false);
  expect(box('x').indeterminate).toBe(true);
  expect(box('y').indeterminate).toBe(true);
  expect(box('z').checked).toBe(false);
  expect(box('z').indeterminate).toBe(false);
});

it('clicking a some row sets all targets, clicking an all row clears them', async () => {
  const { onApply } = await open();
  await act(async () => box('x').click());
  expect(box('x').checked).toBe(true);
  await act(async () => applyButton().click());
  expect(onApply).toHaveBeenCalledWith([['x', 'y'], ['x'], ['x']]);
});

it('ignores a blank typed tag and adds a typed one to every target', async () => {
  const { onApply } = await open();
  await type(input(), '   ');
  await enter(input());
  expect(onApply).not.toHaveBeenCalled();
  await type(input(), 'New');
  await enter(input());
  expect(box('New').checked).toBe(true);
  await enter(input());
  expect(onApply).toHaveBeenCalledTimes(1);
  expect(onApply).toHaveBeenCalledWith([['x', 'y', 'New'], ['x', 'New'], ['New']]);
});

it('rename and delete act on the opened targets only', async () => {
  const { onApply } = await open();
  await act(async () => button('Delete y').click());
  await act(async () => button('Rename x').click());
  const field = container.querySelector<HTMLInputElement>('input[aria-label="New name for x"]')!;
  await type(field, 'w');
  await enter(field);
  await act(async () => applyButton().click());
  expect(onApply).toHaveBeenCalledTimes(1);
  expect(onApply).toHaveBeenCalledWith([['w'], ['w'], []]);
  // the other carrier's tag is untouched and still offered
  expect(box('z')).not.toBeNull();
});

it('closes without applying on Cancel', async () => {
  const { onApply, onClose } = await open();
  await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!.click());
  expect(onClose).toHaveBeenCalled();
  expect(onApply).not.toHaveBeenCalled();
});
