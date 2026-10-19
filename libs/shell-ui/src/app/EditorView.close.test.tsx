// @vitest-environment happy-dom
import { editors } from './EditorView.testkit';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { EditorView } from './EditorView';
import { useEditorClose } from './useEditorClose';

it('keeps a real editor open for edits made during Save-and-close, then saves and closes', async () => {
  let finish!: () => void;
  let disk = '';
  const fileService = {
    readFile: async () => disk,
    writeFile: (_path: string, _cwd: string | undefined, contents: string) => new Promise<void>((resolve) => {
      finish = () => { disk = contents; resolve(); };
    }),
  };
  function Harness() {
    const [open, setOpen] = useState(true);
    const [dirty, setDirty] = useState(false);
    const guard = useEditorClose();
    return <>
      {open && <EditorView path="/note.txt" fileService={fileService} onDirtyChange={setDirty}
        ref={(handle) => guard.registerEditor('editor', handle)} />}
      <button onClick={() => guard.requestClose({ id: 'editor', path: '/note.txt', dirty }, () => setOpen(false))}>Close tab</button>
      {guard.dialog}
    </>;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  const click = async (label: string) => {
    await act(async () => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label)!.click());
  };
  try {
    await act(async () => root.render(<Harness />));
    const editor = editors[editors.length - 1];
    await act(async () => editor.setValue('A'));
    await click('Close tab');
    await click('Save');
    await act(async () => editor.setValue('B'));
    await act(async () => finish());
    expect(disk).toBe('A');
    expect(editor.dispose).not.toHaveBeenCalled();
    expect(container.querySelector('[role=dialog]')).not.toBeNull();
    await click('Save');
    await act(async () => finish());
    expect(disk).toBe('B');
    expect(editor.dispose).toHaveBeenCalledOnce();
    expect(container.querySelector('[role=dialog]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    editors.length = 0;
  }
});
