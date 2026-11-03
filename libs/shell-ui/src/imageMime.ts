import type { ClipboardImage } from '@axn-term/session-backend';

/**
 * Decode image bytes to RGBA pixels for `services.copyImage` — canvas
 * rasterization, so every format the webview draws (incl. svg) copies.
 */
export async function decodeImageRgba(
  bytes: Uint8Array,
  mime: string,
): Promise<ClipboardImage> {
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d canvas context');
    ctx.drawImage(bitmap, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return { rgba: data, width, height };
  } finally {
    bitmap.close();
  }
}

export const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
};

export function imageMimeFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_MIME[ext] ?? 'application/octet-stream';
}
