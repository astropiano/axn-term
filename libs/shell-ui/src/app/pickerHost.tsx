import { useSyncExternalStore, type ReactNode } from 'react';
import { SearchPickerModal, type PickerItem } from './SearchPickerModal';

/**
 * App-wide "pick one of these" prompt for in-process plugins: a menu row
 * calls `pickFromList(...)` and awaits the chosen key (null when dismissed);
 * `PickerHost`, mounted once in `ShellApp`, renders the request with the
 * shared `SearchPickerModal`. A module store rather than a ctx method, so
 * every plugin ctx (ShellApp's, SessionPanel's, …) can use it unchanged.
 */

export interface PickOptions {
  title: string;
  placeholder?: string;
  items: PickerItem[];
}

export interface PickCreateOptions extends PickOptions {
  /** Label of the create row for the typed text; null hides the row. */
  createLabel?: (query: string) => ReactNode | null;
}

/** `created` marks the create-row pick — `key` is the typed query then. */
export interface PickResult {
  key: string;
  created: boolean;
}

interface PickRequest {
  options: PickCreateOptions;
  resolve: (result: PickResult | null) => void;
}

let current: PickRequest | null = null;
const listeners = new Set<() => void>();

function set(next: PickRequest | null) {
  current = next;
  for (const listener of listeners) listener();
}

/** Show the picker; resolves with the picked item's key, or null. */
export function pickFromList(options: PickOptions): Promise<string | null> {
  return pickOrCreate(options).then((r) => (r && !r.created ? r.key : null));
}

/**
 * Same picker with a create row: resolves `{key, created}` — `key` is the
 * picked item's key, or the typed query when `created` is true; null when
 * dismissed.
 */
export function pickOrCreate(options: PickCreateOptions): Promise<PickResult | null> {
  // A newer request replaces an open one — the older caller gets null.
  current?.resolve(null);
  return new Promise((resolve) => set({ options, resolve }));
}

function finish(result: PickResult | null) {
  const request = current;
  set(null);
  request?.resolve(result);
}

export function PickerHost() {
  const request = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
  if (!request) return null;
  return (
    <SearchPickerModal
      title={request.options.title}
      placeholder={request.options.placeholder}
      items={request.options.items}
      onPick={(item) => finish({ key: item.key, created: false })}
      onClose={() => finish(null)}
      createLabel={request.options.createLabel}
      onCreate={
        request.options.createLabel
          ? (query) => finish({ key: query, created: true })
          : undefined
      }
    />
  );
}
