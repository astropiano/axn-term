import type { ReactNode } from 'react';
import { registerFilePreviewPlugin, extensionMatcher } from './plugin';
import type { FilePreviewContext, FilePreviewPlugin } from './plugin';
import { imagePreviewPlugin } from './image';
import { svgPreviewPlugin } from './svg';
import { markdownPreviewPlugin } from './markdown';
import { asciidocPreviewPlugin } from './asciidoc';
import { mermaidPreviewPlugin } from './mermaid';
import { textPreviewPlugin } from './text';
import { axnLog } from '../log';

export * from './plugin';
export { HtmlPreview, sanitizePreviewHtml } from './html';
export { imageMimeFor } from './image';

/**
 * Order matters: the first enabled plugin whose `matches` accepts the path
 * wins, so specific renderers come first and the text fallback last.
 */
export const builtinFilePreviewPlugins: FilePreviewPlugin[] = [
  svgPreviewPlugin,
  imagePreviewPlugin,
  markdownPreviewPlugin,
  asciidocPreviewPlugin,
  mermaidPreviewPlugin,
  textPreviewPlugin,
];

builtinFilePreviewPlugins.forEach(registerFilePreviewPlugin);

/**
 * Preview capability an external `.mjs` plugin can attach to its default
 * export:
 *
 *   export default {
 *     id: 'my-plugin',
 *     preview: {
 *       extensions: ['foo'],          // or match: (path) => boolean
 *       title: 'Foo preview',
 *       render(ctx) { return '<b>html</b>'; },  // string = sanitized HTML
 *     },
 *   };
 *
 * The capability shares the plugin's plugins.yaml section — enabling the
 * plugin (`my-plugin.enabled: true`) enables its preview too.
 */
export interface ExternalPreviewSpec {
  id?: string;
  title?: string;
  /** File extensions (no dot) this preview handles — e.g. `['pdf']`. */
  extensions?: string[];
  /** Custom matcher; wins over `extensions` when both are given. */
  match?: (path: string) => boolean;
  /** Render the preview; a returned string is treated as sanitized HTML. */
  render?: (ctx: FilePreviewContext) => unknown;
}

export function registerExternalPreview(
  ownerId: string,
  ownerSettingsKey: string,
  spec: ExternalPreviewSpec,
): void {
  const matches =
    typeof spec.match === 'function'
      ? spec.match
      : Array.isArray(spec.extensions) && spec.extensions.length > 0
        ? extensionMatcher(spec.extensions)
        : null;
  if (!matches || typeof spec.render !== 'function') {
    axnLog(
      'warn',
      'plugins',
      `external plugin ${ownerId}: preview capability needs extensions/match and render`,
    );
    return;
  }
  const render = spec.render;
  registerFilePreviewPlugin({
    id: spec.id ?? `${ownerId}-preview`,
    title: spec.title ?? ownerId,
    settingsKey: ownerSettingsKey,
    defaultEnabled: false,
    matches,
    render: (ctx) => render(ctx) as ReactNode,
  });
}
