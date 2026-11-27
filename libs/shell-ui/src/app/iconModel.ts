import { createContext, useContext } from 'react';
import type { AppSettings } from '../themes';

/**
 * The custom-icon bag: one flat map keyed by process name (`devin`,
 * `claude`) or plugin id (`docker`, `gh-pr`) — values are the
 * `sessionIcons` format (a Lucide name or an inline `<svg>` tag). Users
 * write it through `customIcons` in config.yaml (or the icon editors);
 * the legacy `sessionIcons`/`pluginIcons` maps still merge in so existing
 * configs keep working.
 */
export type IconBag = Record<string, string>;

/** pluginData key the synced bag is published under (`app:icons` on the wire). */
export const ICONS_PLUGIN_DATA_KEY = 'icons';
export const ICONS_SHARED_KEY = 'app:icons';

/** Every icon this device knows about — legacy maps first, `customIcons` wins. */
export function collectIconBag(settings: Pick<
  AppSettings,
  'sessionIcons' | 'pluginIcons' | 'customIcons'
>): IconBag {
  return {
    ...(settings.sessionIcons ?? {}),
    ...(settings.pluginIcons ?? {}),
    ...(settings.customIcons ?? {}),
  };
}

/**
 * The bag key a plugin's icon lives under: its `iconKey` — the process name
 * its sessions run as, where that differs from the plugin id (antigravity →
 * `agy`) — else its id. One key, so the Logo field, the Session-icons row and
 * the session rows all edit the same entry.
 */
export function pluginIconKey(plugin: { id: string; iconKey?: string }): string {
  return plugin.iconKey ?? plugin.id;
}

/**
 * A plugin's configured icon: its own key, else — for a plugin whose key is
 * not its id — an entry left under the id by an earlier version.
 */
export function pluginIconOverride(
  bag: IconBag,
  plugin: { id: string; iconKey?: string },
): string | undefined {
  return bag[pluginIconKey(plugin)] ?? (plugin.iconKey ? bag[plugin.id] : undefined);
}

/** Single lookup point — a configured icon or the caller's fallback. */
export function resolveIcon(bag: IconBag, key: string, fallback: string): string {
  return bag[key] ?? fallback;
}

/**
 * The slice of a plugin that matters for icon resolution. A plugin that
 * declares `logo` opts into having an icon — and when its `processPattern`
 * matches a session's foreground process, that logo is the session icon's
 * fallback (so an agent plugin's logo doubles as its sessions' icon).
 */
export interface IconPlugin {
  id: string;
  /** Bag key when it is not the id — see `pluginIconKey`. */
  iconKey?: string;
  logo?: string;
  processPattern?: RegExp;
}

let iconPlugins: IconPlugin[] = [];

/** Called from `registerSessionViewPlugin` — replaces by id. */
export function registerIconPlugin(plugin: IconPlugin): void {
  // Circular imports (a plugin file loaded as the entry point) can hand us
  // not-yet-initialized exports — skip them.
  if (!plugin) return;
  iconPlugins = [...iconPlugins.filter((p) => p.id !== plugin.id), plugin];
}

/** Test/reload hook — re-seed the known list (index.ts seeds built-ins). */
export function resetIconPlugins(list: IconPlugin[]): void {
  iconPlugins = [...list];
}

/**
 * The icon for a session's foreground process: an explicit `bag[process]`
 * entry wins, else the logo of the first registered plugin claiming the
 * process (`bag[plugin.id]` override, else its declared `logo`), else
 * `fallback`.
 */
export function resolveProcessIcon(
  process: string | undefined,
  bag: IconBag,
  fallback = 'SquareTerminal',
): string {
  if (!process) return fallback;
  const own = bag[process.toLowerCase()];
  if (own !== undefined) return own;
  const plugin = iconPlugins.find((p) => p.logo !== undefined && p.processPattern?.test(process));
  if (plugin) return pluginIconOverride(bag, plugin) ?? plugin.logo ?? fallback;
  return fallback;
}

/**
 * The effective bag: this device's `collectIconBag` overlaid by the synced
 * `app:icons` entry (remote bag wins per key — the authority's choice is
 * what every screen shows). ShellApp provides it; empty without a provider.
 */
export const IconBagContext = createContext<IconBag>({});

export function useIconBag(): IconBag {
  return useContext(IconBagContext);
}
