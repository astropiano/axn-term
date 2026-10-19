type MermaidApi = typeof import('mermaid').default;

let mermaidPromise: Promise<MermaidApi> | null = null;
let initializedTheme: 'dark' | 'default' | null = null;
let counter = 0;

function loadMermaid(theme: 'dark' | 'default'): Promise<MermaidApi> {
  mermaidPromise ??= import('mermaid').then((m) => m.default);
  return mermaidPromise.then((mermaid) => {
    if (initializedTheme !== theme) {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme });
      initializedTheme = theme;
    }
    return mermaid;
  });
}

/**
 * Render mermaid `source` into `el`. On failure the element gets an error
 * note plus the original source so the diagram stays inspectable.
 */
export async function renderMermaidInto(
  el: HTMLElement,
  source: string,
  theme: 'dark' | 'default',
): Promise<void> {
  try {
    const mermaid = await loadMermaid(theme);
    const { svg } = await mermaid.render(`axn-mmd-${++counter}`, source.trim());
    el.innerHTML = svg;
  } catch (e) {
    el.innerHTML = '';
    const note = document.createElement('div');
    note.className = 'axn-mermaid-error';
    note.textContent = `mermaid: ${e instanceof Error ? e.message : String(e)}`;
    const pre = document.createElement('pre');
    pre.textContent = source;
    el.append(note, pre);
  }
}
