import type { Meta, StoryObj } from '@storybook/react-vite';
import { StoryShellProviders } from './storyMocks';
import { EditorView } from './lazyViews';
import type { FileService } from './fileService';

const CONTENTS =
  'export function main() {\n  const needle = "find me";\n  console.log(needle, needle, needle);\n}\n\nmain();\n';
const FILES = new Map<string, string>([['/repo/src/index.ts', CONTENTS]]);

const fileService: FileService = {
  readFile: (path) => Promise.resolve(FILES.get(path) ?? ''),
  writeFile: (path, _cwd, contents) => {
    FILES.set(path, contents);
    return Promise.resolve();
  },
};

function EditorStory() {
  return (
    <div className="h-[480px] w-[640px] border border-[var(--border)]">
      <EditorView path="/repo/src/index.ts" isVisible fileService={fileService} />
    </div>
  );
}

const meta: Meta<typeof EditorStory> = {
  title: 'app/EditorView',
  component: EditorStory,
  decorators: [(Story) => <StoryShellProviders><Story /></StoryShellProviders>],
};
export default meta;

type Story = StoryObj<typeof EditorStory>;

export const Plain: Story = {};
