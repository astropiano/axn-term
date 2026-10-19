import type { PathStat } from '@axn-term/session-backend';

/**
 * App-level (not session-bound) operations: plugin rail views like the MR
 * overview run `sh -c` commands without a session context. On remote
 * backends any session's connection reaches the same session host, so the
 * app binds a resolver that picks a live session at call time.
 */
export interface AppRuntime {
  /** `sh -c` in some live session's environment. */
  exec(command: string, cwd?: string): Promise<string>;
  /** Resolve/stat a path in some live session's filesystem. */
  statPath(path: string, cwd?: string): Promise<PathStat | null>;
  /**
   * Any live session id, for ops that need a backend connection but aren't
   * session-bound (plugin-hosted browser/preview tabs). All conns reach the
   * same session host. Null when no session is open.
   */
  resolveSessionId(): string | null;
}

let runtime: AppRuntime | null = null;

/** Called once by ShellApp at mount. */
export function bindAppRuntime(rt: AppRuntime | null): void {
  runtime = rt;
}

export function appRuntime(): AppRuntime | null {
  return runtime;
}
