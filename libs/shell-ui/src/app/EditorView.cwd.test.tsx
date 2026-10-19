// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanupEditor, createEditor, edit, editors, renderEditor, saveEditor } from './EditorView.testkit';
afterEach(cleanupEditor);

it.each(['/original/note.txt', 'note.txt'])('keeps the buffer and save target across cd: %s', async (path) => {
  const fileService = { readFile: vi.fn(async () => 'disk'), writeFile: vi.fn(async () => {}) };
  const onDirtyChange = vi.fn();
  await renderEditor({ path, cwd: '/original', fileService, onDirtyChange });
  await edit('unsaved');
  await renderEditor({ path, cwd: '/elsewhere', fileService: { ...fileService }, onDirtyChange });
  expect(createEditor).toHaveBeenCalledTimes(1);
  expect(editors[0].getValue()).toBe('unsaved');
  expect(fileService.readFile).toHaveBeenCalledTimes(1);
  expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  await saveEditor();
  expect(fileService.writeFile).toHaveBeenLastCalledWith('/original/note.txt', undefined, 'unsaved');
});
