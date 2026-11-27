import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Copy, ExternalLink, Eye, FolderOpen, FolderSearch, Image as ImageIcon, Pencil } from 'lucide-react';
import { decodeImageRgba, imageMimeFor } from './imageMime';
import { revealLabel as defaultRevealLabel } from './platform';
import { useShellServices } from './services';
import { menuItemClass, menuDividerClass } from './ContextMenu';

export type HoverFileKind = 'dir' | 'image' | 'text' | 'binary' | 'unreadable';

const PREVIEW_LINES = 40;
const PREVIEW_MAX_CHARS = 8000;

const IMAGE_PREVIEW_MAX_WIDTH = 352;
const IMAGE_PREVIEW_MAX_HEIGHT = 256;

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif|ico|svg)$/i;

export function FileHoverPreview({
  resolvedPath,
  isDir,
  sessionId,
  onKindChange,
  onPreview,
}: {
  resolvedPath: string;
  isDir: boolean;
  /** Routes file reads to the owning session's filesystem. */
  sessionId?: string;
  onKindChange?: (kind: HoverFileKind) => void;
  /** When set, the inline image thumbnail becomes a button opening a preview tab. */
  onPreview?: () => void;
}) {
  const { t } = useLingui();
  const { fileReader } = useShellServices();
  const [preview, setPreview] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  useEffect(() => {
    if (isDir) {
      setPreview(t`Directory`);
      onKindChange?.('dir');
      return;
    }
    const reader = fileReader(sessionId);
    if (!reader) {
      setPreview(t`Preview unavailable`);
      onKindChange?.('unreadable');
      return;
    }
    if (IMAGE_EXT.test(resolvedPath) && reader.readBytes) {
      let live = true;
      let objectUrl: string | null = null;
      reader
        .readBytes(resolvedPath)
        .then((bytes) => {
          if (!live) return;
          objectUrl = URL.createObjectURL(
            new Blob([bytes as BlobPart], { type: imageMimeFor(resolvedPath) }),
          );
          setImageUrl(objectUrl);
          onKindChange?.('image');
        })
        .catch(() => {
          if (live) {
            setPreview(t`Unable to read file`);
            onKindChange?.('unreadable');
          }
        });
      return () => {
        live = false;
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      };
    }
    let live = true;
    reader
      .readText(resolvedPath)
      .then((contents) => {
        if (!live) return;
        if (contents.includes('\u0000')) {
          setPreview(t`Binary file`);
          onKindChange?.('binary');
          return;
        }
        const truncated = contents.split('\n').slice(0, PREVIEW_LINES).join('\n');
        setPreview(truncated.slice(0, PREVIEW_MAX_CHARS));
        onKindChange?.('text');
      })
      .catch(() => {
        if (live) {
          setPreview(t`Unable to read file`);
          onKindChange?.('unreadable');
        }
      });
    return () => {
      live = false;
    };
  }, [resolvedPath, isDir, sessionId, onKindChange, fileReader, t]);

  if (imageUrl) {
    const img = (
      <img
        src={imageUrl}
        alt={resolvedPath}
        style={{ maxWidth: IMAGE_PREVIEW_MAX_WIDTH, maxHeight: IMAGE_PREVIEW_MAX_HEIGHT }}
        className="rounded"
      />
    );
    if (!onPreview) return img;
    return (
      <button
        type="button"
        onClick={onPreview}
        data-tip={t`Open preview in a tab`}
        className="block cursor-zoom-in"
      >
        {img}
      </button>
    );
  }
  if (preview === null) {
    return (
      <div className="text-[11px] text-[var(--text-secondary)]">
        <Trans>Loading…</Trans>
      </div>
    );
  }
  return (
    <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-snug text-[var(--text-primary)]">
      {preview}
    </pre>
  );
}

export const actionButtonClass =
  'flex shrink-0 items-center gap-1 rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 text-[11px] text-[var(--text-primary)] transition hover:text-[var(--accent)]';

/** Item/divider styles live in ContextMenu; re-exported for existing imports. */
export { menuItemClass, menuDividerClass };

/**
 * Path actions + preview shared by the terminal hover card and the browser
 * context menu: Open/Edit, Reveal in the OS file manager, Copy Path, and a
 * content preview. `inline` renders a single row of pill buttons for the
 * hover card; `menu` renders a vertical context-menu list. OS-level actions
 * (reveal/open-directory) hide themselves when the injected services do not
 * provide them.
 */
