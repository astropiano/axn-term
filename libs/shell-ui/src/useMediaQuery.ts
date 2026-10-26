import { useEffect, useState } from 'react';

/** Live `matchMedia` binding — re-renders when the query result changes. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const update = () => setMatches(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, [query]);
  return matches;
}

/** Primary input is touch (phones, tablets) — `(pointer: coarse)`. */
export const COARSE_POINTER_QUERY = '(pointer: coarse)';

export function useCoarsePointer(): boolean {
  return useMediaQuery(COARSE_POINTER_QUERY);
}

/**
 * Visual-viewport geometry. On mobile browsers the on-screen keyboard shrinks
 * `visualViewport` while the layout viewport stays put, and iOS also offsets
 * it to reveal the focused field — following height + offsetTop keeps the app
 * exactly inside the visible area. Returns null while disabled or when the
 * API is missing (the caller keeps its normal 100vh/dvh sizing).
 */
export function useVisualViewportSize(
  enabled: boolean,
): { height: number; offsetTop: number } | null {
  const [size, setSize] = useState<{ height: number; offsetTop: number } | null>(null);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!enabled || !vv) {
      setSize(null);
      return;
    }
    // Keyboard transitions (show/hide, Android's long-press-space picker)
    // fire a resize BURST — applying each frame whips the whole app layout
    // mid-gesture (visible flicker) and can strand the IME's focus. Keep
    // only the last event in a short window: one stable layout per
    // transition.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => setSize({ height: vv.height, offsetTop: vv.offsetTop }),
        90,
      );
    };
    setSize({ height: vv.height, offsetTop: vv.offsetTop });
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      clearTimeout(timer);
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, [enabled]);

  return size;
}
