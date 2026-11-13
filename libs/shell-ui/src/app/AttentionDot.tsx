import type { AttentionLevel } from '../types';

/**
 * Softly pulsing halo marking something that needs attention — rendered
 * behind a session's icon tile. `critical` flags use the theme's attention
 * colour, `warning` flags orange. Size, position and corner radius come from
 * className.
 */
export function AttentionDot({
  level = 'critical',
  className = '',
}: {
  level?: AttentionLevel;
  className?: string;
}) {
  return (
    <span
      className={`attention-dot pointer-events-none inline-block rounded ${className}`}
      style={{ backgroundColor: level === 'critical' ? 'var(--attention)' : 'var(--orange)' }}
    />
  );
}
