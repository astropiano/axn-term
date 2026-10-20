/**
 * User-chosen ordering for the slim left rail. Persisted in window state
 * under `pluginData['axn-rail']` as `{ order: pluginId[] }` — a preference
 * list over plugin ids, not a full manifest, so rail plugins without a
 * recorded slot append in registration order and disabled ones keep their
 * position for when they come back.
 */
export const RAIL_ORDER_KEY = 'axn-rail';

/** Stored rail order, tolerant of malformed persisted data. */
export function storedRailOrder(pluginData: Record<string, unknown>): string[] {
  const order = (pluginData[RAIL_ORDER_KEY] as { order?: unknown } | undefined)?.order;
  return Array.isArray(order)
    ? order.filter((id): id is string => typeof id === 'string')
    : [];
}

/**
 * Plugins in rail display order: ids with a recorded slot first, everything
 * else appended in registration order (Array.sort is stable).
 */
export function orderRailPlugins<T extends { id: string }>(
  plugins: readonly T[],
  pluginData: Record<string, unknown>,
): T[] {
  const rank = new Map(storedRailOrder(pluginData).map((id, i) => [id, i]));
  return [...plugins].sort(
    (a, b) =>
      (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
      (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );
}

/**
 * Next persisted order after dropping `dragId` at `dropIndex` — an
 * insertion index into the rendered list (0..length; `i` lands before the
 * item currently at `i`, `length` appends at the end). Stored ids that are
 * not rendered right now keep their slot at the tail.
 */
export function railOrderAfterDrop(
  renderedIds: string[],
  storedOrder: string[],
  dragId: string,
  dropIndex: number,
): string[] {
  const ids = [...renderedIds];
  const from = ids.indexOf(dragId);
  if (from < 0) return storedOrder;
  const to = Math.max(0, Math.min(dropIndex, ids.length));
  ids.splice(from, 1);
  ids.splice(to > from ? to - 1 : to, 0, dragId);
  for (const id of storedOrder) {
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Insertion index for a pointer at `clientY` over the rail items' rects (in
 * rail order): before the first item whose vertical midpoint lies below the
 * pointer, else at the end.
 */
export function railDropIndexAt(
  clientY: number,
  rects: ReadonlyArray<{ top: number; height: number } | undefined>,
): number {
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (r && clientY < r.top + r.height / 2) return i;
  }
  return rects.length;
}
