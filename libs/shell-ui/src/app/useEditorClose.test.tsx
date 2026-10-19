// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useEditorClose } from './useEditorClose';
import type { EditorHandle } from './EditorView';
import type { EditorTab } from '../types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let guard: ReturnType<typeof useEditorClose>;
const container = document.createElement('div');
const tab: EditorTab = { id: 'editor', path: '/note.txt', kind: 'editor', dirty: true };
function Harness() { guard = useEditorClose(); return guard.dialog; }
async function mount(handle?: EditorHandle) {
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
  if (handle) guard.registerEditor(tab.id, handle);
}
async function click(label: string) {
  await act(async () => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label)!.click());
}
afterEach(async () => { await act(async () => root?.unmount()); });

it('closes clean editors and non-editor tabs immediately', async () => {
  await mount({ isDirty: () => false, save: vi.fn() });
  const close = vi.fn();
  await act(async () => guard.requestClose(tab, close));
  await act(async () => guard.requestClose({ ...tab, kind: 'shell' }, close));
  expect(close).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[role=dialog]')).toBeNull();
});

it.each(['Cancel', 'Discard'])('%s handles dirty edits without writing', async (choice) => {
  const save = vi.fn();
  const close = vi.fn();
  await mount({ isDirty: () => true, save });
  await act(async () => guard.requestClose(tab, close));
  expect(close).not.toHaveBeenCalled();
  expect(container.textContent).toContain(tab.path);
  await click(choice);
  expect(close).toHaveBeenCalledTimes(choice === 'Discard' ? 1 : 0);
  expect(save).not.toHaveBeenCalled();
});

it('waits for a successful save before removing the tab', async () => {
  let finish!: (saved: boolean) => void;
  let dirty = true;
  const save = vi.fn(() => new Promise<boolean>((r) => { finish = r; }));
  const close = vi.fn();
  await mount({ isDirty: () => dirty, save });
  await act(async () => guard.requestClose(tab, close));
  await click('Save');
  expect(close).not.toHaveBeenCalled();
  expect(Array.from(container.querySelectorAll('button')).every((b) => b.disabled)).toBe(true);
  dirty = false;
  await act(async () => finish(true));
  expect(close).toHaveBeenCalledOnce();
});

it.each(['failure', 'new edits'])('keeps the tab open after %s', async (reason) => {
  const close = vi.fn();
  await mount({ isDirty: () => true, save: async () => {
    if (reason === 'failure') throw new Error('disk full');
    return false;
  } });
  await act(async () => guard.requestClose(tab, close));
  await click('Save');
  expect(close).not.toHaveBeenCalled();
  expect(container.querySelector('[role=alert]')).not.toBeNull();
  await click('Cancel');
  expect(close).not.toHaveBeenCalled();
});

it('allows cancel or discard when a dirty editor is unmounted', async () => {
  const close = vi.fn();
  await mount();
  await act(async () => guard.requestClose(tab, close));
  await click('Save');
  expect(close).not.toHaveBeenCalled();
  expect(container.textContent).toContain('unavailable');
  await click('Discard');
  expect(close).toHaveBeenCalledOnce();
});

it('treats Escape as cancel', async () => {
  const close = vi.fn();
  await mount({ isDirty: () => true, save: vi.fn() });
  await act(async () => guard.requestClose(tab, close));
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
  expect(close).not.toHaveBeenCalled();
  expect(container.querySelector('[role=dialog]')).toBeNull();
});
