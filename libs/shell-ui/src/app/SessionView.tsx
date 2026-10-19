import { createPluginApi } from './session-plugins/plugin';
import { useSessionBackend } from '../services';
import type { SessionViewPlugin } from './session-plugins/plugin';
import type { AgentCli, ShellSession, Workspace } from '../types';
import { usePluginSettings } from './PluginSettingsProvider';

interface SessionViewProps {
  session: ShellSession;
  updateSession: (sessionId: string, patch: Partial<ShellSession>) => void;
  mergePluginState: (sessionId: string, stateKey: string, patch: Record<string, unknown>) => void;
  plugins: readonly SessionViewPlugin[];
  onOpenBrowser: (sessionId: string, path: string) => void;
  onOpenTab: (
    sessionId: string,
    tab: { path: string; kind: 'editor' | 'browser' | 'preview' | 'git' },
  ) => void;
  onOpenSubShell: (
    sessionId: string,
    command?: string,
    cwd?: string,
    label?: string,
    agent?: AgentCli,
  ) => string | undefined;
  onOpenSession: (workspaceId: string, cwd?: string, name?: string) => void;
  getWorkspaces: () => Workspace[];
  pluginData: Record<string, unknown>;
  mergePluginData: (key: string, patch: Record<string, unknown>) => void;
}

export function SessionView({ session, updateSession, mergePluginState, plugins, onOpenBrowser, onOpenTab, onOpenSubShell, onOpenSession, getWorkspaces, pluginData, mergePluginData }: SessionViewProps) {
  const backend = useSessionBackend();
  const { pluginSettings } = usePluginSettings();

  return (
    <>
      {plugins.map((plugin) => {
        if (!plugin.render) return null;
        return (
          <div key={plugin.id}>
            {plugin.render(
              createPluginApi(session, plugin, {
                backend,
                updateSession,
                mergePluginState,
                pluginSettings,
                plugins,
                openBrowser: onOpenBrowser,
                openTab: onOpenTab,
                openSubShell: onOpenSubShell,
                openSession: onOpenSession,
                getWorkspaces,
                pluginData,
                mergePluginData,
              }),
            )}
          </div>
        );
      })}
    </>
  );
}
