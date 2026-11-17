import { gitStatusPlugin } from './gitStatus';
import { gitInspectPlugin } from './gitInspect';
import { awesomeListPlugin } from './awesomeList';
import { glabMrPlugin } from './glabMr';
import { ghPrPlugin } from './ghPr';
import { jiraPlugin } from './jira';
import { devinPlugin } from './devinTasks';
import { claudePlugin } from './claude';
import { codexPlugin } from './codex';

import { antigravityPlugin } from './antigravity';

import { opencodePlugin } from './opencode';
import { devWorkflowPlugin } from './devWorkflow';
import { vibePlugin } from './vibe';
import { progressPlugin } from './progress';
import { ramPlugin } from './ram';
import { dockerPlugin } from './docker';
import { axnDevPlugin } from './axnDev';
import { worktreesPlugin } from './worktrees';
import { scratchpadPlugin } from './scratchpad';
import { remoteLinkPlugin } from './remoteLink';
import { agentsPlugin } from './agents';
import { externalViewsPlugin } from './externalViews';
import type { SessionViewPlugin } from './plugin';
import { parsePermissions, type PluginManifest } from '@axn-term/plugin-sdk';
import { registerExternalPreview } from '../preview-plugins';
import type { ExternalPreviewSpec } from '../preview-plugins';
import { sandboxedPlugin } from './sandbox';
import type { SandboxPluginSpec } from './sandbox';
import { axnLog } from '../log';
import { registerIconPlugin } from '../iconModel';

export * from './plugin';
export { gitStatusPlugin } from './gitStatus';
export { gitInspectPlugin } from './gitInspect';
export { awesomeListPlugin } from './awesomeList';
export { glabMrPlugin } from './glabMr';
export { ghPrPlugin } from './ghPr';
export { jiraPlugin } from './jira';
export { registerCardEnricher, CardChips } from './cardEnrichers';
export type { CardEnricher, CardSubject, CardEnrichment, CardChip } from './cardEnrichers';
export { devinPlugin } from './devinTasks';
export { claudePlugin } from './claude';
export { codexPlugin } from './codex';

export { antigravityPlugin } from './antigravity';

export { opencodePlugin } from './opencode';
export { devWorkflowPlugin } from './devWorkflow';
export { vibePlugin } from './vibe';
export { progressPlugin } from './progress';
export { ramPlugin } from './ram';
export { dockerPlugin } from './docker';
export { axnDevPlugin } from './axnDev';
export { worktreesPlugin } from './worktrees';
export { scratchpadPlugin } from './scratchpad';
export { agentsPlugin } from './agents';
export { parsePersonas, resolvePersona, listPersonas, registerPersonas } from './agentRegistry';
export type { AgentPersona } from './agentRegistry';

const defaultPlugins: SessionViewPlugin[] = [
  gitStatusPlugin,
  gitInspectPlugin,
  awesomeListPlugin,
  glabMrPlugin,
  ghPrPlugin,
  jiraPlugin,
  devinPlugin,
  claudePlugin,
  codexPlugin,

  antigravityPlugin,

  opencodePlugin,
  devWorkflowPlugin,
  vibePlugin,
  progressPlugin,
  ramPlugin,
  dockerPlugin,
  axnDevPlugin,
  worktreesPlugin,
  scratchpadPlugin,
  agentsPlugin,
  externalViewsPlugin,
  remoteLinkPlugin,
];

let plugins: SessionViewPlugin[] = [...defaultPlugins];

plugins.forEach(registerIconPlugin);

export function getSessionViewPlugins(): readonly SessionViewPlugin[] {
  return plugins;
}

export function registerSessionViewPlugin(plugin: SessionViewPlugin): void {
  plugins = [...plugins.filter((p) => p.id !== plugin.id), plugin];
  registerIconPlugin(plugin);
}

