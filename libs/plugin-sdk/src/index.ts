export * from './contract';
export * from './api';
export * from './hooks';
export * from './permissions';

/** Identity helper — gives full typechecking on a plugin manifest literal. */
export function definePluginManifest(manifest: import('./api').PluginManifest) {
  return manifest;
}

/** Strip ANSI escape sequences from a chunk of terminal output. */
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI_RE = new RegExp(
  `${ESC}(?:\\[[0-9;?]*[ -/]*[@-~]|\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)|[@-Z\\\\-_]|\\([A-Za-z0-9]|\\)[A-Za-z0-9])`,
  'g',
);

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape a string for interpolation into pushed HTML surfaces/views. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}
