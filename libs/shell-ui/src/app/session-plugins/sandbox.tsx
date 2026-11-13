import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Puzzle } from 'lucide-react';
import {
  AXN_PLUGIN_API_VERSION,
  hookPermission,
  isFrameMessage,
  methodPermission,
  type HostMessage,
  type PluginManifest,
  type PluginPermission,
  type SessionInfo,
} from '@axn-term/plugin-sdk';
// The iframe-side client is injected verbatim into the sandboxed document —
// it must stay dependency-free plain JS.
import shimSource from '../../../../plugin-sdk/src/shim.js?raw';
import { previewContainStyle, sanitizePreviewHtml } from '../preview-plugins/html';
import { shellServices } from '../../services';
import { axnLog } from '../log';
import type { PluginApi, SessionViewContext, SessionViewPlugin } from './plugin';
import type { ShellSession } from '../../types';

/**
 * Sandboxed external plugins (`~/.axn-term/plugins/<dir>/` with a
 * `plugin.json` manifest) run fully inside `sandbox="allow-scripts"`
 * iframes — opaque origin, no app DOM/storage/Tauri internals. Every
 * capability is proxied over the postMessage contract in
 * `@axn-term/plugin-sdk`.
 *
 * Two frames per plugin: a hidden *logic* frame (`plugin.mjs`) receiving
 * session lifecycle events and issuing RPC calls, and an optional *view*
 * frame (`index.html`) mounted into the plugin's full-area view.
 * The session-panel fields (`row`/`render` surfaces) are pushed
 * sanitized-HTML surfaces (`axn.setSurface`) since RPC can't satisfy the
 * fields' synchronous `value` contract.
 *
 * Capabilities are opt-in: a call or hook needing a `PluginPermission` the
 * manifest's `permissions` does not list is refused here, at the bridge.
 */

export interface SandboxPluginSpec {
  dir: string;
  manifest: PluginManifest;
  /** `plugin.mjs` source — loaded into the hidden logic frame. */
  logicSource?: string;
  /** View html — mounted by renderView. */
  viewSource?: string;
}

export type SandboxedPlugin = SessionViewPlugin & { sandbox: SandboxPluginSpec };

/** Whether a (load-validated) manifest declares `permission`. */
export function hasPermission(manifest: PluginManifest, permission: PluginPermission): boolean {
  return manifest.permissions?.includes(permission) ?? false;
}

export function isSandboxedPlugin(p: SessionViewPlugin): p is SandboxedPlugin {
  return (p as SandboxedPlugin).sandbox != null;
}

type PluginViewCtx = Parameters<NonNullable<SessionViewPlugin['renderView']>>[0];

/** Live app-state access for the bridge — wired by ShellApp once at mount. */
export const sandboxRuntime: {
  getSessions?: () => ShellSession[];
  buildApi?: (
    plugin: SessionViewPlugin,
    sessionId: string,
  ) => (SessionViewContext & PluginApi) | undefined;
  mergePluginData?: (key: string, patch: Record<string, unknown>) => void;
  getPluginData?: (key: string) => unknown;
  getPluginSettings?: (key: string) => unknown;
  selectSession?: (sessionId: string) => void;
} = {};

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const THEME_VARS = [
  '--bg',
  '--bg-secondary',
  '--terminal-bg',
  '--surface',
  '--surface-hover',
  '--text-primary',
  '--text-secondary',
  '--text-inverted',
  '--border',
  '--accent',
  '--accent-hover',
  '--cursor',
  '--green',
  '--red',
  '--yellow',
  '--blue',
  '--magenta',
  '--cyan',
  '--orange',
  '--violet',
  '--font-mono',
];

function collectTheme(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const vars: Record<string, string> = {};
  for (const name of THEME_VARS) {
    const v = style.getPropertyValue(name).trim();
    if (v) vars[name] = v;
  }
  vars['--color-scheme'] = document.documentElement.style.colorScheme || 'dark';
  return vars;
}

// One observer broadcasts theme changes into every live sandbox frame.
let themeObserver: MutationObserver | null = null;
const liveFrames = new Set<HTMLIFrameElement>();

function postTo(frame: HTMLIFrameElement, msg: HostMessage): void {
  try {
    frame.contentWindow?.postMessage(msg, '*');
  } catch {
    // frame already gone
  }
}

function broadcastTheme(): void {
  const theme = collectTheme();
  for (const f of liveFrames) postTo(f, { axn: 'plugin-v1', type: 'theme', theme });
}