/**
 * Load external plugins from ~/.axn-term/plugins/*.mjs. Each module must
 * export the plugin object via `export default { ... }` (or a named `plugin`
 * export). External plugins are always opt-in: they must be enabled in
 * plugins.yaml via `<id>.enabled: true`.
 *
 * The module source is read through the host (`source` — desktop reads
 * ~/.axn-term/plugins via Tauri commands; web has no plugin dir and passes
 * none) and imported from a blob URL. `render` may return a plain string
 * instead of JSX.
 *
 * A plugin object may also carry a `preview` capability (`{ extensions |
 * match, render }`) which is registered as a file-preview plugin — it shares
 * the plugin's plugins.yaml enable toggle. Its `render` may return an HTML
 * string (sanitized before injection).
 */
export interface ExternalPluginSource {
  list(): Promise<string[]>;
  read(name: string): Promise<string>;
  /** Sandboxed plugin directories (`~/.axn-term/plugins/<dir>/`). */
  listDirs?(): Promise<string[]>;
  /** Read a file inside a sandboxed plugin directory. */
  readFile?(dir: string, name: string): Promise<string>;
}

export async function loadExternalPlugins(source: ExternalPluginSource): Promise<number> {
  let names: string[] = [];
  try {
    names = await source.list();
  } catch (e) {
    axnLog('error', 'plugins', `failed to list external plugins: ${String(e)}`);
    return 0;
  }
  let loaded = 0;
  for (const name of names) {
    try {
      const src = await source.read(name);
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      const mod = (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
      URL.revokeObjectURL(url);
      const candidate = (mod.default ?? mod.plugin) as SessionViewPlugin | undefined;
      if (!candidate || typeof candidate.id !== 'string' || !candidate.id) {
        axnLog('warn', 'plugins', `external plugin ${name} has no valid default export (missing id)`);
        continue;
      }
      // External plugins are opt-in by definition.
      registerSessionViewPlugin({ ...candidate, defaultEnabled: false });
      const preview = (candidate as { preview?: unknown }).preview;
      if (preview && typeof preview === 'object') {
        registerExternalPreview(
          candidate.id,
          candidate.settingsKey ?? candidate.id,
          preview as ExternalPreviewSpec,
        );
      }
      axnLog('info', 'plugins', `loaded external plugin ${candidate.id} from ${name}`);
      loaded++;
    } catch (e) {
      axnLog('error', 'plugins', `failed to load external plugin ${name}: ${String(e)}`);
    }
  }

  // Sandboxed plugin directories: <dir>/plugin.json + plugin.mjs (+ optional
  // index.html view). The plugin code runs inside `sandbox="allow-scripts"`
  // iframes and talks to the host over the plugin-sdk postMessage contract.
  if (source.listDirs && source.readFile) {
    let dirs: string[] = [];
    try {
      dirs = await source.listDirs();
    } catch (e) {
      axnLog('error', 'plugins', `failed to list plugin directories: ${String(e)}`);
    }
    for (const dir of dirs) {
      try {
        const manifest = JSON.parse(
          await source.readFile(dir, 'plugin.json'),
        ) as PluginManifest;
        if (!manifest.id || !manifest.title) {
          axnLog('warn', 'plugins', `${dir}/plugin.json needs id + title`);
          continue;
        }
        const { permissions, unknown } = parsePermissions(manifest.permissions);
        if (unknown.length) {
          axnLog('warn', 'plugins', `${dir}/plugin.json: unknown permissions ignored: ${unknown.join(', ')}`);
        }
        manifest.permissions = permissions;
        const spec: SandboxPluginSpec = { dir, manifest };
        try {
          spec.logicSource = await source.readFile(dir, manifest.logic ?? 'plugin.mjs');
        } catch {
          // no logic file — view-only plugins are fine
        }
        const viewName = manifest.view ?? 'index.html';
        try {
          spec.viewSource = await source.readFile(dir, viewName);
        } catch {
          if (manifest.view) {
            axnLog('warn', 'plugins', `${dir}: declared view ${viewName} not readable`);
          }
        }
        registerSessionViewPlugin(sandboxedPlugin(spec));
        axnLog('info', 'plugins', `loaded sandboxed plugin ${manifest.id} from ${dir}/`);
        loaded++;
      } catch (e) {
        axnLog('error', 'plugins', `failed to load plugin dir ${dir}: ${String(e)}`);
      }
    }
  }
  return loaded;
}
