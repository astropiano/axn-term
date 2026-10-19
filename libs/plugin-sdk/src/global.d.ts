import type { AxnClient } from './api';

declare global {
  interface Window {
    /** Sandboxed plugin client, injected before the plugin code runs. */
    axn: AxnClient;
  }
}

export {};
