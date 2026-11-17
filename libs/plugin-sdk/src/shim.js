/**
 * axn-term sandboxed-plugin client shim — injected into plugin iframes by the
 * host before the plugin's own code runs. Defines `window.axn` and bridges
 * every capability over postMessage (`{ axn: 'plugin-v1' }` envelopes —
 * see contract.ts). Plain ES2019, no dependencies.
 */
(function () {
  'use strict';
  if (window.axn) return;

  var TAG = 'plugin-v1';
  var seq = 0;
  var pending = new Map(); // call id -> {resolve, reject}
  var requestSeq = 0;
  var listeners = new Map(); // event -> Set<fn>
  var subscribed = new Set(); // host hook names
  var lastInit = null;
  var lastSessions = null;
  var lastAppState;
  var hasAppState = false;

  function post(msg) {
    msg.axn = TAG;
    parent.postMessage(msg, '*');
  }

  function call(method, args, sessionId) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending.set(id, { resolve: resolve, reject: reject });
      post({ type: 'call', id: id, method: method, sessionId: sessionId, args: args || [] });
    });
  }

  function emit(event, data) {
    var set = listeners.get(event);
    if (!set) return [];
    var results = [];
    set.forEach(function (fn) {
      try {
        results.push(fn(data));
      } catch (e) {
        console.error('[axn] ' + event + ' handler failed:', e);
      }
    });
    return results;
  }

  function syncSubscription() {
    post({ type: 'subscribe', hooks: Array.from(subscribed) });
  }

  // Client event name -> host hook name, when they differ.
  var HOOK_OF = {
    sessionOpen: 'sessionOpen',
    output: 'output',
    close: 'close',
    line: 'line',
    command: 'command',
    completeArg: 'completeArg',
    processEnd: 'processEnd',
    subShellExit: 'subShellExit',
    bannerAction: 'bannerAction',
    surfaceAction: 'surfaceAction',
  };

  function on(event, fn) {
    if (typeof fn !== 'function') throw new Error('axn.on needs a function');
    var set = listeners.get(event);
    if (!set) listeners.set(event, (set = new Set()));
    set.add(fn);
    var hook = HOOK_OF[event];
    if (hook && !subscribed.has(hook)) {
      subscribed.add(hook);
      syncSubscription();
    }
    // Replayable events fire immediately when data already arrived.
    var replay =
      event === 'init' ? (lastInit ? [true, lastInit] : [false]) :
      event === 'sessions' ? (lastSessions ? [true, lastSessions] : [false]) :
      event === 'appState' ? [hasAppState, lastAppState] :
      [false];
    if (replay[0]) {
      try {
        fn(replay[1]);
      } catch (e) {
        console.error('[axn] ' + event + ' handler failed:', e);
      }
    }
    return function () {
      set.delete(fn);
    };
  }

  function sessionHandle(sessionId) {
    return {
      write: function (data) { return call('writeToSession', [data], sessionId); },
      exec: function (command, cwd) { return call('exec', [command, cwd], sessionId); },
      getCwd: function () { return call('getCwd', [], sessionId); },
      waitForOutput: function (timeoutMs) { return call('waitForSessionOutput', [timeoutMs], sessionId); },
      getScreenLines: function () { return call('getScreenLines', [], sessionId); },
      readFile: function (path, cwd) { return call('readFile', [path, cwd], sessionId); },
      writeFile: function (path, contents, cwd) { return call('writeFile', [path, contents, cwd], sessionId); },
      statPath: function (path, cwd) { return call('statPath', [path, cwd], sessionId); },
      mkdir: function (path, cwd) { return call('mkdir', [path, cwd], sessionId); },
      openBrowser: function (path) { return call('openBrowser', [path], sessionId); },
      openTab: function (tab) { return call('openTab', [tab], sessionId); },
      openSubShell: function (command, cwd, label, agent) {
        return call('openSubShell', [command, cwd, label, agent], sessionId);
      },
      openSession: function (cwd, name, workspaceId) { return call('openSession', [cwd, name, workspaceId], sessionId); },
      getWorkspace: function () { return call('getWorkspace', [], sessionId); },
      getWorkspaces: function () { return call('getWorkspaces', [], sessionId); },
      runCommand: function (line) { return call('runCommand', [line], sessionId); },
      activateTab: function (tabId) { return call('activateTab', [tabId], sessionId); },
      updateState: function (patch) { return call('updatePluginState', [patch], sessionId); },
      setAttention: function (a) { return call('setAttention', [a], sessionId); },
      setBanner: function (b) { return call('setBanner', [b], sessionId); },
      setRestoring: function (l) { return call('setRestoring', [l], sessionId); },
      info: function () { return call('getSession', [], sessionId); },
    };
  }

  function applyTheme(theme) {
    var root = document.documentElement;
    for (var k in theme) root.style.setProperty(k, theme[k]);
    root.style.colorScheme = theme['--color-scheme'] || '';
  }

  var axn = {
    apiVersion: 0,
    role: 'logic',
    theme: {},
    settings: undefined,
    appState: undefined,
    sessions: [],
    on: on,
    call: call,
    session: sessionHandle,
    getSessions: function () { return call('getSessions', []); },
    updateAppState: function (patch) { return call('updateAppState', [patch]); },
    selectSession: function (id) { return call('selectSession', [id]); },
    closeView: function () { return call('closeView', []); },
    openView: function (view) { return call('openView', [view]); },
    selectView: function (key) { return call('selectView', [key]); },
    removeView: function (key) { return call('removeView', [key]); },
    getActiveView: function () { return call('getActiveView', []); },
    setSurface: function (surface, sessionId, html) {
      post({ type: 'surface', surface: surface, sessionId: sessionId, html: html });
    },
    sendToPeer: function (payload) { post({ type: 'peer', payload: payload }); },
  };

  window.addEventListener('message', function (e) {
    var m = e.data;
    if (!m || m.axn !== TAG) return;
    switch (m.type) {
      case 'init':
        lastInit = m;
        axn.apiVersion = m.apiVersion;
        axn.role = m.role;
        axn.theme = m.theme || {};
        axn.settings = m.settings;
        axn.appState = m.appState;
        applyTheme(axn.theme);
        emit('init', m);
        break;
      case 'theme':
        axn.theme = m.theme || {};
        applyTheme(axn.theme);
        emit('theme', axn.theme);
        break;
      case 'result': {
        var p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.ok) p.resolve(m.value);
        else p.reject(new Error(m.error || 'call failed'));
        break;
      }
      case 'sessions':
        lastSessions = m.sessions || [];
        axn.sessions = lastSessions;
        emit('sessions', lastSessions);
        break;
      case 'appState':
        hasAppState = true;
        lastAppState = m.value;
        axn.appState = m.value;
        emit('appState', m.value);
        break;
      case 'peer':
        emit('peer', m.payload);
        break;
      case 'viewChanged':
        emit('viewChanged', m.value);
        break;
      case 'event': {
        var data = {
          sessionId: m.sessionId,
          session: m.session,
          name: m.data && m.data.name,
          arg: m.data && m.data.arg,
          line: m.data && m.data.line,
          text: m.data && m.data.text,
          tabId: m.data && m.data.tabId,
          exitCode: m.data && m.data.exitCode,
          actionId: m.data && m.data.actionId,
          action: m.data && m.data.action,
          surface: m.data && m.data.surface,
          argPrefix: m.data && m.data.argPrefix,
          raw: m.data,
        };
        var respond = function (result) {
          if (m.requestId != null) {
            post({ type: 'respond', requestId: m.requestId, result: result });
          }
        };
        var outs = emit(m.hook, data);
        if (m.requestId != null) {
          var first = outs[outs.length - 1];
          Promise.resolve(first).then(respond, function () { respond(undefined); });
        }
        break;
      }
    }
  });

  window.axn = axn;
  post({ type: 'ready' });
})();
