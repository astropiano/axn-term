import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ClipboardPaste,
  CornerDownLeft,
  Keyboard,
} from 'lucide-react';
import { useShellServices } from '../services';
import type { TerminalInput } from '../terminalRegistry';

type Modifier = 'ctrl' | 'alt';

interface KeyDef {
  id: string;
  label: ReactNode;
  tip: string;
  /** Literal bytes sent for the key (modifier latches don't apply). */
  seq?: string;
  /** Printable char — Ctrl maps through control codes, Alt prefixes ESC. */
  char?: string;
  /** CSI final byte (arrows, Home/End) — modifiers encode as `\x1b[1;<m><f>`. */
  csi?: string;
  modifier?: Modifier;
  action?: 'paste' | 'focus';
}

/** Control code for a Ctrl+char chord; null when the char has none. */
function ctrlCode(char: string): string | null {
  const code = char.toUpperCase().charCodeAt(0);
  // '@'..'Z' plus [\]^_
  if (code >= 0x40 && code <= 0x5f) return String.fromCharCode(code - 0x40);
  if (char === ' ') return '\x00';
  return null;
}

const KEYS: KeyDef[] = [
  { id: 'esc', label: 'esc', tip: 'Escape', seq: '\x1b' },
  { id: 'tab', label: 'tab', tip: 'Tab (also completes axn-* commands)', seq: '\t' },
  { id: 'ctrl', label: 'ctrl', tip: 'Ctrl — applies to the next key', modifier: 'ctrl' },
  { id: 'alt', label: 'alt', tip: 'Alt — applies to the next key', modifier: 'alt' },
  { id: 'left', label: <ArrowLeft className="h-3.5 w-3.5" />, tip: 'Left', csi: 'D' },
  { id: 'down', label: <ArrowDown className="h-3.5 w-3.5" />, tip: 'Down', csi: 'B' },
  { id: 'up', label: <ArrowUp className="h-3.5 w-3.5" />, tip: 'Up', csi: 'A' },
  { id: 'right', label: <ArrowRight className="h-3.5 w-3.5" />, tip: 'Right', csi: 'C' },
  { id: 'home', label: 'home', tip: 'Home', csi: 'H' },
  { id: 'end', label: 'end', tip: 'End', csi: 'F' },
  { id: 'del', label: 'del', tip: 'Delete', seq: '\x1b[3~' },
  { id: 'ctrl-c', label: '^C', tip: 'Ctrl+C (interrupt)', seq: '\x03' },
  { id: 'ctrl-d', label: '^D', tip: 'Ctrl+D (EOF)', seq: '\x04' },
  { id: 'ctrl-z', label: '^Z', tip: 'Ctrl+Z (suspend)', seq: '\x1a' },
  { id: 'ctrl-l', label: '^L', tip: 'Ctrl+L (clear screen)', seq: '\x0c' },
  { id: 'pipe', label: '|', tip: 'Pipe', char: '|' },
  { id: 'tilde', label: '~', tip: 'Tilde', char: '~' },
  { id: 'dash', label: '-', tip: 'Dash', char: '-' },
  { id: 'underscore', label: '_', tip: 'Underscore', char: '_' },
  { id: 'slash', label: '/', tip: 'Slash', char: '/' },
  { id: 'backslash', label: '\\', tip: 'Backslash', char: '\\' },
  {
    id: 'enter',
    label: <CornerDownLeft className="h-3.5 w-3.5" />,
    tip: 'Enter',
    seq: '\r',
  },
  {
    id: 'paste',
    label: <ClipboardPaste className="h-3.5 w-3.5" />,
    tip: 'Paste from clipboard',
    action: 'paste',
  },
  {
    id: 'keyboard',
    label: <Keyboard className="h-3.5 w-3.5" />,
    tip: 'Show the on-screen keyboard',
    action: 'focus',
  },
];

/**
 * Touch accessory bar rendered under the active terminal on coarse-pointer
 * devices: Esc/Tab, sticky Ctrl/Alt modifiers (apply to the next key — also
 * combinable with arrows and the symbol keys), common control chords, shell
 * punctuation, clipboard paste, and a keyboard-summon button. Keys inject
 * bytes through the terminal's registered input pipeline, so `axn-*`
 * interception and sub-shell re-run behave exactly like typed input.
 */
export function MobileKeyBar({ target }: { target: () => TerminalInput | undefined }) {
  const { services } = useShellServices();
  const [mods, setMods] = useState<ReadonlySet<Modifier>>(new Set());

  const press = (key: KeyDef) => {
    const modifier = key.modifier;
    if (modifier) {
      setMods((prev) => {
        const next = new Set(prev);
        if (next.has(modifier)) next.delete(modifier);
        else next.add(modifier);
        return next;
      });
      return;
    }
    const input = target();
    setMods(new Set());
    if (!input) return;
    if (key.action === 'focus') {
      input.focus();
      return;
    }
    if (key.action === 'paste') {
      void services.pasteText?.().then((text) => {
        if (text) input.send(text);
      });
      return;
    }

    const modBits = (mods.has('alt') ? 2 : 0) + (mods.has('ctrl') ? 4 : 0);
    let data: string;
    if (key.csi) {
      data = modBits ? `\x1b[1;${modBits + 1}${key.csi}` : `\x1b[${key.csi}`;
    } else if (key.char) {
      let ch = key.char;
      if (mods.has('ctrl')) ch = ctrlCode(ch) ?? ch;
      if (mods.has('alt')) ch = `\x1b${ch}`;
      data = ch;
    } else {
      data = key.seq ?? '';
      if (mods.has('alt')) data = `\x1b${data}`;
    }
    input.send(data);
  };

  return (
    <div
      className="flex h-9 shrink-0 touch-pan-x items-center gap-1 overflow-x-auto border-t border-[var(--border)] bg-[var(--bg-secondary)] px-1 pb-[env(safe-area-inset-bottom)]"
      role="toolbar"
      aria-label="Terminal keys"
    >
      {KEYS.map((key) => {
        const latched = key.modifier ? mods.has(key.modifier) : false;
        return (
          <button
            key={key.id}
            type="button"
            // Keep focus on the terminal textarea — tapping keys must not
            // blur it (or re-summon the soft keyboard on iOS).
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => press(key)}
            data-tip={key.tip}
            aria-label={key.tip}
            aria-pressed={latched}
            className={`flex h-7 min-w-8 shrink-0 select-none items-center justify-center rounded border px-1.5 font-mono text-[11px] transition ${
              latched
                ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--text-inverted)]'
                : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] active:bg-[var(--surface-hover)]'
            }`}
          >
            {key.label}
          </button>
        );
      })}
    </div>
  );
}
