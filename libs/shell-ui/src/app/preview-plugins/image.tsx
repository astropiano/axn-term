import { useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Image as ImageIcon } from 'lucide-react';
import { extensionMatcher } from './plugin';
import type { FilePreviewContext, FilePreviewPlugin } from './plugin';
import { decodeImageRgba, IMAGE_MIME, imageMimeFor } from '../../imageMime';
import { shellServices } from '../../services';

export { IMAGE_MIME, imageMimeFor };

function ImagePreview({ ctx }: { ctx: FilePreviewContext }) {
  const { t } = useLingui();
  const services = shellServices();
  const [url, setUrl] = useState<string | null>(null);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    let objectUrl: string | null = null;
    ctx
      .readBytes()
      .then((data) => {
        if (!live) return;
        setBytes(data);
        objectUrl = URL.createObjectURL(
          new Blob([data as BlobPart], { type: imageMimeFor(ctx.resolvedPath) }),
        );
        setUrl(objectUrl);
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [ctx]);

  if (error) {
    return <div className="p-4 text-[11px] text-[var(--red)]">{error}</div>;
  }
  if (!url) {
    return <div className="p-4 text-[11px] text-[var(--text-secondary)]">Loading…</div>;
  }
  return (
    <div className="relative flex h-full items-center justify-center p-4">
      <img
        src={url}
        alt={ctx.resolvedPath}
        className="max-h-full max-w-full object-contain"
      />
      {bytes && services?.copyImage && (
        <button
          type="button"
          onClick={() => {
            void decodeImageRgba(bytes, imageMimeFor(ctx.resolvedPath))
              .then((img) => services?.copyImage?.(img))
              .catch(() => {});
          }}
          data-tip={t`Copy image to clipboard`}
          className="absolute right-2 top-2 flex items-center gap-1 rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 text-[10px] text-[var(--text-primary)] transition hover:text-[var(--accent)]"
        >
          <ImageIcon className="h-3 w-3" />
          <Trans>Copy</Trans>
        </button>
      )}
    </div>
  );
}

export const imagePreviewPlugin: FilePreviewPlugin = {
  id: 'image',
  title: 'Image',
  version: '0.1.0',
  // .svg has its own plugin so it renders markup-scaled instead of rasterized.
  matches: extensionMatcher(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'ico']),
  render: (ctx) => <ImagePreview ctx={ctx} />,
};
