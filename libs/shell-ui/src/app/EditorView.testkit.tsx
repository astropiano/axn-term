import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { vi } from 'vitest';

const { editors, createEditor } = vi.hoisted(() => {
  const editors: Array<{
    getValue: () => string;
    setValue: (text: string) => void;
    dispose: ReturnType<typeof vi.fn>;
    command?: () => void;
    commands: Array<{ key: number; cb: () => void }>;
  }> = [];
  const createEditor = vi.fn(() => {
    let value = '';
    let changed = () => {};
    const editor = {
      getValue: () => value,
      setValue: (text: string) => { value = text; changed(); },
      onDidChangeModelContent: (cb: () => void) => { changed = cb; return { dispose: vi.fn() }; },
      addCommand: (key: number, cb: () => void) => {
        editor.command = cb;
        editor.commands.push({ key, cb });
      },
      command: undefined as (() => void) | undefined,
      commands: [] as Array<{ key: number; cb: () => void }>,
      layout: vi.fn(),
      updateOptions: vi.fn(),
      dispose: vi.fn(),
    };
    editors.push(editor);
    return editor;
  });
  return { editors, createEditor };
});
export { editors, createEditor };
vi.mock('./monacoSetup', () => ({
  monaco: {
    editor: { create: createEditor },
    KeyMod: { CtrlCmd: 1, WinCtrl: 4, Shift: 8 },
    KeyCode: { KeyS: 16, KeyF: 32 },
  },
  applyAxnMonacoTheme: vi.fn(), languageForPath: () => 'text', AXN_MONACO_THEME: 'test',
}));
vi.mock('../SettingsProvider', () => ({ useSettings: () => ({ activeTheme: {} }) }));
import { EditorView } from './EditorView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
export const container = document.createElement('div');
export async function renderEditor(props: ComponentProps<typeof EditorView>) {
  root ??= createRoot(container);
  await act(async () => { root!.render(<EditorView {...props} />); });
}
export async function cleanupEditor() {
  await act(async () => root?.unmount());
  root = undefined;
  editors.length = 0;
  createEditor.mockClear();
}
export async function edit(text: string) {
  await act(async () => editors[editors.length - 1].setValue(text));
}
export async function saveEditor() {
  const editor = editors[editors.length - 1];
  // The editor binds several chords — save is the one carrying KeyS.
  const cmd = editor.commands.find((c) => (c.key & 16) === 16);
  await act(async () => (cmd ?? { cb: editor.command }).cb?.());
}
