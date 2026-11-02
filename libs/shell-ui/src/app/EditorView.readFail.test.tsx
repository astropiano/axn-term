// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanupEditor, container, editors, edit, renderEditor, saveEditor } from './EditorView.testkit';
afterEach(cleanupEditor);

const saveButton = () => container.querySelector<HTMLButtonElement>('button[aria-label^="Save"]')!;

it('never writes the empty buffer back after a failed read', async () => {
  const fileService = {
    readFile: vi.fn(async () => { throw new Error('file too large (over 16 MB)'); }),
    writeFile: vi.fn(async () => {}),
  };
  await renderEditor({ path: '/big.log', fileService });
  expect(container.textContent).toContain('file too large');
  expect(container.textContent).toContain('saving disabled');
  await saveEditor(); // Ctrl+S inside the editor
  await act(async () => {
    container.firstElementChild!.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
  });
  expect(saveButton().disabled).toBe(true);
  expect(fileService.writeFile).not.toHaveBeenCalled();
});

it('stays read-only until the read finishes', async () => {
  let finish!: (text: string) => void;
  const fileService = {
    readFile: vi.fn(() => new Promise<string>((r) => { finish = r; })),
    writeFile: vi.fn(async () => {}),
  };
  await renderEditor({ path: '/slow.txt', fileService });
  const editor = editors[editors.length - 1] as unknown as { updateOptions: ReturnType<typeof vi.fn> };
  await saveEditor();
  expect(fileService.writeFile).not.toHaveBeenCalled();
  await act(async () => finish('disk'));
  expect(editor.updateOptions).toHaveBeenCalledWith({ readOnly: false });
  expect(saveButton().disabled).toBe(false);
  await edit('changed');
  await saveEditor();
  expect(fileService.writeFile).toHaveBeenCalledWith('/slow.txt', undefined, 'changed');
});
