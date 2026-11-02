// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { installDropGuard } from './dropGuard';
import { createFileDrop, fileUriPath, MAX_DROP_BYTES, parseUriList, pasteDroppedFiles, type FileDropDeps } from './fileDrop';

function fakeTerm() {
  return { paste: vi.fn(), focus: vi.fn() } as unknown as Terminal & {
    paste: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
  };
}

/** A drag event as the webview delivers it: `files`, plus string data by type. */
function dragEvent(type: string, { files = [] as File[], data = {} as Record<string, string> } = {}): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  const dataTransfer = {
    types: [...(files.length ? ['Files'] : []), ...Object.keys(data)],
    files,
    dropEffect: 'none',
    getData: (t: string) => data[t] ?? '',
  };
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  return event;
}

const png = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'shot.png', { type: 'image/png' });
const flush = () => new Promise((r) => setTimeout(r, 0));

let cleanup: (() => void) | undefined;

/** The file drop as ShellApp installs it: behind the drop guard. */
function install(deps: FileDropDeps): () => void {
  const fileDrop = createFileDrop(deps);
  const uninstall = installDropGuard(window, fileDrop);
  return () => {
    uninstall();
    fileDrop.dispose();
  };
}
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  document.body.innerHTML = '';
});

function terminalSetup(deps: { localPaths?: boolean; saveFile?: ReturnType<typeof vi.fn> } = {}) {
  const term = fakeTerm();
  const termEl = document.createElement('div');
  const panel = document.createElement('div');
  document.body.append(termEl, panel);
  cleanup = install({ terminalAt: (t) => (t === termEl ? term : undefined), ...deps });
  return { term, termEl, panel };
}

describe('file drop behind the drop guard', () => {
  it('pastes a file manager drop as the files’ own paths (WebKitGTK: text/uri-list)', async () => {
    const saveFile = vi.fn();
    const { term, termEl } = terminalSetup({ localPaths: true, saveFile });
    const data = {
      'text/uri-list': 'file:///home/me/Pictures/shot%201.png\r\nfile:///home/me/b.jpg\r\n',
      'text/html': '<a href="file:///home/me/b.jpg">b</a>',
    };

    const over = dragEvent('dragover', { data });
    termEl.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect(over.dataTransfer!.dropEffect).toBe('copy');

    const drop = dragEvent('drop', { data });
    termEl.dispatchEvent(drop);
    // Taken synchronously, so the webview never opens the file itself.
    expect(drop.defaultPrevented).toBe(true);
    await flush();
    expect(term.paste).toHaveBeenCalledWith(`'/home/me/Pictures/shot 1.png' /home/me/b.jpg `);
    expect(term.focus).toHaveBeenCalled();
    expect(saveFile).not.toHaveBeenCalled();
  });

  it('pastes native drops into the terminal under the last dragover (Linux desktop)', () => {
    let nativeDrop: ((paths: string[]) => void) | undefined;
    const off = vi.fn();
    const onNativeDrop = (cb: (paths: string[]) => void) => {
      nativeDrop = cb;
      return off;
    };
    const term = fakeTerm();
    const termEl = document.createElement('div');
    const panel = document.createElement('div');
    document.body.append(termEl, panel);
    cleanup = install({ terminalAt: (t) => (t === termEl ? term : undefined), onNativeDrop });

    // WebKitGTK: the page sees an empty uri-list, then GTK's dragleave, then the native drop.
    termEl.dispatchEvent(dragEvent('dragover', { data: { 'text/uri-list': '' } }));
    termEl.dispatchEvent(dragEvent('dragleave', { data: { 'text/uri-list': '' } }));
    nativeDrop!(['/home/me/Pictures/shot 1.png']);
    expect(term.paste).toHaveBeenCalledWith(`'/home/me/Pictures/shot 1.png' `);

    // Dropped beside the terminal: nothing pasted.
    panel.dispatchEvent(dragEvent('dragover', { data: { 'text/uri-list': '' } }));
    nativeDrop!(['/home/me/b.png']);
    expect(term.paste).toHaveBeenCalledTimes(1);

    cleanup();
    cleanup = undefined;
    expect(off).toHaveBeenCalled();
  });

  it('saves dropped file contents and pastes the copy’s path (browsers: Files only)', async () => {
    const saveFile = vi.fn(async (_t: Terminal, name: string, bytes: Uint8Array) => {
      expect(Array.from(bytes)).toEqual([0x89, 0x50, 0x4e, 0x47]);
      return `/run/user/1000/axn-term-drops/1/${name}`;
    });
    const { term, termEl } = terminalSetup({ saveFile });
    const drop = dragEvent('drop', { files: [png()] });
    termEl.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    await flush();
    expect(term.paste).toHaveBeenCalledWith('/run/user/1000/axn-term-drops/1/shot.png ');
  });

  it('never pastes file:// paths into sessions on another machine', async () => {
    const { term, termEl } = terminalSetup({ localPaths: false });
    termEl.dispatchEvent(dragEvent('drop', { data: { 'text/uri-list': 'file:///home/me/a.png' } }));
    await flush();
    expect(term.paste).not.toHaveBeenCalled();
  });

  it('pastes links dragged from a browser as text', async () => {
    const { term, termEl } = terminalSetup({ localPaths: true });
    termEl.dispatchEvent(dragEvent('drop', { data: { 'text/uri-list': 'https://example.com/a?b=1' } }));
    await flush();
    expect(term.paste).toHaveBeenCalledWith(`'https://example.com/a?b=1' `);
  });

  it('swallows drops outside terminals without pasting or saving', async () => {
    const saveFile = vi.fn();
    const { term, panel } = terminalSetup({ localPaths: true, saveFile });

    const over = dragEvent('dragover', { files: [png()] });
    panel.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect(over.dataTransfer!.dropEffect).toBe('none');

    const drop = dragEvent('drop', { files: [png()], data: { 'text/uri-list': 'file:///a.png' } });
    panel.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    await flush();
    expect(saveFile).not.toHaveBeenCalled();
    expect(term.paste).not.toHaveBeenCalled();
  });

  it('leaves the app’s own drags alone and keeps foreign drops from every other drop target', async () => {
    const saveFile = vi.fn();
    const { term, termEl } = terminalSetup({ localPaths: true, saveFile });

    const internal = dragEvent('drop', { data: { 'application/x-axn-session': 's1' } });
    termEl.dispatchEvent(internal);
    expect(internal.defaultPrevented).toBe(false);

    // A view's own drop listener never sees a foreign drop; the terminal still gets it.
    const viewDrop = vi.fn();
    document.addEventListener('drop', viewDrop);
    termEl.dispatchEvent(dragEvent('drop', { data: { 'text/uri-list': 'file:///home/me/a.png' } }));
    document.removeEventListener('drop', viewDrop);
    expect(viewDrop).not.toHaveBeenCalled();
    await flush();
    expect(term.paste).toHaveBeenCalledWith('/home/me/a.png ');
    expect(saveFile).not.toHaveBeenCalled();
  });

  it('shows no copy cursor for file contents the backend cannot store (web)', () => {
    const { termEl } = terminalSetup({});
    const over = dragEvent('dragover', { files: [png()] });
    termEl.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect(over.dataTransfer!.dropEffect).toBe('none');
  });

  it('ignores foreign text drags: no copy cursor, nothing pasted', async () => {
    const { term, termEl } = terminalSetup({ localPaths: true });
    const over = dragEvent('dragover', { data: { 'text/plain': 'rm -rf ~' } });
    termEl.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect(over.dataTransfer!.dropEffect).toBe('none');
    termEl.dispatchEvent(dragEvent('drop', { data: { 'text/plain': 'rm -rf ~' } }));
    await flush();
    expect(term.paste).not.toHaveBeenCalled();
  });
});

