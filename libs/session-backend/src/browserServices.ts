import type { ShellServices } from './types';

/**
 * Browser-environment ShellServices: navigator.clipboard, window.open,
 * localStorage as the kv store, and Web Notification. Kept apart from the
 * /ws transport in WsBackend — services and transport are independent
 * seams (same split as tauriServices/tauriBackend on desktop).
 */
export const browserServices: ShellServices = {
  copyText: (text) => navigator.clipboard?.writeText(text),
  pasteText: () => navigator.clipboard?.readText().catch(() => undefined),
  openExternal: (url) => window.open(url, '_blank', 'noopener'),
  storage: {
    get: (key) => Promise.resolve(localStorage.getItem(`axn-kv:${key}`)),
    set: (key, value) => {
      if (value === null) localStorage.removeItem(`axn-kv:${key}`);
      else localStorage.setItem(`axn-kv:${key}`, value);
      return Promise.resolve();
    },
  },
  notify: (title, body) => {
    if (typeof Notification === 'undefined') return;
    const post = () => new Notification(title, { body });
    if (Notification.permission === 'granted') post();
    else if (Notification.permission !== 'denied') {
      void Notification.requestPermission().then((p) => {
        if (p === 'granted') post();
      });
    }
  },
};
