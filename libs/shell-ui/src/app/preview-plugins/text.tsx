import { useEffect, useState } from 'react';
import type { FilePreviewContext, FilePreviewPlugin } from './plugin';

type State = { kind: 'text'; text: string } | { kind: 'binary' } | { kind: 'error'; message: string };

function TextPreview({ ctx }: { ctx: FilePreviewContext }) {
  const [state, setState] = useState<State | null>(null);

  useEffect(() => {
    let live = true;
    ctx
      .readFile()
      .then((contents) => {
        if (!live) return;
        setState(
          contents.includes('\u0000') ? { kind: 'binary' } : { kind: 'text', text: contents },
        );
      })
      .catch((e) => {
        if (live) setState({ kind: 'error', message: String(e) });
      });
    return () => {
      live = false;
    };
  }, [ctx]);

  if (state === null) {
    return <div className="p-4 text-xs text-[var(--text-secondary)]">Loading…</div>;
  }
  if (state.kind === 'binary') {
    return <div className="p-4 text-xs text-[var(--text-secondary)]">Binary file</div>;
  }
  if (state.kind === 'error') {
    return <div className="p-4 text-xs text-[var(--red)]">{state.message}</div>;
  }
  return (
    <pre className="whitespace-pre-wrap break-all p-4 font-mono text-xs leading-snug text-[var(--text-primary)]">
      {state.text}
    </pre>
  );
}

/**
 * Fallback renderer — registered last so it only claims files no other
 * enabled plugin matches. Keeps `axn-preview <any file>` useful.
 */
export const textPreviewPlugin: FilePreviewPlugin = {
  id: 'text',
  title: 'Text',
  version: '0.1.0',
  matches: () => true,
  fallback: true,
  render: (ctx) => <TextPreview ctx={ctx} />,
};
