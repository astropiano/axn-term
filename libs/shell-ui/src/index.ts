/// <reference path="./monaco-esm.d.ts" />
/// <reference path="./asciidoctor.d.ts" />
export * from './types';
export * from './themes';
export * from './terminalLinks';
export * from './terminalRegistry';
export * from './platform';
export * from './imageMime';
export * from './services';
export * from './i18n';
export * from './SettingsProvider';
export * from './ContextMenu';
export * from './PathActionMenu';
export * from './ShellTerminal';

// Shared application chrome (desktop + web) — parameterized on
// SessionBackend/ShellServices/ShellPlatform, no direct Tauri imports.
export * from './app/ShellApp';
export * from './app/fileService';
export * from './app/scrollResync';
export * from './app/gitClient';
export * from './app/PluginSettingsProvider';
export { SettingsModal } from './app/SettingsModal';
export { ErrorBoundary } from './app/ErrorBoundary';
export * from './app/useMemoryStats';
export * from './app/attention';
export { windowRank, remoteSessionName, useWindowIds } from './app/windowPeers';
export * from './app/restoring';
export { encodeBootIntent, parseBootIntent, type WindowBootIntent } from './app/sessionTearOff';
export * from './app/session-plugins';
export * from './app/preview-plugins';
export { perfMark } from './perf';
