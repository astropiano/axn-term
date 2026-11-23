/** "just now", "45m ago", "5h ago", "5d ago" for an ISO or epoch-millisecond timestamp; null when unparsable. */
export function relativeAgo(at: string | number, now = Date.now()): string | null {
  const then = typeof at === 'number' ? at : Date.parse(at);
  if (Number.isNaN(then)) return null;
  const minutes = Math.max(0, Math.round((now - then) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