function trackFrame(frame: HTMLIFrameElement): void {
  if (!themeObserver) {
    themeObserver = new MutationObserver(broadcastTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'data-theme'],
    });
  }
  liveFrames.add(frame);
}

function untrackFrame(frame: HTMLIFrameElement): void {
  liveFrames.delete(frame);
  if (liveFrames.size === 0 && themeObserver) {
    themeObserver.disconnect();
    themeObserver = null;
  }
}

// ---------------------------------------------------------------------------
// Pushed HTML surfaces (`axn.setSurface`)
// ---------------------------------------------------------------------------

const surfaces = new Map<string, string>();
const surfaceListeners = new Set<() => void>();

function surfaceKey(pluginId: string, sessionId: string, surface: string): string {
  return `${pluginId}|${sessionId}|${surface}`;
}

function setSurface(
  pluginId: string,
  sessionId: string,
  surface: string,
  html: string | null,
): void {
  const key = surfaceKey(pluginId, sessionId, surface);
  if (html == null) surfaces.delete(key);
  else surfaces.set(key, html);
  surfaceListeners.forEach((fn) => fn());
}

function subscribeSurfaces(fn: () => void): () => void {
  surfaceListeners.add(fn);
  return () => surfaceListeners.delete(fn);
}

/** A pushed sanitized-HTML surface; clicks on `[data-axn-action]` emit a
 * `surfaceAction` event to the plugin's logic frame. */
function SandboxedSurface({
  pluginId,
  sessionId,
  surface,
}: {
  pluginId: string;
  sessionId: string;
  surface: 'render' | 'row';
}) {
  const html = useSyncExternalStore(subscribeSurfaces, () =>
    surfaces.get(surfaceKey(pluginId, sessionId, surface)),
  );
  if (html == null) return null;
  return (
    <div
      className={
        surface === 'row'
          ? 'truncate text-[10px] text-[var(--text-secondary)]'
          : 'border-t border-[var(--border)] px-3 py-1 text-[11px] text-[var(--text-secondary)]'
      }
      style={previewContainStyle}
      onClick={(e) => {
        const el = (e.target as HTMLElement).closest('[data-axn-action]');
        const action = el?.getAttribute('data-axn-action');
        if (action != null) {
          e.preventDefault();
          sandboxes
            .get(pluginId)
            ?.forward('surfaceAction', sessionId, { surface, action });
          return;
        }
        const anchor = (e.target as HTMLElement).closest('a');
        const href = anchor?.getAttribute('href');
        if (!href) return;
        // Never let a surface link navigate the app itself (relative or
        // protocol-relative hrefs); only http(s) opens, externally.
        e.preventDefault();
        if (/^https?:/i.test(href)) {
          const open = shellServices()?.openExternal;
          if (open) void open(href);
          else window.open(href, '_blank', 'noopener');
        }
      }}
      dangerouslySetInnerHTML={{ __html: sanitizePreviewHtml(html) }}
    />
  );
}

// ---------------------------------------------------------------------------
// The per-plugin bridge
// ---------------------------------------------------------------------------

function toSessionInfo(s: ShellSession, stateKey: string): SessionInfo {
  return {
    id: s.id,
    workspaceId: s.workspaceId,
    name: s.name,
    customName: s.customName,
    autoName: s.autoName,
    topic: s.topic,
    summary: s.summary,
    status: s.status,
    tasks: s.tasks,
    progress: s.progress,
    cwd: s.cwd,
    process: s.process,
    agentInput: s.agentInput,
    devinActive: s.agentInput === 'devin',
    repo: s.repo,
    state: (s.pluginState ?? {})[stateKey],
  };
}

const CALL_TIMEOUT_MS = 30_000;
const EVENT_TIMEOUT_MS = 5_000;

class PluginSandbox {
  readonly spec: SandboxPluginSpec;
  /** The stub plugin object — needed to build per-session PluginApi ctxs. */
  plugin: SessionViewPlugin | null = null;
  private logicFrame: HTMLIFrameElement | null = null;
  private views = new Map<HTMLIFrameElement, PluginViewCtx>();
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private reqSeq = 0;
  private sessionOpenReplayed = false;
  subscribed = new Set<string>();
  private onMessage = (e: MessageEvent) => this.route(e);

  constructor(spec: SandboxPluginSpec) {
    this.spec = spec;
    window.addEventListener('message', this.onMessage);
    this.ensureLogic();
  }

