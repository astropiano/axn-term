import { useSyncExternalStore } from 'react';
import { viewKey } from './railOrder';

/**
 * Per-window host for rail views opened at runtime and for the current
 * selection. Module state is window state: each webview runs its own React
 * tree. ShellApp registers the real selector; everything else (plugin API,
 * hidden commands, the sandbox) goes through these functions.
 */

export const EXTERNAL_VIEWS_ID = 'external-views';

/** A web view opened at runtime — never persisted (its URL may carry a token). */
export interface RuntimeView {
  id: string;
  url: string;
  title: string;
  logo?: string;
}

/** The selected rail view. Carries no URL on purpose. */
export interface ActiveView {
  key: string;
  pluginId: string;
  entryId?: string;
  title: string;
  runtime: boolean;
}

export interface ViewHostImpl {
  /** Activate a view key (`null` = back to the session); false when unknown. */
  select(key: string | null): boolean;
  describe(key: string): Omit<ActiveView, 'key'> | null;
}

let host: ViewHostImpl | null = null;
let views: RuntimeView[] = [];
let activeKey: string | null = null;
const viewListeners = new Set<() => void>();
const changeListeners = new Set<(view: ActiveView | null) => void>();

export function isWebUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function registerViewHost(impl: ViewHostImpl): () => void {
  host = impl;
  return () => {
    if (host === impl) host = null;
  };
}

export function runtimeViews(): RuntimeView[] {
  return views;
}

const subscribeViews = (cb: () => void) => {
  viewListeners.add(cb);
  return () => viewListeners.delete(cb);
};

export function useRuntimeViews(): RuntimeView[] {
  return useSyncExternalStore(subscribeViews, runtimeViews, runtimeViews);
}

function setViews(next: RuntimeView[]): void {
  views = next;
  viewListeners.forEach((cb) => cb());
}

/** Open (or re-select) a runtime web view; returns its view key. Throws on a non-http(s) URL. */
export function openView(args: { url: string; title?: string; logo?: string }): string {
  if (!isWebUrl(args.url)) throw new Error(`not an http(s) URL: ${args.url}`);
  let view = views.find((v) => v.url === args.url);
  const created = !view;
  if (!view) {
    view = {
      id: Math.random().toString(36).slice(2, 10),
      url: args.url,
      title: args.title?.trim() || new URL(args.url).host,
      logo: args.logo,
    };
    setViews([...views, view]);
  }
  const key = viewKey(EXTERNAL_VIEWS_ID, view.id);
  if (host && !host.select(key)) {
    if (created) setViews(views.filter((v) => v !== view));
    throw new Error(`${EXTERNAL_VIEWS_ID} is not enabled in this window`);
  }
  return key;
}

export function selectView(key: string | null): boolean {
  return host?.select(key) ?? false;
}

/** Remove a runtime view; leaves the view first when it is the active one. */
export function removeView(key: string): boolean {
  const view = views.find((v) => viewKey(EXTERNAL_VIEWS_ID, v.id) === key);
  if (!view) return false;
  if (activeKey === key) host?.select(null);
  setViews(views.filter((v) => v !== view));
  return true;
}

export function runtimeViewUrl(id: string): string | undefined {
  return views.find((v) => v.id === id)?.url;
}

let frameOriginAllower: ((url: string) => Promise<void>) | null = null;

/** The platform's hook for framing a page (desktop: its navigation guard refuses foreign origins). */
export function setFrameOriginAllower(fn: ((url: string) => Promise<void>) | null): void {
  frameOriginAllower = fn;
}

/** Call before framing `url`; resolves once the page may load. */
export function allowFrameOrigin(url: string): Promise<void> {
  return frameOriginAllower ? frameOriginAllower(url) : Promise.resolve();
}

export function activeView(): ActiveView | null {
  if (!activeKey) return null;
  const info = host?.describe(activeKey);
  return info ? { key: activeKey, ...info } : null;
}

export function onViewChanged(cb: (view: ActiveView | null) => void): () => void {
  changeListeners.add(cb);
  return () => changeListeners.delete(cb);
}

/** ShellApp reports every selection; listeners hear only real changes. */
export function publishActiveView(key: string | null): void {
  if (key === activeKey) return;
  activeKey = key;
  const view = activeView();
  changeListeners.forEach((cb) => cb(view));
}

export function resetViewHostForTests(): void {
  host = null;
  frameOriginAllower = null;
  views = [];
  activeKey = null;
  viewListeners.clear();
  changeListeners.clear();
}
