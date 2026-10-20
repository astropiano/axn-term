import { describe, it, expect } from 'vitest';
import {
  hookPermission,
  methodPermission,
  parsePermissions,
  type PluginManifest,
} from '@axn-term/plugin-sdk';
import { hasPermission } from './sandbox';

describe('sandbox permissions', () => {
  it('gates shell, terminal, file and session-driving calls', () => {
    expect(methodPermission('exec')).toBe('exec');
    expect(methodPermission('openSubShell')).toBe('exec');
    expect(methodPermission('runCommand')).toBe('exec');
    expect(methodPermission('writeToSession')).toBe('terminal-input');
    expect(methodPermission('getScreenLines')).toBe('terminal-output');
    expect(methodPermission('readFile')).toBe('fs-read');
    expect(methodPermission('writeFile')).toBe('fs-write');
    expect(methodPermission('mkdir')).toBe('fs-write');
    expect(methodPermission('openSession')).toBe('sessions');
  });

  it('leaves the plugin its own state and UI surfaces', () => {
    for (const m of ['updatePluginState', 'setBanner', 'setAttention', 'getSession', 'openTab']) {
      expect(methodPermission(m)).toBeUndefined();
    }
  });

  it('gates the output stream and line rewriting hooks', () => {
    expect(hookPermission('output')).toBe('terminal-output');
    expect(hookPermission('line')).toBe('terminal-input');
    expect(hookPermission('sessionOpen')).toBeUndefined();
    expect(hookPermission('command')).toBeUndefined();
  });

  it('keeps known permissions once and reports the rest', () => {
    expect(parsePermissions(['exec', 'fs-read', 'exec', 'root', 3])).toEqual({
      permissions: ['exec', 'fs-read'],
      unknown: ['root', '3'],
    });
    expect(parsePermissions(undefined)).toEqual({ permissions: [], unknown: [] });
    expect(parsePermissions('exec')).toEqual({ permissions: [], unknown: [] });
  });

  it('grants nothing to a manifest without permissions', () => {
    const bare: PluginManifest = { id: 'p', title: 'P' };
    expect(hasPermission(bare, 'exec')).toBe(false);
    expect(hasPermission({ ...bare, permissions: ['exec'] }, 'exec')).toBe(true);
    expect(hasPermission({ ...bare, permissions: ['exec'] }, 'fs-write')).toBe(false);
  });
});
