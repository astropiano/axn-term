import { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { resolvePath, backendFileService } from './fileService';
import { useSessionBackend } from '../services';
import { appRuntime } from './appRuntime';
import { usePluginSettings } from './PluginSettingsProvider';
import { resolveFilePreviewPlugin } from './preview-plugins/plugin';
import { HtmlPreview } from './preview-plugins/html';
import type { FilePreviewContext } from './preview-plugins/plugin';
import { registerViewFocus } from './viewFocus';

function dirOf(path: string): string {
  return path.replace(/\/[^/]*$/, '') || '/';
}

interface PreviewViewProps {
  path: string;
  cwd?: string;
  isVisible?: boolean;
  /** Owning session's id; plugin-hosted tabs resolve any live session. */
  sessionId?: string;
  /** Register the scroll area as the tab's focus target for session switching. */
  focusId?: string;
}

/**
 * Read-only preview tab (`editors[].kind === 'preview'`). The first enabled
 * preview plugin claiming the path renders the body; the text fallback
 * plugin always matches, so `body` is never truly empty.
 */
export function PreviewView({ path, cwd, isVisible, sessionId: sessionIdProp, focusId }: PreviewViewProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // The tab's focus target for app navigation — focusing the scroll area
  // keeps arrow/space scrolling working after a session switch.
  useEffect(() => {
    if (!focusId) return;
    return registerViewFocus(focusId, () => scrollRef.current?.focus());
  }, [focusId]);
  const backend = useSessionBackend();
  const sessionId = sessionIdProp ?? appRuntime()?.resolveSessionId() ?? '';
  const { pluginSettings } = usePluginSettings();
  const [reloadKey, setReloadKey] = useState(0);
  // Restored preview tabs mount hidden; only render the body once the tab is
  // actually shown so lazy renderer chunks (mermaid, asciidoctor) and file
  // reads are not paid upfront.
  const [activated, setActivated] = useState(isVisible ?? false);
  useEffect(() => {
    if (isVisible) setActivated(true);
  }, [isVisible]);
  const plugin = resolveFilePreviewPlugin(path, pluginSettings);
  const resolvedPath = resolvePath(cwd, path);

  const ctx = useMemo<FilePreviewContext>(
    () => ({
      path,
      resolvedPath,
      cwd,
      pluginSettings: pluginSettings[plugin?.settingsKey ?? plugin?.id ?? ''],
      readFile: () => backendFileService(backend, sessionId).readFile(path, cwd),
      readBytes: () => {
        if (!backend.readBytes) return Promise.reject(new Error('binary reads not supported'));
        return backend.readBytes(sessionId, resolvedPath);
      },
      readSibling: (rel) => {
        if (!backend.readBytes) return Promise.reject(new Error('binary reads not supported'));
        return backend.readBytes(
          sessionId,
          rel.startsWith('/') ? resolvePath(undefined, rel) : resolvePath(dirOf(resolvedPath), rel),
        );
      },
      isVisible,
    }),
    [path, resolvedPath, cwd, plugin, pluginSettings, isVisible],
  );

  const body = activated ? plugin?.render(ctx) : null;

  return (
    <div className="flex h-full w-full flex-col bg-[var(--terminal-bg)]">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-secondary)] px-2">
        <span
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--text-secondary)]"
          data-tip={resolvedPath}
        >
          {resolvedPath}
        </span>
        {plugin && (
          <span className="shrink-0 text-[11px] text-[var(--text-secondary)]">
            {plugin.title}
          </span>
        )}
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          data-tip="Reload"
          aria-label="Reload"
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--text-secondary)] transition hover:bg-[var(--surface)] hover:text-[var(--accent)]"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>
      <div ref={scrollRef} tabIndex={-1} className="min-h-0 flex-1 overflow-auto">
        {plugin ? (
          <div key={`${resolvedPath}:${reloadKey}`} className="h-full">
            {typeof body === 'string' ? <HtmlPreview html={body} ctx={ctx} /> : body}
          </div>
        ) : (
          <div className="p-4 text-xs text-[var(--text-secondary)]">
            No preview available for this file.
          </div>
        )}
      </div>
    </div>
  );
}
