import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import type { DirEntry, SessionBackend } from '@axn-term/session-backend';
import { SessionBackendProvider } from '../services';
import { storyBackend, StoryShellProviders } from './storyMocks';
import { FilePickerModal } from './FilePickerModal';

/** Canned fs for the picker stories — listDir over a fixed map. */
const FS: Record<string, DirEntry[]> = {
  '/home/story': [
    { name: 'Acme', isDirectory: true, isFile: false, isSymlink: false },
    { name: 'Documents', isDirectory: true, isFile: false, isSymlink: false },
    { name: '.config', isDirectory: true, isFile: false, isSymlink: false },
    { name: 'axn-term-state.json', isDirectory: false, isFile: true, isSymlink: false },
    { name: 'notes.txt', isDirectory: false, isFile: true, isSymlink: false },
  ],
  '/home/story/Acme': [
    { name: 'dev', isDirectory: true, isFile: false, isSymlink: false },
    { name: 'worktrees', isDirectory: true, isFile: false, isSymlink: false },
  ],
  '/home/story/Acme/dev': [
    { name: 'axn-term', isDirectory: true, isFile: false, isSymlink: false },
    { name: 'tassistant', isDirectory: true, isFile: false, isSymlink: false },
  ],
};

const pickerBackend: SessionBackend = {
  ...storyBackend,
  listDir: (_id, path) => Promise.resolve(FS[path] ?? []),
  statPath: (_id, _cwd, path) =>
    Promise.resolve({
      path,
      isDir: path in FS,
      isFile: !(path in FS),
    }),
};

function Demo({ mode, extensions }: { mode: 'file' | 'dir'; extensions?: string[] }) {
  const [open, setOpen] = useState(true);
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <div className="p-4">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs"
      >
        open picker
      </button>
      <div className="mt-2 font-mono text-xs text-[var(--text-secondary)]">
        picked: {picked ?? '—'}
      </div>
      {open && (
        <FilePickerModal
          mode={mode}
          sessionId="s1"
          extensions={extensions}
          onPick={(p) => {
            setPicked(p);
            setOpen(false);
          }}
          onCancel={() => setOpen(false)}
        />
      )}
    </div>
  );
}

const meta = {
  title: 'app/FilePickerModal',
  component: Demo,
  decorators: [
    (Story) => (
      <StoryShellProviders>
        <SessionBackendProvider backend={pickerBackend}>
          <Story />
        </SessionBackendProvider>
      </StoryShellProviders>
    ),
  ],
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

/** "New session in folder…" — files stay greyed, the footer picks the browsed dir. */
export const FolderPick: Story = { args: { mode: 'dir' } };

/** File mode — only matching extensions are pickable (e.g. a workspace set). */
export const FilePick: Story = { args: { mode: 'file', extensions: ['json'] } };
