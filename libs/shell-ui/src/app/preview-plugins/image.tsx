import { useEffect, useState } from 'react';
import { extensionMatcher } from './plugin';
import type { FilePreviewContext, FilePreviewPlugin } from './plugin';
import { IMAGE_MIME, imageMimeFor } from '../../imageMime';

export { IMAGE_MIME, imageMimeFor };

function ImagePreview({ ctx }: { ctx: FilePreviewContext }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    let objectUrl: string | null = null;
    ctx
      .readBytes()
      .then((bytes) => {
        if (!live) return;
        objectUrl = URL.createObjectURL(
          new Blob([bytes], { type: imageMimeFor(ctx.resolvedPath) }),
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
    <div className="flex h-full items-center justify-center p-4">
      <img
        src={url}
        alt={ctx.resolvedPath}
        className="max-h-full max-w-full object-contain"
      />
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
