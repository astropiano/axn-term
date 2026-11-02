import type { ReactNode } from 'react';
import type { PluginSettings } from '../pluginSettings';

/**
 * Context handed to a preview plugin's `render`. `path` is the tab's stored
 * path (possibly relative); `resolvedPath` is the absolute path already
 * resolved against `cwd`.
 */
export interface FilePreviewContext {
  path: string;
  resolvedPath: string;
  cwd?: string;
  /** The plugin's own plugins.yaml section (kebab keys normalized to camel). */
  pluginSettings: unknown;
  /** Read the previewed file as UTF-8 text. */
  readFile: () => Promise<string>;
  /** Read the previewed file as bytes. */
  readBytes: () => Promise<Uint8Array>;
  /**
   * Read a sibling file referenced by the preview (e.g. a relative image in
   * markdown). `rel` is resolved against the previewed file's directory unless
   * it is already absolute.
   */
  readSibling: (rel: string) => Promise<Uint8Array>;
  /** False while the preview tab lives in the background. */
  isVisible?: boolean;
}

/**
 * A file-preview plugin renders a file into a preview tab
 * (`editors[].kind === 'preview'`). Register built-ins in `index.ts`; external
 * `.mjs` plugins may attach a `preview` capability to their session plugin
 * object (see `session-plugins/index.ts`).
 */
export interface FilePreviewPlugin {
  id: string;
  title: string;
  /** Same as `SessionViewPlugin.logo` — declares the has-an-icon capability. */
  logo?: string;
  /** Plugin version (`x.y.z`); shown in Settings. */
  version?: string;
  settingsKey?: string;
  /**
   * Whether the plugin is active when the user has not set `<id>.enabled` in
   * plugins.yaml. Defaults to `true` for built-ins; external plugins are
   * always opt-in.
   */
  defaultEnabled?: boolean;
  /** True when this plugin can render a preview for `path`. */
  matches: (path: string) => boolean;
  /**
   * Catch-all plugins (e.g. the plain-text fallback) always resolve after
   * specific renderers, no matter when they were registered.
   */
  fallback?: boolean;
  /**
   * Render the preview body. Return a ReactNode; a plain string is treated as
   * HTML, sanitized, and injected — that is the form external `.mjs` plugins
   * (which cannot use JSX) produce.
   */
  render: (ctx: FilePreviewContext) => ReactNode;
}

/** Builds a `matches` predicate from a list of file extensions (no dot). */
export function extensionMatcher(extensions: string[]): (path: string) => boolean {
  const re = new RegExp(`\\.(${extensions.join('|')})$`, 'i');
  return (path) => re.test(path);
}

export function isFilePreviewEnabled(
  plugin: FilePreviewPlugin,
  settings: PluginSettings,
): boolean {
  const key = plugin.settingsKey ?? plugin.id;
  const value = settings[key]?.enabled;
  return typeof value === 'boolean' ? value : (plugin.defaultEnabled ?? true);
}

let plugins: FilePreviewPlugin[] = [];

export function getFilePreviewPlugins(): readonly FilePreviewPlugin[] {
  return plugins;
}

/** Specific renderers keep registration order; fallbacks always go last. */
function ordered(list: FilePreviewPlugin[]): FilePreviewPlugin[] {
  return [...list.filter((p) => !p.fallback), ...list.filter((p) => p.fallback)];
}

export function registerFilePreviewPlugin(plugin: FilePreviewPlugin): void {
  const idx = plugins.findIndex((p) => p.id === plugin.id);
  const next = [...plugins];
  if (idx === -1) next.push(plugin);
  else next[idx] = plugin;
  plugins = ordered(next);
}

/** Test hook: restore the built-in plugin list. */
export function resetFilePreviewPlugins(builtins: FilePreviewPlugin[]): void {
  plugins = ordered(builtins);
}

/**
 * First enabled plugin claiming `path` wins. The plain-text fallback is
 * registered last so specific renderers (image, markdown, …) take precedence.
 */
export function resolveFilePreviewPlugin(
  path: string,
  settings: PluginSettings,
): FilePreviewPlugin | null {
  for (const plugin of plugins) {
    if (isFilePreviewEnabled(plugin, settings) && plugin.matches(path)) {
      return plugin;
    }
  }
  return null;
}
