import { useEffect, useState } from 'react';

/**
 * Lucide's GlobeCode icon, decomposed: the globe body and equator keep
 * `currentColor` (inherits the rail button's text color), while the </>
 * chevrons carry the connection state —
 *   idle        → currentColor (whatever the button paints)
 *   connecting  → green alternates left/right chevron
 *   connected   → both green
 *   error       → both red
 */
export type RemoteIconState = 'idle' | 'connecting' | 'connected' | 'error';

const CHEVRON_LEFT = 'M15.5 10 13 7.5 15.5 5';
const CHEVRON_RIGHT = 'M19.5 5 22 7.5 19.5 10';
const GLOBE =
  'M15.861 14A14.5 14.5 0 0112 22a14.48 14.48 0 010-20 10 10 0 109.888 11.5';
const EQUATOR = 'M2 12h8.5';

/** Green ping interval between the two chevrons while connecting. */
const CONNECTING_MS = 350;

export function RemoteIcon({
  state,
  className,
}: {
  state: RemoteIconState;
  className?: string;
}) {
  // Green jumps between the chevrons — a plain interval, no CSS keyframes.
  const [leftIsGreen, setLeftIsGreen] = useState(true);
  useEffect(() => {
    if (state !== 'connecting') return;
    const id = setInterval(() => setLeftIsGreen((v) => !v), CONNECTING_MS);
    return () => clearInterval(id);
  }, [state]);

  const chevronColor = (left: boolean): string | undefined => {
    switch (state) {
      case 'connected':
        return 'var(--green)';
      case 'error':
        return 'var(--red)';
      case 'connecting':
        return left === leftIsGreen ? 'var(--green)' : undefined;
      default:
        return undefined;
    }
  };

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d={GLOBE} />
      <path d={EQUATOR} />
      <path d={CHEVRON_LEFT} stroke={chevronColor(true)} />
      <path d={CHEVRON_RIGHT} stroke={chevronColor(false)} />
    </svg>
  );
}
