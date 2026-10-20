/**
 * Capabilities a sandboxed plugin must declare in `plugin.json`
 * `permissions`. The host refuses every call and hook that needs an
 * undeclared one; a plugin without the field gets none of them — it can
 * still keep per-session state, raise banners/attention flags, push
 * surfaces, open tabs and own `axn-*` commands that swallow their line.
 */
export type PluginPermission =
  /** Run shell commands: `exec`, `openSubShell`, `runCommand`. */
  | 'exec'
  /**
   * Type into a session's shell: `writeToSession`, the `line` hook (it can
   * rewrite every submitted line) and a replacement line returned from an
   * owned command.
   */
  | 'terminal-input'
  /** Read what a terminal shows: `getScreenLines`, `waitForSessionOutput`, the `output` hook. */
  | 'terminal-output'
  /** `readFile`, `statPath`. */
  | 'fs-read'
  /** `writeFile`, `mkdir`. */
  | 'fs-write'
  /** Drive the app's sessions: `openSession`, `selectSession`, `activateTab`. */
  | 'sessions';

export const PLUGIN_PERMISSIONS: readonly PluginPermission[] = [
  'exec',
  'terminal-input',
  'terminal-output',
  'fs-read',
  'fs-write',
  'sessions',
];

const METHOD_PERMISSIONS: Record<string, PluginPermission> = {
  exec: 'exec',
  openSubShell: 'exec',
  runCommand: 'exec',
  writeToSession: 'terminal-input',
  getScreenLines: 'terminal-output',
  waitForSessionOutput: 'terminal-output',
  readFile: 'fs-read',
  statPath: 'fs-read',
  writeFile: 'fs-write',
  mkdir: 'fs-write',
  openSession: 'sessions',
  selectSession: 'sessions',
  activateTab: 'sessions',
};

const HOOK_PERMISSIONS: Record<string, PluginPermission> = {
  output: 'terminal-output',
  line: 'terminal-input',
};

/** The permission an RPC method needs, if any. */
export function methodPermission(method: string): PluginPermission | undefined {
  return METHOD_PERMISSIONS[method];
}

/** The permission a subscribed hook needs, if any. */
export function hookPermission(hook: string): PluginPermission | undefined {
  return HOOK_PERMISSIONS[hook];
}

/** Validate a manifest's raw `permissions` value; unknown entries are reported, not granted. */
export function parsePermissions(raw: unknown): {
  permissions: PluginPermission[];
  unknown: string[];
} {
  const permissions: PluginPermission[] = [];
  const unknown: string[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    if ((PLUGIN_PERMISSIONS as readonly unknown[]).includes(entry)) {
      if (!permissions.includes(entry as PluginPermission)) permissions.push(entry as PluginPermission);
    } else {
      unknown.push(String(entry));
    }
  }
  return { permissions, unknown };
}
