// Sandboxed plugin logic frame — runs inside a hidden sandboxed iframe.
// `window.axn` is injected by the host before this file executes; every
// capability (PTY writes, exec, state, banners, surfaces) crosses the
// postMessage boundary. There is no access to the app's DOM or Tauri APIs.

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}

function pushNote(sessionId, note) {
  const html = note
    ? `📝 ${esc(note)} — <a href="#" data-axn-action="clear">clear</a>`
    : null;
  axn.setSurface('render', sessionId, html);
  if (axn.settings?.compactRow) {
    axn.setSurface('row', sessionId, note ? `📝 ${esc(note)}` : null);
  }
}

// Replay persisted notes when sessions (re)appear.
axn.on('sessionOpen', ({ sessionId, session }) => {
  const note = session?.state?.note;
  if (typeof note === 'string') pushNote(sessionId, note);
});

// `axn-note <text>` — an owned command declared in plugin.json.
axn.on('command', async ({ sessionId, name, arg }) => {
  if (name !== 'axn-note') return undefined;
  const note = (arg ?? '').trim() || null;
  await axn.session(sessionId).updateState({ note });
  pushNote(sessionId, note);
  return false; // swallow — nothing reaches the shell
});

// "clear" link inside the pushed surface.
axn.on('surfaceAction', async ({ sessionId, action }) => {
  if (action !== 'clear') return;
  await axn.session(sessionId).updateState({ note: null });
  pushNote(sessionId, null);
});
