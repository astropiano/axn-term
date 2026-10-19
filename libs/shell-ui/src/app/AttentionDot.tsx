import type { AttentionLevel } from '../types';

/**
 * Pulsing rounded square marking something that needs attention — rendered
 * as a halo behind a session's process icon and behind the attention icon in
 * the left rail. Matches the `rounded` curvature of the header buttons.
 * `critical` flags are red, `warning` flags orange. Size and position come
 * from className.
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
      className={`attention-dot inline-block rounded ${className}`}
      style={{ backgroundColor: level === 'critical' ? 'var(--red)' : 'var(--orange)' }}
    />
  );
}
