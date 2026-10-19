// monaco-editor's package.json `exports` map only exposes the bare specifier
// and does not resolve deep `monaco-editor/esm/vs/*` paths, which our trimmed
// monaco.main.ts entry imports directly (vite resolves them fine). Map every
// deep import back to the main module's type surface.
declare module 'monaco-editor/esm/vs/*' {
  import * as monaco from 'monaco-editor';
  export = monaco;
}
