// Minimal @tauri-apps/api/core stub for Storybook — the webview runs in a
// plain browser, so invoke() returns canned defaults per command.
export async function invoke<T>(cmd: string, _args?: unknown): Promise<T> {
  switch (cmd) {
    case 'list_external_plugins':
      return [] as unknown as T;
    case 'get_default_shell':
      return 'bash' as unknown as T;
    case 'plugin_exec':
      return '' as unknown as T;
    default:
      return null as T;
  }
}

export function convertFileSrc(filePath: string): string {
  return filePath;
}

export function transformCallback(): number {
  return 0;
}

export function isTauri(): boolean {
  return false;
}

export class Channel<T = unknown> {
  onmessage: ((response: T) => void) | null = null;
}

export class Resource {}