describe('pasteDroppedFiles', () => {
  it('quotes paths with spaces and skips files that cannot be saved', async () => {
    const term = fakeTerm();
    const big = { name: 'huge.mov', size: MAX_DROP_BYTES + 1, arrayBuffer: vi.fn() } as unknown as File;
    const dir = { name: 'folder', size: 0, arrayBuffer: () => Promise.reject(new Error('dir')) } as unknown as File;
    const spaced = new File([new Uint8Array([1])], 'my shot.png');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const text = await pasteDroppedFiles(term, [big, dir, spaced, png()], async (_t, name) => `/tmp/d/${name}`);

    expect(text).toBe(`'/tmp/d/my shot.png' /tmp/d/shot.png `);
    expect(term.paste).toHaveBeenCalledTimes(1);
    expect(big.arrayBuffer).not.toHaveBeenCalled();
    errors.mockRestore();
    warns.mockRestore();
  });

  it('pastes nothing when no file could be saved', async () => {
    const term = fakeTerm();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await pasteDroppedFiles(term, [png()], () => Promise.reject(new Error('disk full')))).toBe('');
    expect(term.paste).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe('uri helpers', () => {
  it('parses uri-lists and maps file URIs to local paths', () => {
    expect(parseUriList('# comment\r\nfile:///a\r\n\r\nhttps://x\n')).toEqual(['file:///a', 'https://x']);
    expect(fileUriPath('file:///home/me/a%20b.png')).toBe('/home/me/a b.png');
    expect(fileUriPath('file://localhost/tmp/x')).toBe('/tmp/x');
    expect(fileUriPath('file:///C:/Users/me/x.png')).toBe('C:/Users/me/x.png');
    expect(fileUriPath('file://otherhost/share/x')).toBeUndefined();
    expect(fileUriPath('https://example.com/x.png')).toBeUndefined();
    expect(fileUriPath('not a uri')).toBeUndefined();
  });
});