  get id(): string {
    return this.spec.manifest.id;
  }

  /** Whether plugin.json declared `permission`. */
  allows(permission: PluginPermission): boolean {
    return hasPermission(this.spec.manifest, permission);
  }

  private escapeInline(src: string): string {
    return src.replace(/<\/script/gi, '<\\/script');
  }

  private frameDoc(role: 'logic' | 'view', body: string): string {
    const theme = collectTheme();
    const vars = Object.entries(theme)
      .map(([k, v]) => `${k}:${v}`)
      .join(';');
    const head =
      `<!doctype html><meta charset="utf-8">` +
      `<meta http-equiv="Content-Security-Policy" ` +
      `content="default-src 'unsafe-inline' https: data: blob:; ` +
      `script-src 'unsafe-inline' https: blob:">` +
      `<style>:root{${vars}}html,body{margin:0;padding:0;background:var(--bg);` +
      `color:var(--text-primary);font-family:-apple-system,BlinkMacSystemFont,sans-serif;` +
      `font-size:12px;line-height:1.4}*{box-sizing:border-box}</style>` +
      `<script>${this.escapeInline(shimSource)}</` + `script>`;
    if (role === 'view') return head + body;
    return `${head}<script type="module">${this.escapeInline(body)}</` + `script>`;
  }

  ensureLogic(): void {
    if (this.logicFrame || this.spec.logicSource == null) return;
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.style.display = 'none';
    frame.setAttribute('aria-hidden', 'true');
    frame.srcdoc = this.frameDoc('logic', this.spec.logicSource);
    document.body.appendChild(frame);
    this.logicFrame = frame;
    trackFrame(frame);
  }

  /** Mount a view frame (renderView). `viewCtx` backs view-level calls. */
  attachView(frame: HTMLIFrameElement, viewCtx: PluginViewCtx): void {
    if (this.spec.viewSource == null) return;
    frame.srcdoc = this.frameDoc('view', this.spec.viewSource);
    this.views.set(frame, viewCtx);
    trackFrame(frame);
    // Views typically want the logic frame up to talk to it via `peer`.
    this.ensureLogic();
  }

  detachView(frame: HTMLIFrameElement): void {
    if (this.views.delete(frame)) untrackFrame(frame);
  }

  /** Refresh the renderView ctx — it's rebuilt every render. */
  updateViewCtx(frame: HTMLIFrameElement, viewCtx: PluginViewCtx): void {
    if (this.views.has(frame)) this.views.set(frame, viewCtx);
  }

  private postLogic(msg: HostMessage): void {
    if (this.logicFrame) postTo(this.logicFrame, msg);
  }

  private postViews(msg: HostMessage): void {
    for (const frame of this.views.keys()) postTo(frame, msg);
  }

  private sessionInfo(sessionId: string | undefined): SessionInfo | undefined {
    const s =
      sessionId != null
        ? sandboxRuntime.getSessions?.().find((x) => x.id === sessionId)
        : undefined;
    return s ? toSessionInfo(s, this.id) : undefined;
  }

  /** Forward a session lifecycle event to the logic frame (fire-and-forget). */
  forward(hook: string, sessionId: string | undefined, data?: unknown): void {
    if (!this.subscribed.has(hook as never)) return;
    this.postLogic({
      axn: 'plugin-v1',
      type: 'event',
      hook: hook as never,
      sessionId,
      session: this.sessionInfo(sessionId),
      data,
    });
  }

