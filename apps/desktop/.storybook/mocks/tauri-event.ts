// Minimal @tauri-apps/api/event stub for Storybook.
export interface Event<T> {
  event: string;
  payload: T;
  id: number;
}

export type UnlistenFn = () => void;

export async function listen(): Promise<UnlistenFn> {
  return () => {};
}

export async function once(): Promise<UnlistenFn> {
  return () => {};
}

export async function emit(): Promise<void> {}

export async function emitTo(): Promise<void> {}
