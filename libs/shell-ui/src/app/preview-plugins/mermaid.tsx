import { useEffect, useRef } from 'react';
import { extensionMatcher } from './plugin';
import type { FilePreviewContext, FilePreviewPlugin } from './plugin';
import { renderMermaidInto } from './mermaidRender';
import { useSettings } from '../../SettingsProvider';

function MermaidPreview({ ctx }: { ctx: FilePreviewContext }) {
  const ref = useRef<HTMLDivElement>(null);
  const { activeTheme } = useSettings();
  const theme = activeTheme.mode === 'light' ? 'default' : 'dark';

  useEffect(() => {
    let live = true;
    ctx
      .readFile()
      .then((source) => {
        if (live && ref.current) {
          void renderMermaidInto(ref.current, source, theme);
        }
      })
      .catch((e) => {
        if (live && ref.current) {
          ref.current.textContent = String(e);
        }
      });
    return () => {
      live = false;
    };
  }, [ctx, theme]);

  return <div ref={ref} className="axn-mermaid-standalone p-4" />;
}

export const mermaidPreviewPlugin: FilePreviewPlugin = {
  id: 'mermaid',
  title: 'Mermaid',
  version: '0.1.0',
  matches: extensionMatcher(['mmd', 'mermaid']),
  render: (ctx) => <MermaidPreview ctx={ctx} />,
};
