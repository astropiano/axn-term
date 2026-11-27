/**
 * Text targets — things plugins recognize in text the app shows (terminal
 * output, chips) and offer actions on from a hover card.
 *
 * Two plugin hooks feed it (`SessionViewPlugin.textTargets` and
 * `.targetActions`); the core never names a plugin. A *reader* turns text or
 * a URL into a typed target (the jira plugin: a project key → `ticket`); a
 * plugin's `targetActions` contributes buttons for a target (the worktrees
 * plugin: "Start worktree"). ShellApp registers the host that knows the
 * enabled plugins, their settings and how to build their `PluginApi`; the
 * terminal link provider and `ChipView` only ask it.
 *
 * Card order is fixed by the host, not the plugins: a target with a URL
 * always leads with "Open link", plugin actions follow, a copy action ends
 * it — so a URL that gains hover actions never loses its plain open.
 */

import type { ReactNode } from 'react';
import type { ShellSession } from '../types';
import type { PluginSettings } from './pluginSettings';
import type { PluginApi, SessionViewContext, SessionViewPlugin } from './session-plugins/plugin';

/** A ticket of an issue tracker. */
export interface TicketTarget {
  kind: 'ticket';
  /** Uppercased key, e.g. `AIACC-123`. */
  key: string;
  /** The tracker's page for it, when the reader knows one. */
  url?: string;
  /** Plugin id of the reader that recognized it. */
  source: string;
  /** Summary when already known (cached enrichment). */
  summary?: string;
  /** Looks the summary up (a tracker request); undefined when it can't. */
  resolveSummary?: () => Promise<string | undefined>;
}

export type TextTarget = TicketTarget;

/** A target found in a line of text, `[start, end)`. */
export interface TargetMatch {
  start: number;
  end: number;
  target: TextTarget;
}

/** Recognizes a plugin's targets — synchronous and cheap, it runs per terminal line. */
export interface TextTargetReader {
  /** Bare occurrences in a line of text. */
  scan?: (text: string, pluginSettings: unknown) => TargetMatch[];
  /** A URL this plugin's target lives at. */
  fromUrl?: (url: string, pluginSettings: unknown) => TextTarget | null | undefined;
}

/** One button on a target's hover card. */
export interface TargetAction {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Shown as the button's tooltip. */
  tip?: string;
  /** Runs the action; the card closes when it resolves. Report failures yourself (banner/attention). */
  run: () => void | Promise<void>;
}

/** What a plugin's `targetActions` gets besides the target. */
export interface TargetActionContext {
  pluginSettings: unknown;
  /** All plugin settings (e.g. another plugin's repo roots). */
  settings: PluginSettings;
  /** The session the hover happened in (or the selected one). */
  originSessionId?: string;
  /** A `PluginApi` of this plugin bound to `sessionId` — default: the origin session, else any. */
  api: (sessionId?: string) => (SessionViewContext & PluginApi) | undefined;
  sessions: ShellSession[];
  selectSession: (sessionId: string) => void;
}

export interface TargetHost {
  scan(text: string): TargetMatch[];
  fromUrl(url: string): TextTarget | undefined;
  actions(target: TextTarget, originSessionId?: string): TargetAction[];
}

let host: TargetHost | undefined;

/** ShellApp installs the host; the returned function removes it again. */
export function registerTargetHost(next: TargetHost): () => void {
  host = next;
  return () => {
    if (host === next) host = undefined;
  };
}

/** Targets in a line of text, non-overlapping, leftmost first (first reader wins a tie). */
export function scanTextTargets(text: string): TargetMatch[] {
  return host?.scan(text) ?? [];
}

export function textTargetFromUrl(url: string): TextTarget | undefined {
  return host?.fromUrl(url);
}

export function textTargetActions(target: TextTarget, originSessionId?: string): TargetAction[] {
  return host?.actions(target, originSessionId) ?? [];
}

/** Identity of a target, for "same card already open" checks. */
export function targetId(target: TextTarget): string {
  return `${target.kind}:${target.source}:${target.key}`;
}

/** What `createTargetHost` needs from the app. */
export interface TargetHostDeps {
  /** Enabled plugins, in registration order. */
  plugins: () => SessionViewPlugin[];
  settings: () => PluginSettings;
  sessions: () => ShellSession[];
  selectedSessionId: () => string | undefined;
  buildApi: (
    session: ShellSession,
    plugin: SessionViewPlugin,
  ) => (SessionViewContext & PluginApi) | undefined;
  selectSession: (sessionId: string) => void;
}

/** The host over the enabled plugins' `textTargets`/`targetActions`. A throwing plugin contributes nothing. */
export function createTargetHost(deps: TargetHostDeps): TargetHost {
  const settingsOf = (p: SessionViewPlugin) => deps.settings()[p.settingsKey ?? p.id];
  return {
    scan(text) {
      const all: TargetMatch[] = [];
      for (const p of deps.plugins()) {
        const scan = p.textTargets?.scan;
        if (!scan) continue;
        try {
          all.push(...scan(text, settingsOf(p)));
        } catch {
          /* a broken reader contributes nothing */
        }
      }
      // Stable sort keeps reader order on equal starts; drop overlaps.
      all.sort((a, b) => a.start - b.start);
      const out: TargetMatch[] = [];
      for (const m of all) {
        const last = out[out.length - 1];
        if (!last || m.start >= last.end) out.push(m);
      }
      return out;
    },
    fromUrl(url) {
      for (const p of deps.plugins()) {
        const fromUrl = p.textTargets?.fromUrl;
        if (!fromUrl) continue;
        try {
          const target = fromUrl(url, settingsOf(p));
          if (target) return target;
        } catch {
          /* next reader */
        }
      }
      return undefined;
    },
    actions(target, originSessionId) {
      const origin = originSessionId ?? deps.selectedSessionId();
      const out: TargetAction[] = [];
      for (const p of deps.plugins()) {
        if (!p.targetActions) continue;
        const api: TargetActionContext['api'] = (sessionId) => {
          const sessions = deps.sessions();
          const s =
            sessions.find((x) => x.id === (sessionId ?? origin)) ??
            (sessionId ? undefined : sessions[0]);
          return s ? deps.buildApi(s, p) : undefined;
        };
        try {
          out.push(
            ...p.targetActions(target, {
              pluginSettings: settingsOf(p),
              settings: deps.settings(),
              originSessionId: origin,
              api,
              sessions: deps.sessions(),
              selectSession: deps.selectSession,
            }),
          );
        } catch {
          /* a broken provider contributes nothing */
        }
      }
      return out;
    },
  };
}
