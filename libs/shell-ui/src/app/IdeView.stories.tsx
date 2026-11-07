import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import type { SessionBackend } from '@axn-term/session-backend';
import { SessionBackendProvider } from '../services';
import { StoryShellProviders, storyBackend } from './storyMocks';
import { IdeView } from './lazyViews';
import { resolvePath, type FileService } from './fileService';

// --- Canned in-memory fs: dirs → entries, files → contents -----------------

const FILES = new Map<string, string>([
  ['/repo/README.md', '# axn-term\n\nA terminal with IDE tabs.\n'],
  [
    '/repo/src/index.ts',
    'export function main() {\n  console.log("hello");\n}\n\nmain();\n',
  ],
  [
    '/repo/src/util/paths.ts',
    'export function join(a: string, b: string) {\n  return a + "/" + b;\n}\n',
  ],
  ['/repo/package.json', '{\n  "name": "repo",\n  "version": "0.0.0"\n}\n'],
  ['/repo/.env', 'TOKEN=secret\n'],
]);

const DIRS: Record<string, string[]> = {
  '/repo': ['src', 'docs', '.git', 'README.md', 'package.json', '.env'],
  '/repo/src': ['util', 'index.ts'],
  '/repo/src/util': ['paths.ts'],
  '/repo/docs': [],
  '/repo/.git': ['HEAD'],
};

function isDir(p: string) {
  return p in DIRS;
}

const fsBackend: SessionBackend = {
  ...storyBackend,
  listDir: (_id, path) =>
    Promise.resolve(
      (DIRS[resolvePath(undefined, path)] ?? []).map((name) => {
        const abs = `${path.replace(/\/$/, '')}/${name}`;
        return { name, isDirectory: isDir(abs), isFile: !isDir(abs) };
      }),
    ),
  statPath: (_id, _cwd, path) =>
    Promise.resolve(
      isDir(path) || FILES.has(path)
        ? { path, isDir: isDir(path), isFile: FILES.has(path) }
        : null,
    ),
  fsExists: (_id, path) => Promise.resolve(isDir(path) || FILES.has(path)),
  mkdir: () => Promise.resolve(),
  writeFile: () => Promise.resolve({ ok: true }),
  readFile: (_id, path) =>
    Promise.resolve(
      FILES.has(path) ? { ok: true, contents: FILES.get(path) } : { ok: false, error: 'ENOENT' },
    ),
  watchDir: () => () => {},
};

const fsFileService: FileService = {
  readFile: (path) => Promise.resolve(FILES.get(resolvePath(undefined, path)) ?? ''),
  writeFile: (path, _cwd, contents) => {
    FILES.set(resolvePath(undefined, path), contents);
    return Promise.resolve();
  },
};

function IdeStory() {
  const backend = useMemo(() => fsBackend, []);
  return (
    <div className="h-[480px] w-[640px] border border-[var(--border)]">
      <SessionBackendProvider backend={backend}>
        <IdeView path="/repo" sessionId="s1" isVisible fileService={fsFileService} />
      </SessionBackendProvider>
    </div>
  );
}

const meta: Meta<typeof IdeStory> = {
  title: 'app/IdeView',
  component: IdeStory,
  decorators: [(Story) => <StoryShellProviders><Story /></StoryShellProviders>],
};
export default meta;

type Story = StoryObj<typeof IdeStory>;

export const Plain: Story = {};
