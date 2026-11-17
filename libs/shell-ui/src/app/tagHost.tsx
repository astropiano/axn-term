import { useSyncExternalStore } from 'react';
import { TagModal } from './TagModal';

/**
 * App-wide "edit tags" prompt for in-process plugins, mirroring `pickerHost`:
 * a menu row calls `openTagModal(...)`; `TagHost`, mounted once in
 * `ShellApp`, renders the request.
 */
export interface TagRequest {
  title: string;
  /** Each target's current tags (a session, or the workspace). */
  targets: string[][];
  /** Tags of every other carrier in the window — they feed the shared tag list. */
  others: string[][];
  /** Called once with the final tags per target, in `targets` order. */
  onApply: (next: string[][]) => void;
}

let current: TagRequest | null = null;
const listeners = new Set<() => void>();

function set(next: TagRequest | null) {
  current = next;
  for (const listener of listeners) listener();
}

export function openTagModal(request: TagRequest): void {
  set(request);
}

export function TagHost() {
  const request = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
  if (!request) return null;
  return (
    <TagModal
      request={request}
      onApply={(next) => {
        set(null);
        request.onApply(next);
      }}
      onClose={() => set(null)}
    />
  );
}
