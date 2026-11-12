/**
 * Broadcast danger gate — classifies the composer buffer before fan-out.
 * A broadcast mistake lands on every selected session at once, so lines
 * that match a built-in (or user-configured) dangerous-command rule open
 * a confirm dialog instead of writing. Users extend the list via
 * `broadcastDangerPatterns` in config.yaml — extra regex sources, each
 * matched against every line of the buffer, case-insensitive.
 */

export interface DangerRule {
  /** Short id, used in warnings. */
  id: string;
  /** Human-readable reason shown in the confirm dialog. */
  label: string;
  re: RegExp;
}

const rule = (id: string, label: string, src: string, flags = 'i'): DangerRule => ({
  id,
  label,
  re: new RegExp(src, flags),
});

export const BUILTIN_DANGER_RULES: DangerRule[] = [
  rule(
    'rm-rf',
    'deletes files recursively or forcibly (rm -rf)',
    '\\brm\\s+(?:--?[a-zA-Z-]*\\s+)*-[a-zA-Z]*[rf][a-zA-Z]*\\b',
  ),
  rule(
    'disk-write',
    'writes to a disk or block device',
    '\\b(?:dd\\b[^|;\\n]*\\bof=/dev/|mkfs(?:\\.[a-z0-9]+)?|wipefs|fdisk|parted)\\b',
  ),
  rule(
    'power',
    'shuts down, reboots, or halts the machine',
    '\\b(?:shutdown|reboot|halt|poweroff)\\b|\\binit\\s+[06]\\b',
  ),
  rule(
    'git-force',
    'force-pushes or deletes git refs',
    '\\bgit\\s+push\\b[^|;\\n]*(?:--force(?:-with-lease)?\\b|\\s-f\\b|--delete\\b)',
  ),
  rule(
    'git-destroy',
    'discards git working-tree changes',
    '\\bgit\\s+(?:reset\\s+--hard\\b|clean\\s+[^|;\\n]*-[a-zA-Z]*f)',
  ),
  rule(
    'sql-drop',
    'drops or deletes database data',
    '\\b(?:drop\\s+(?:table|database|schema)|truncate\\s+table|delete\\s+from)\\b',
  ),
  rule(
    'kubectl-delete',
    'deletes or drains Kubernetes resources',
    '\\bkubectl\\s+(?:delete|drain|replace\\s+--force)\\b',
  ),
  rule(
    'systemctl-stop',
    'stops or disables a system service',
    '\\bsystemctl\\s+(?:stop|disable|mask|kill)\\b',
  ),
  rule(
    'perms-recursive',
    'recursively rewrites file permissions or ownership',
    '\\b(?:chmod|chown|chgrp)\\s+[^|;\\n]*-R\\b',
  ),
  rule(
    'kill-by-name',
    'kills processes by name (killall/pkill)',
    '\\b(?:killall|pkill)\\b',
  ),
  rule('fork-bomb', 'fork bomb', ':\\s*\\(\\s*\\)\\s*\\{'),
];

export interface DangerHit {
  /** The rule label (builtin) or the user's regex source. */
  rule: string;
  /** The buffer line that matched. */
  line: string;
}

/** Built-ins + user regexes; a broken user pattern is skipped, not fatal. */
export function compileDangerRules(extra?: string[]): DangerRule[] {
  const rules = [...BUILTIN_DANGER_RULES];
  for (const [i, src] of (extra ?? []).entries()) {
    try {
      rules.push({ id: `user-${i}`, label: src, re: new RegExp(src, 'i') });
    } catch {
      console.warn(`[broadcast] ignoring invalid danger pattern: ${JSON.stringify(src)}`);
    }
  }
  return rules;
}

/** First line that trips a rule, or null when the buffer looks safe. */
export function dangerCheck(text: string, extra?: string[]): DangerHit | null {
  const rules = compileDangerRules(extra);
  for (const line of text.split('\n')) {
    for (const r of rules) {
      if (r.re.test(line)) return { rule: r.label, line: line.trim() };
    }
  }
  return null;
}
