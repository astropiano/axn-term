import { open, save } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';

/**
 * Abstraction for saving and loading a workspace set snapshot.
 *
 * The desktop build uses native file dialogs and the Tauri fs plugin. A
 * browser build can provide an implementation backed by e.g. a remote sync
 * endpoint or `<input type="file">` / download links, without changing the
 * consumers in App.tsx or SessionPanel.tsx.
 */
export interface WorkspaceSetStorage {
  /**
   * Persist the JSON workspace-set snapshot and let the user pick the location
   * and filename. `defaultName` is the suggested file name (e.g.
   * `axn-term-state.json`). The implementation may simply ignore the prompt
   * (e.g. a browser download) or may throw on failure.
   */
  save(content: string, defaultName: string): Promise<void>;

  /**
   * Prompt the user to select a workspace-set file and return its contents.
   * Returns `null` when the user cancels the prompt.
   */
  load(): Promise<string | null>;
}

/**
 * Desktop implementation that uses native open/save dialogs and reads/writes
 * the selected file through the Tauri filesystem plugin. The selected path is
 * added to the fs scope by the dialog, so this works for any directory the
 * user can reach without pre-declaring it in capabilities.
 */
export const desktopWorkspaceSetStorage: WorkspaceSetStorage = {
  async save(content, defaultName) {
    const filters = [{ name: 'JSON', extensions: ['json'] }];
    const path = await save({ defaultPath: defaultName, filters });
    if (!path) return;
    await writeTextFile(path, content);
  },

  async load() {
    const filters = [{ name: 'JSON', extensions: ['json'] }];
    const selected = await open({ multiple: false, filters });
    if (!selected) return null;
    const path = Array.isArray(selected) ? selected[0] : selected;
    return readTextFile(path);
  },
};