  /** Forward an event expecting a response (line/command/completeArg). */
  request(
    hook: 'line' | 'command' | 'completeArg',
    sessionId: string,
    data: unknown,
  ): Promise<unknown> {
    if (!this.subscribed.has(hook)) return Promise.resolve(undefined);
    const requestId = ++this.reqSeq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(undefined);
      }, EVENT_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, timer });
      this.postLogic({
        axn: 'plugin-v1',
        type: 'event',
        hook,
        sessionId,
        session: this.sessionInfo(sessionId),
        data,
        requestId,
      });
    });
  }

  private async dispatchCall(
    method: string,
    sessionId: string | undefined,
    args: unknown[],
    viewCtx: PluginViewCtx | undefined,
  ): Promise<unknown> {
    const a = <T,>(i: number) => args[i] as T;
    const needed = methodPermission(method);
    if (needed && !this.allows(needed)) {
      throw new Error(`${method} needs the '${needed}' permission — declare it in plugin.json "permissions"`);
    }
    if (sessionId != null) {
      const ctx = this.plugin
        ? sandboxRuntime.buildApi?.(this.plugin, sessionId) ?? null
        : (viewCtx?.sessionApi?.(sessionId) ?? null);
      if (!ctx) throw new Error(`session ${sessionId} unavailable`);
      switch (method) {
        case 'writeToSession': return ctx.writeToSession(a(0));
        case 'exec': return ctx.exec(a(0), a(1));
        case 'getCwd': return ctx.getCwd();
        case 'waitForSessionOutput': return ctx.waitForSessionOutput(a(0));
        case 'getScreenLines': return ctx.getScreenLines();
        case 'readFile': return ctx.readFile(a(0), a(1));
        case 'writeFile': return ctx.writeFile(a(0), a(1), a(2));
        case 'statPath': return ctx.statPath(a(0), a(1));
        case 'mkdir': return ctx.mkdir(a(0), a(1));
        case 'openBrowser': return ctx.openBrowser(a(0));
        case 'openTab': return ctx.openTab(a(0));
        case 'openSubShell': return ctx.openSubShell(a(0), a(1), a(2), a(3));
        case 'openSession': return ctx.openSession(a(0), a(1), a(2), a(3));
        case 'getWorkspace': return ctx.getWorkspace();
        case 'getWorkspaces': return ctx.getWorkspaces?.() ?? [];
        case 'runCommand': return ctx.runCommand?.(a(0) as string) ?? undefined;
        case 'activateTab': return ctx.activateTab?.(a(0) as string) ?? false;
        case 'updatePluginState': return ctx.updatePluginState(a(0));
        case 'setAttention': return ctx.setAttention(a(0));
        case 'setBanner': return ctx.setBanner(a(0));
        case 'setRestoring': return ctx.setRestoring(a(0));
        case 'isProgressHandled': return ctx.isProgressHandled();
        case 'getSession': return toSessionInfo(ctx.getSession(), this.id);
        default: throw new Error(`unknown session method ${method}`);
      }
    }
    switch (method) {
      case 'getSessions':
        return (sandboxRuntime.getSessions?.() ?? []).map((s) =>
          toSessionInfo(s, this.id),
        );
      case 'updateAppState':
        viewCtx?.updateAppState(a(0) as Record<string, unknown>);
        sandboxRuntime.mergePluginData?.(this.id, a(0) as Record<string, unknown>);
        return undefined;
      case 'selectSession':
        return viewCtx?.selectSession(a(0) as string) ??
          sandboxRuntime.selectSession?.(a(0) as string);
      case 'closeView':
        return viewCtx?.close();
      case 'openTab':
        return viewCtx?.openTab?.(a(0) as never);
      default:
        throw new Error(`unknown method ${method}`);
    }
  }

  private route(e: MessageEvent): void {
    const data = e.data;
    if (!isFrameMessage(data)) return;
    let viewCtx: PluginViewCtx | undefined;
    for (const [frame, ctx] of this.views) {
      if (frame.contentWindow === e.source) {
        viewCtx = ctx;
        break;
      }
    }
    const isView = viewCtx !== undefined;
    const isLogic =
      this.logicFrame != null && e.source === this.logicFrame.contentWindow;
    if (!isView && !isLogic) return;
    const respondTo = e.source as Window;
    const stateKey = this.id;
    switch (data.type) {
      case 'ready': {
        respondTo.postMessage(
          {
            axn: 'plugin-v1',
            type: 'init',
            role: isView ? 'view' : 'logic',
            apiVersion: AXN_PLUGIN_API_VERSION,
            theme: collectTheme(),
            settings: sandboxRuntime.getPluginSettings?.(stateKey),
            appState: sandboxRuntime.getPluginData?.(stateKey),
          } satisfies HostMessage,
          '*',
        );
        if (isView) {
          respondTo.postMessage(
            {
              axn: 'plugin-v1',
              type: 'sessions',
              sessions: (sandboxRuntime.getSessions?.() ?? []).map((s) =>
                toSessionInfo(s, stateKey),
              ),
            } satisfies HostMessage,
            '*',
          );
        }
        break;
      }
      case 'subscribe': {
        if (isView) break;
        this.subscribed = new Set(
          data.hooks.filter((hook) => {
            const needed = hookPermission(hook);
            if (!needed || this.allows(needed)) return true;
            axnLog('warn', 'plugins', `${this.id}: '${hook}' hook needs the '${needed}' permission — not delivered`);
            return false;
          }),
        );
        // Replay sessionOpen for sessions that predate the subscription so a
        // mid-run enable still sees the full world — once; every axn.on()
        // re-posts its hook list.
        if (this.subscribed.has('sessionOpen') && !this.sessionOpenReplayed) {
          this.sessionOpenReplayed = true;
          for (const s of sandboxRuntime.getSessions?.() ?? []) {
            this.postLogic({
              axn: 'plugin-v1',
              type: 'event',
              hook: 'sessionOpen',
              sessionId: s.id,
              session: toSessionInfo(s, stateKey),
            });
          }
        }
        break;
      }
      case 'call': {
        const id = data.id;
        const timer = setTimeout(
          () =>
            respondTo.postMessage(
              { axn: 'plugin-v1', type: 'result', id, ok: false, error: 'timeout' } satisfies HostMessage,
              '*',
            ),
          CALL_TIMEOUT_MS,
        );
        this.dispatchCall(data.method, data.sessionId, data.args, viewCtx)
          .then((value) => {
            clearTimeout(timer);
            respondTo.postMessage(
              { axn: 'plugin-v1', type: 'result', id, ok: true, value } satisfies HostMessage,
              '*',
            );
          })
          .catch((err: unknown) => {
            clearTimeout(timer);
            respondTo.postMessage(
              {
                axn: 'plugin-v1',
                type: 'result',
                id,
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              } satisfies HostMessage,
              '*',
            );
          });
        break;
      }
      case 'respond': {
        const p = this.pending.get(data.requestId);
        if (p) {
          this.pending.delete(data.requestId);
          clearTimeout(p.timer);
          p.resolve(data.result);
        }
        break;
      }
      case 'surface':
        if (data.sessionId) setSurface(this.id, data.sessionId, data.surface, data.html);
        break;
      case 'peer': {
        const msg: HostMessage = { axn: 'plugin-v1', type: 'peer', payload: data.payload };
        if (isView) this.postLogic(msg);
        else this.postViews(msg);
        break;
      }
    }
  }

  /** Push current sessions/appState into all view frames. */
  pushViewData(): void {
    if (this.views.size === 0) return;
    this.postViews({
      axn: 'plugin-v1',
      type: 'sessions',
      sessions: (sandboxRuntime.getSessions?.() ?? []).map((s) =>
        toSessionInfo(s, this.id),
      ),
    });
    this.postViews({
      axn: 'plugin-v1',
      type: 'appState',
      value: sandboxRuntime.getPluginData?.(this.id),
    });
  }

  dispose(): void {
    window.removeEventListener('message', this.onMessage);
    if (this.logicFrame) {
      untrackFrame(this.logicFrame);
      this.logicFrame.remove();
      this.logicFrame = null;
    }
    for (const frame of this.views.keys()) untrackFrame(frame);
    this.views.clear();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.resolve(undefined);
    }
    this.pending.clear();
    this.subscribed.clear();
    for (const key of [...surfaces.keys()]) {
      if (key.startsWith(`${this.id}|`)) surfaces.delete(key);
    }
    surfaceListeners.forEach((fn) => fn());
  }
}

