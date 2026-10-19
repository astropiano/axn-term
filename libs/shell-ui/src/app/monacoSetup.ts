// Custom Monaco entry: full editor features with a trimmed language set
// (see monaco.main.ts). Workers are bundled and wired up by
// vite-plugin-monaco-editor-esm, which sets `MonacoEnvironment` itself.
import * as monaco from './monaco.main';
import type { ThemeDefinition } from '../themes';

export const AXN_MONACO_THEME = 'axn-theme';

export function applyAxnMonacoTheme(theme: ThemeDefinition) {
  const c = theme.colors;
  const ui = theme.ui ?? {};
  monaco.editor.defineTheme(AXN_MONACO_THEME, {
    base: theme.mode === 'dark' ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': c.background,
      'editor.foreground': c.foreground,
      'editorCursor.foreground': c.cursor ?? c.foreground,
      'editor.selectionBackground': c.selectionBackground ?? ui.border ?? c.background,
      'editor.lineHighlightBackground': ui.surface ?? c.background,
      'editorLineNumber.foreground': ui.textSecondary ?? c.brightBlack ?? c.foreground,
      'editorLineNumber.activeForeground': c.foreground,
      'editorWidget.background': ui.surface ?? c.background,
      'editorWidget.border': ui.border ?? c.brightBlack ?? c.foreground,
      'minimap.background': c.background,
      'scrollbar.shadow': '#00000000',
    },
  });
  monaco.editor.setTheme(AXN_MONACO_THEME);
}

export function languageForPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  if (!ext) return 'plaintext';
  const match = monaco.languages
    .getLanguages()
    .find((l) => l.extensions?.includes(`.${ext}`));
  return match?.id ?? 'plaintext';
}

export { monaco };
