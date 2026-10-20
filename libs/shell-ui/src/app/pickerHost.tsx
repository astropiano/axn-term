import { useSyncExternalStore } from 'react';
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

interface PickRequest {
  options: PickOptions;
  resolve: (key: string | null) => void;
}

let current: PickRequest | null = null;
const listeners = new Set<() => void>();

function set(next: PickRequest | null) {
  current = next;
  for (const listener of listeners) listener();
}

/** Show the picker; resolves with the picked item's key, or null. */
export function pickFromList(options: PickOptions): Promise<string | null> {
  // A newer request replaces an open one — the older caller gets null.
  current?.resolve(null);
  return new Promise((resolve) => set({ options, resolve }));
}

function finish(key: string | null) {
  const request = current;
  set(null);
  request?.resolve(key);
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
      onPick={(item) => finish(item.key)}
      onClose={() => finish(null)}
    />
  );
}
