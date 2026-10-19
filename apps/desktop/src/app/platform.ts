import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { homeDir } from '@tauri-apps/api/path';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import {
  loadExternalPlugins,
  type ShellPlatform,
  type LogLevel,
} from '@axn-term/shell-ui';
import type { Unsubscribe } from '@axn-term/session-backend';
import { desktopWorkspaceSetStorage } from './workspaceSetStorage';

const appWindow = getCurrentWindow();

/** Turn Tauri's Promise<UnlistenFn> into a sync Unsubscribe. */
function syncSub(sub: Promise<() => void>): Unsubscribe {
  let unlisten: (() => void) | undefined;
  let active = true;
  void sub.then((fn) => {
    if (active) unlisten = fn;
    else fn();
  });
  return () => {
    active = false;
    unlisten?.();
  };
}

/**
 * Desktop ShellPlatform: Tauri window ops, state under ~/.axn-term, native
 * dialogs, external `.mjs` plugin loading from the app data dir.
 */
export const desktopPlatform: ShellPlatform = {
  homeDir: () => homeDir(),
  exePath: () => invoke<string>('current_exe_path'),
  emitLog: (level: LogLevel, target: string, message: string) => {
    emit('log', { level, target, message }).catch(() => {});
  },
  stateStore: {
    load: (windowId) => invoke<unknown>('load_window_state', { windowId }),
    save: (windowId, state) =>
      invoke('save_window_state', { windowId, windowState: state }),
    delete: (windowId) => invoke('delete_window_state', { windowId }),
  },
  pluginSettingsStore: {
    read: () => invoke<string | null>('read_plugins'),
    write: (content) => invoke('write_plugins', { content }),
    watch: (cb) => {
      let alive = true;
      let last: string | null | undefined;
      const tick = async () => {
        try {
          const raw = await invoke<string | null>('read_plugins');
          if (!alive || raw === last) return;
          last = raw;
          cb(raw);
        } catch {
          // transient read failure — retry on the next tick
        }
      };
      const timer = setInterval(() => void tick(), 1500);
      void tick();
      return () => {
        alive = false;
        clearInterval(timer);
      };
    },
  },
  workspaceSetStorage: desktopWorkspaceSetStorage,
  configStore: {
    load: () => invoke<string | null>('read_config'),
    save: async (yaml) => {
      try {
        await invoke('write_config', { content: yaml });
      } catch (e) {
        emit('log', { level: 'error', target: 'config', message: `config.yaml write failed: ${e}` }).catch(() => {});
      }
    },
    watch: (cb) => {
      let alive = true;
      let last: string | null | undefined;
      const tick = async () => {
        try {
          const raw = await invoke<string | null>('read_config');
          if (!alive || raw === last) return;
          last = raw;
          cb(raw);
        } catch {
          // transient read failure — retry on the next tick
        }
      };
      const timer = setInterval(() => void tick(), 1500);
      void tick();
      return () => {
        alive = false;
        clearInterval(timer);
      };
    },
  },
  configFileStorage: {
    save: async (content, defaultName) => {
      const path = await save({
        defaultPath: defaultName,
        filters: [{ name: 'YAML', extensions: ['yaml', 'yml'] }],
      });
      if (path) await writeTextFile(path, content);
    },
    load: async () => {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'YAML', extensions: ['yaml', 'yml'] }],
      });
      if (!selected) return null;
      return readTextFile(Array.isArray(selected) ? selected[0] : selected);
    },
  },
  autoCloseWhenEmpty: true,
  window: {
    id: appWindow.label,
    // Tauri fires close requests on the OS close button; preventDefault first
    // so the app can show its confirmation or flush state.
    onCloseRequested: (cb) =>
      syncSub(
        appWindow.onCloseRequested(async (event) => {
          event.preventDefault();
          await cb();
        }),
      ),
    destroy: () => appWindow.destroy(),
    close: () => void appWindow.close().catch(() => {}),
    createWindow: () => void invoke('create_window').catch(() => {}),
    deleteState: () => invoke('delete_window_state', { windowId: appWindow.label }),
    onOsShutdown: (cb) => syncSub(listen<void>('os-shutdown', () => cb())),
    onCloseWindow: (cb) =>
      syncSub(listen<string>('close-window', (event) => cb(event.payload))),
    onCloseNow: (cb) => syncSub(listen<void>('close-now', () => cb())),
  },
  onRemoteCommand: (cb) =>
    syncSub(
      listen<{ id: string; line: string }>('remote-command', (event) =>
        cb({ sessionId: event.payload.id, line: event.payload.line }),
      ),
    ),
  loadExternalPlugins: () =>
    loadExternalPlugins({
      list: () => invoke<string[]>('list_external_plugins'),
      read: (name) => invoke<string>('read_external_plugin', { name }),
      listDirs: () => invoke<string[]>('list_external_plugin_dirs'),
      readFile: (dir, name) =>
        invoke<string>('read_external_plugin_file', { dir, name }),
    }),
};
