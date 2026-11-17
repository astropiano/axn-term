/**
 * User-chosen ordering for the slim left rail. Persisted in window state
 * under `pluginData['axn-rail']` as `{ order: viewKey[] }` — a preference
 * list over view keys (see `viewKey`), not a full manifest, so rail items
 * without a recorded slot append and disabled ones keep their position for
 * when they come back. Runtime entries are never recorded.
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
 * A rail view's identity: the plugin id for a plugin's own item, or
 * `pluginId/entryId` for one of the items a plugin contributes through
 * `railEntries`. Entry ids never contain `/`.
 */
export function viewKey(pluginId: string, entryId?: string): string {
  return entryId === undefined ? pluginId : `${pluginId}/${entryId}`;
}

export function parseViewKey(key: string): { pluginId: string; entryId?: string } {
  const slash = key.indexOf('/');
  return slash < 0
    ? { pluginId: key }
    : { pluginId: key.slice(0, slash), entryId: key.slice(slash + 1) };
}

export interface RailSlotLike {
  key: string;
  /** Set (truthy) when contributed through `railEntries` rather than the plugin's own item. */
  entry?: unknown;
}

/**
 * Rail slots in display order: saved ranks first, then unranked plugin
 * items in input order, then unranked entries — so entries appearing never
 * move an existing item's ⌘N number.
 */
export function orderRailSlots<T extends RailSlotLike>(
  slots: readonly T[],
  pluginData: Record<string, unknown>,
): T[] {
  const rank = new Map(storedRailOrder(pluginData).map((id, i) => [id, i]));
  const tier = (s: T) => (rank.has(s.key) ? 0 : s.entry ? 2 : 1);
  return [...slots].sort(
    (a, b) =>
      tier(a) - tier(b) ||
      (rank.get(a.key) ?? 0) - (rank.get(b.key) ?? 0),
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
  transient: ReadonlySet<string> = new Set(),
): string[] {
  const ids = renderedIds.filter((id) => !transient.has(id));
  if (transient.has(dragId)) return storedOrder.filter((id) => !transient.has(id));
  const from = ids.indexOf(dragId);
  if (from < 0) return storedOrder;
  const to = Math.max(0, Math.min(dropIndex, ids.length));
  ids.splice(from, 1);
  ids.splice(to > from ? to - 1 : to, 0, dragId);
  for (const id of storedOrder) {
    if (!ids.includes(id) && !transient.has(id)) ids.push(id);
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

/**
 * The rail's views in display order — what the `⌘1`…`⌘9` shortcuts count:
 * rail slots that open a view (`hasView`) and currently show something
 * (`visible`; a plugin may render no rail item at all, e.g. a forge whose
 * CLI is missing). Indicator-only slots are skipped. `slots` must be in
 * display order (pinned first, then the user's order).
 */
export function railViewIds(
  slots: readonly { id: string; hasView: boolean; visible: boolean }[],
): string[] {
  return slots.filter((slot) => slot.hasView && slot.visible).map((slot) => slot.id);
}

/**
 * Which view a rail shortcut activates: the view at `index`, or `null` when
 * that view is already active (the shortcut toggles back to the session).
 * `undefined` when there is no view at that position — nothing happens.
 */
export function railViewAfterShortcut(
  viewIds: readonly string[],
  index: number,
  activeViewId: string | null,
): string | null | undefined {
  const id = viewIds[index];
  if (id === undefined) return undefined;
  return id === activeViewId ? null : id;
}