export function PathActionMenu({
  resolvedPath,
  isDir,
  isUrl = false,
  copyOnly = false,
  variant = 'inline',
  sessionId,
  onEdit,
  onOpenDir,
  onPreview,
  onDismiss,
  extraItems,
}: {
  resolvedPath: string;
  isDir: boolean;
  isUrl?: boolean;
  copyOnly?: boolean;
  /** `inline` = compact one-line pill row; `menu` = vertical context menu. */
  variant?: 'inline' | 'menu';
  /** Routes file reads to the owning session's filesystem. */
  sessionId?: string;
  onEdit?: (path: string) => void;
  /** Overrides the default open-directory behaviour for directories. */
  onOpenDir?: (path: string) => void;
  /** Opens a read-only preview tab rendered by the matching preview plugin. */
  onPreview?: (path: string) => void;
  onDismiss?: () => void;
  /**
   * Extra menu rows appended after the built-in actions (menu variant only).
   * Use `menuItemClass`/`menuDividerClass` for consistent styling.
   */
  extraItems?: ReactNode;
}) {
  const { t } = useLingui();
  const { services, fileReader } = useShellServices();
  const [fileKind, setFileKind] = useState<HoverFileKind | null>(null);
  const isMenu = variant === 'menu';
  const itemClass = isMenu ? menuItemClass : actionButtonClass;
  const iconClass = isMenu ? 'h-3.5 w-3.5 shrink-0' : 'h-3 w-3';
  const hasPreview = !isUrl && !isDir && services.hasFilePreview?.(resolvedPath) === true;
  const openPreview =
    hasPreview && onPreview
      ? () => {
          onDismiss?.();
          onPreview(resolvedPath);
        }
      : undefined;
  const openDir = onOpenDir ?? services.openDirectory;
  const reveal = services.revealPath;
  const revealText = services.revealLabel ?? defaultRevealLabel;

  useEffect(() => {
    setFileKind(null);
  }, [resolvedPath]);

  const actions = copyOnly ? (
    <button
      type="button"
      onClick={() => {
        void services.copyText(resolvedPath);
      }}
      data-tip={t`Copy selection`}
      className={itemClass}
    >
      <Copy className={iconClass} />
      <Trans>Copy</Trans>
    </button>
  ) : (
    <>
      {isUrl ? (
        <button
          type="button"
          onClick={() => {
            onDismiss?.();
            services.openExternal(resolvedPath);
          }}
          className={itemClass}
        >
          <ExternalLink className={iconClass} />
          <Trans>Open</Trans>
        </button>
      ) : isDir ? (
        openDir && (
          <button
            type="button"
            onClick={() => {
              onDismiss?.();
              openDir(resolvedPath);
            }}
            className={itemClass}
          >
            <FolderOpen className={iconClass} />
            <Trans>Open</Trans>
          </button>
        )
      ) : (
        fileKind === 'text' && (
          <button
            type="button"
            onClick={() => {
              onDismiss?.();
              onEdit?.(resolvedPath);
            }}
            className={itemClass}
          >
            <Pencil className={iconClass} />
            <Trans>Edit</Trans>
          </button>
        )
      )}
      {openPreview && (
        <button type="button" onClick={openPreview} className={itemClass}>
          <Eye className={iconClass} />
          <Trans>Preview</Trans>
        </button>
      )}
      {!isUrl && reveal && (
        <button
          type="button"
          onClick={() => {
            onDismiss?.();
            reveal(resolvedPath);
          }}
          className={itemClass}
        >
          <FolderSearch className={iconClass} />
          {revealText}
        </button>
      )}
      <button
        type="button"
        onClick={() => {
          void services.copyText(resolvedPath);
        }}
        data-tip={isUrl ? t`Copy URL` : t`Copy Path`}
        className={itemClass}
      >
        <Copy className={iconClass} />
        {isUrl ? t`Copy URL` : t`Copy Path`}
      </button>
      {fileKind === 'image' && services.copyImage && (
        <button
          type="button"
          onClick={() => {
            void fileReader(sessionId)
              ?.readBytes?.(resolvedPath)
              .then((bytes) => decodeImageRgba(bytes, imageMimeFor(resolvedPath)))
              .then((img) => services.copyImage?.(img))
              .catch(() => {});
          }}
          data-tip={t`Copy image to clipboard`}
          className={itemClass}
        >
          <ImageIcon className={iconClass} />
          <Trans>Copy</Trans>
        </button>
      )}
      {extraItems}
    </>
  );

  const preview =
    !copyOnly &&
    (isUrl ? (
      isMenu ? (
        <div className="max-h-64 overflow-auto px-1.5 pb-1 pt-0.5">
          <div className="break-all font-mono text-[11px] leading-snug text-[var(--text-primary)]">
            {resolvedPath}
          </div>
        </div>
      ) : null
    ) : (
      <div className={isMenu ? 'max-h-64 overflow-auto px-1.5 pb-1 pt-0.5' : 'max-h-64 overflow-auto p-2'}>
        <FileHoverPreview
          resolvedPath={resolvedPath}
          isDir={isDir}
          sessionId={sessionId}
          onKindChange={setFileKind}
          onPreview={openPreview}
        />
      </div>
    ));

  if (isMenu) {
    return (
      <div className="p-1">
        <div
          className="truncate px-2 py-1 font-mono text-[11px] text-[var(--text-secondary)]"
          data-tip={resolvedPath}
        >
          {resolvedPath}
        </div>
        <div className={menuDividerClass} />
        <div className="flex flex-col">{actions}</div>
        {preview && (
          <>
            <div className={menuDividerClass} />
            {preview}
          </>
        )}
      </div>
    );
  }

  return (
    <>
      <div className="px-2.5 py-2">
        <div className="flex flex-wrap items-center gap-1.5">{actions}</div>
        <div
          className="mt-1.5 break-all font-mono text-[11px] leading-tight text-[var(--text-secondary)] select-text"
        >
          {resolvedPath}
        </div>
      </div>
      {preview && (
        <>
          <div className="border-b border-[var(--border)]" />
          {preview}
        </>
      )}
    </>
  );
}
