// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanupEditor, container, edit, renderEditor, saveEditor } from './EditorView.testkit';
afterEach(cleanupEditor);

it('keeps edits made during a write dirty and saves them on the next save', async () => {
  let finish!: () => void;
  const fileService = { readFile: vi.fn(async () => 'disk'), writeFile: vi.fn(() => new Promise<void>((r) => { finish = r; })) };
  const onDirtyChange = vi.fn();
  await renderEditor({ path: '/note.txt', fileService, onDirtyChange });
  await edit('A');
  await saveEditor();
  await edit('B');
  await act(async () => finish());
  expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  expect(fileService.writeFile).toHaveBeenLastCalledWith('/note.txt', undefined, 'A');
  await saveEditor();
  await act(async () => finish());
  expect(fileService.writeFile).toHaveBeenLastCalledWith('/note.txt', undefined, 'B');
  expect(onDirtyChange).toHaveBeenLastCalledWith(false);
});

it('serializes keyboard saves while a write is in flight', async () => {
  let finish!: () => void;
  const fileService = { readFile: vi.fn(async () => ''), writeFile: vi.fn(() => new Promise<void>((r) => { finish = r; })) };
  await renderEditor({ path: '/note.txt', fileService });
  await edit('A');
  await saveEditor();
  await edit('B');
  await saveEditor();
  expect(fileService.writeFile).toHaveBeenCalledTimes(1);
  await act(async () => finish());
});

it('preserves dirty state and exposes failed writes', async () => {
  const onDirtyChange = vi.fn();
  await renderEditor({ path: '/note.txt', onDirtyChange, fileService: {
    readFile: async () => '', writeFile: async () => { throw new Error('disk full'); },
  } });
  await edit('A');
  await saveEditor();
  expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  expect(container.textContent).toContain('disk full');
});

it('does not clear a different file while the previous file finishes saving', async () => {
  let finish!: () => void;
  const onDirtyChange = vi.fn();
  const fileService = { readFile: async () => '', writeFile: () => new Promise<void>((r) => { finish = r; }) };
  await renderEditor({ path: '/a.txt', onDirtyChange, fileService });
  await edit('A');
  await saveEditor();
  await renderEditor({ path: '/b.txt', onDirtyChange, fileService });
  await edit('B');
  await act(async () => finish());
  expect(onDirtyChange).toHaveBeenLastCalledWith(true);
});