// ---------------------------------------------------------------------------
// Registry + plugin stub construction
// ---------------------------------------------------------------------------

const sandboxes = new Map<string, PluginSandbox>();

/** Called by ShellApp when the enabled set changes: boots enabled sandboxed
 * plugins, tears down disabled ones. */
export function syncSandboxes(
  plugins: readonly SessionViewPlugin[],
  enabledIds: Set<string>,
): void {
  for (const p of plugins) {
    if (!isSandboxedPlugin(p)) continue;
    if (enabledIds.has(p.id)) {
      if (!sandboxes.has(p.id)) {
        const sb = new PluginSandbox(p.sandbox);
        sb.plugin = p;
        sandboxes.set(p.id, sb);
      }
    } else {
      sandboxes.get(p.id)?.dispose();
      sandboxes.delete(p.id);
    }
  }
}

/** Pushes fresh sessions/appState into every open plugin view frame. */
export function pushSandboxViewData(): void {
  for (const sb of sandboxes.values()) sb.pushViewData();
}

/** Build the SessionViewPlugin stub for a sandboxed plugin directory. */
export function sandboxedPlugin(spec: SandboxPluginSpec): SandboxedPlugin {
  const m = spec.manifest;
  const sandbox = () => sandboxes.get(m.id);
  const stub: SandboxedPlugin = {
    id: m.id,
    title: m.title,
    logo: m.logo,
    version: m.version,
    stateKey: m.id,
    settingsKey: m.id,
    defaultEnabled: false,
    processPattern: m.processPattern ? new RegExp(m.processPattern) : undefined,
    handlesProgress: m.handlesProgress,
    settings: m.settings,
    hostsTabs: m.hostsTabs,
    commands: (m.commands ?? []).map((decl) => ({
      name: decl.name,
      takesArg: decl.takesArg,
      argCompletion: decl.argCompletion,
      completeArg: decl.completeArg
        ? (ctx, prefix) =>
            sandbox()?.request('completeArg', ctx.session.id, {
              name: decl.name,
              argPrefix: prefix,
            }) as Promise<string[]>
        : undefined,
      run: async (ctx, arg, line) => {
        const result = (await sandbox()?.request('command', ctx.session.id, {
          name: decl.name,
          arg,
          line,
        })) as string | false | void;
        // a replacement line is typed into the shell — that is terminal input
        if (typeof result === 'string' && !hasPermission(m, 'terminal-input')) {
          axnLog('warn', 'plugins', `${m.id}: ${decl.name} replacement refused — needs the 'terminal-input' permission`);
          return false;
        }
        return result;
      },
    })),
    onSessionOpen: (ctx) => sandbox()?.forward('sessionOpen', ctx.session.id),
    onOutput: (ctx, text) => sandbox()?.forward('output', ctx.session.id, { text }),
    onClose: (ctx) => sandbox()?.forward('close', ctx.session.id),
    onProcessEnd: (ctx) => sandbox()?.forward('processEnd', ctx.session.id),
    onSubShellExit: (ctx, tabId, exitCode) =>
      sandbox()?.forward('subShellExit', ctx.session.id, { tabId, exitCode }),
    onBannerAction: (ctx, actionId) =>
      sandbox()?.forward('bannerAction', ctx.session.id, { actionId }),
    onCommand: (ctx, line) => {
      const sb = sandbox();
      if (!sb?.subscribed.has('line')) return undefined;
      return sb.request('line', ctx.session.id, { line }) as Promise<
        string | false | void
      >;
    },
    // The two pushed surfaces (`axn.setSurface('row'|'render', …)`) are
    // offered as session fields like any in-process plugin's.
    sessionFields: [
      {
        id: 'row',
        label: `${m.title} (badge)`,
        kind: 'inline',
        zone: 'title',
        value: (ctx) => (
          <SandboxedSurface pluginId={m.id} sessionId={ctx.session.id} surface="row" />
        ),
      },
      {
        id: 'panel',
        label: m.title,
        kind: 'block',
        zone: 'selected',
        value: (ctx) => (
          <SandboxedSurface pluginId={m.id} sessionId={ctx.session.id} surface="render" />
        ),
      },
    ],
    sandbox: spec,
  };
  if (spec.viewSource != null) {
    stub.renderRail = ({ viewActive, toggleView }) => (
      <button
        type="button"
        onClick={toggleView}
        data-tip={m.title}
        className={`flex h-8 w-8 items-center justify-center rounded transition ${
          viewActive
            ? 'bg-[var(--accent)] text-[var(--text-inverted)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]'
        }`}
      >
        <Puzzle size={16} />
      </button>
    );
    stub.renderView = (viewCtx) => <SandboxedView spec={spec} viewCtx={viewCtx} />;
  }
  return stub;
}

/** The plugin's view frame mounted into the main area. */
function SandboxedView({
  spec,
  viewCtx,
}: {
  spec: SandboxPluginSpec;
  viewCtx: PluginViewCtx;
}) {
  const ref = useRef<HTMLIFrameElement | null>(null);
  const ctxRef = useRef(viewCtx);
  ctxRef.current = viewCtx;

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    sandboxes.get(spec.manifest.id)?.attachView(frame, ctxRef.current);
    return () => {
      sandboxes.get(spec.manifest.id)?.detachView(frame);
    };
  }, [spec]);

  // Keep view frames fed with live session/app state and a fresh ctx.
  useEffect(() => {
    const sb = sandboxes.get(spec.manifest.id);
    if (ref.current) sb?.updateViewCtx(ref.current, viewCtx);
    sb?.pushViewData();
  }, [spec, viewCtx]);

  return (
    <iframe
      ref={ref}
      title={spec.manifest.title}
      sandbox="allow-scripts"
      className="h-full w-full border-0"
      style={{ background: 'var(--bg)' }}
    />
  );
}
