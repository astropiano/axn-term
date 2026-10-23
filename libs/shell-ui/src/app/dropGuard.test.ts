// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { installDropGuard, isInternalDrag } from './dropGuard';

function dragEvent(type: string, types: string[]) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { types } });
  return event as unknown as DragEvent;
}

describe('isInternalDrag', () => {
  it('accepts only x-axn payloads', () => {
    expect(isInternalDrag(dragEvent('dragover', ['application/x-axn-session']))).toBe(true);
    expect(isInternalDrag(dragEvent('dragover', ['application/x-axn-session', 'application/x-axn-workspace']))).toBe(true);
  });

  it('rejects foreign payloads', () => {
    expect(isInternalDrag(dragEvent('dragover', ['Files']))).toBe(false);
    expect(isInternalDrag(dragEvent('dragover', ['text/plain']))).toBe(false);
    expect(isInternalDrag(dragEvent('dragover', ['text/uri-list']))).toBe(false);
    expect(isInternalDrag(dragEvent('dragover', ['application/x-axn-session', 'text/html']))).toBe(false);
    expect(isInternalDrag(dragEvent('dragover', []))).toBe(false);
  });
});

describe('installDropGuard', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => uninstall?.());

  for (const type of ['dragenter', 'dragover', 'drop'] as const) {
    it(`cancels a foreign ${type} in capture so no drop target sees it`, () => {
      uninstall = installDropGuard(window);
      const seen: string[] = [];
      document.addEventListener(type, () => seen.push('document'), false);
      const ev = dragEvent(type, ['Files']);
      document.body.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
      expect(seen).toEqual([]);
    });

    it(`lets an internal ${type} through untouched`, () => {
      uninstall = installDropGuard(window);
      const seen: string[] = [];
      document.addEventListener(type, () => seen.push('document'), false);
      const ev = dragEvent(type, ['application/x-axn-session']);
      document.body.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
      expect(seen).toEqual(['document']);
    });
  }

  it('lets a text drag that started inside the document through', () => {
    uninstall = installDropGuard(window);
    document.body.dispatchEvent(new MouseEvent('dragstart', { bubbles: true, cancelable: true }));
    const seen: string[] = [];
    document.addEventListener('dragover', () => seen.push('document'), false);
    const ev = dragEvent('dragover', ['text/plain']);
    document.body.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(seen).toEqual(['document']);
    document.body.dispatchEvent(new MouseEvent('dragend', { bubbles: true, cancelable: true }));
    const after = dragEvent('dragover', ['text/plain']);
    document.body.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(true);
  });
});
