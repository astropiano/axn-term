// Modules pulled in transitively through @axn-term/shell-ui (xterm addons)
// probe the UMD browser global; node-env tests have no `self`.
if (typeof globalThis.self === 'undefined') {
  (globalThis as { self?: typeof globalThis }).self = globalThis;
}
