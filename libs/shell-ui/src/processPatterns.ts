/**
 * Foreground-process / terminal-title heuristic for task-runner sessions.
 * When the process or OSC title matches, the session is flagged devinActive
 * and input tracking treats the runner's own line editing (e.g. devin's
 * /exit) differently from plain shell input.
 */
export const DEVIN_PROCESS_RE = /devin/i;
