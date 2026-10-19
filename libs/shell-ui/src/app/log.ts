import { shellPlatform, type LogLevel } from '../platform';

export type { LogLevel };

/**
 * Forward a log line to the host logger (desktop: Tauri `log` event consumed
 * by the Rust env_logger; web: console). Cheap even in release builds.
 */
export function axnLog(level: LogLevel, target: string, message: string) {
  const emit = shellPlatform()?.emitLog;
  if (emit) {
    try {
      emit(level, target, message);
      return;
    } catch {
      // fall through to console
    }
  }
  const fn = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'debug';
  console[fn](`[${target}] ${message}`);
}
