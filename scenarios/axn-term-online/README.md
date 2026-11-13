# axn-term-online scenario

Web frontend (`apps/web`) + .NET gateway/session host + per-user session
hosts behind Caddy on one port. Driven by `axn-dev`:

```bash
axn-dev start -s axn-term-online        # build + boot the stack
axn-dev flow -f flows/axn-term-login.xml  # flow tests against it
axn-dev stop -s axn-term-online -p 18092
```

## Troubleshooting — read this before debugging

### `ramphastos` sibling not found at build time

`AXN_LIBS_ROOT` must point at the directory **containing axn-term and its
sibling `ramphastos` checkout** (by default the parent of the axn-term repo)
— it feeds `additional_contexts: libraries` and the sibling bind-mount. The
compose default already resolves it relative to this file; only override if
ramphastos lives elsewhere. Never point it at a container path like
`/ramphastos` — that only exists inside images, not on the host.

### `additional privileges requested: pass --allow=fs.read=/`

The siblings are read through `additional_contexts`, which escapes the
normal build context — buildx bake asks for a filesystem entitlement.
`BUILDX_BAKE_ENTITLEMENTS_FS: "0"` in this scenario's `env:` grants it;
don't remove that line.

### `Service '<name>' not found in scenario`

Almost always means the service's URL in `frontend-services:`/
`backend-services:` resolved to something invalid and was silently dropped:

- **Only single-level `${VAR:-default}` expressions work.** axn-dev's
  `substituteEnvVars` cannot parse nested `${VAR:+${VAR}}` or
  `${VAR:-x.${VAR:-y}}` — the regex stops at the first `}`, produces a
  broken URL, `new URL()` throws, and the endpoint disappears. Keep every
  `${...}` flat; compose itself tolerates nesting but the axn-dev resolver
  does not.
- **Empty-set vars are not unset.** `AXN_LAN_IP: ""` counts as *set* for
  axn-dev's `??` check (unlike compose's `:-`), so it substitutes an empty
  host → invalid URL → endpoint dropped. To get `:-` defaults, leave the
  variable unset entirely — document the override in a comment instead.

### `Timed out waiting for <url> to respond with 200`

Two separate causes seen:

1. **Caddy container not running** — `docker ps` missing
   `axn-term-online-caddy`; check `docker logs axn-term-online-caddy`.
   Both env-crash bugs seen here were *empty injected values*: compose
   injected `AXN_LAN_IP=` into the caddy container, so
   `default_sni {$AXN_LAN_IP:-localhost}` parsed as no argument. The
   container env default must be a real value (`${AXN_LAN_IP:-localhost}`).
   Note `tls off` is **not** valid Caddy — `tls` accepts only `internal`,
   `force_automate`, or an email; there is no plain-HTTP mode in this
   Caddyfile despite the comment suggesting otherwise.

2. **Self-signed cert** — the readiness probe is a plain Node `fetch`,
   which rejects the internal CA and retries into the timeout. Point Node
   at the caddy CA:

   ```bash
   docker exec axn-term-online-caddy cat \
     /data/caddy/pki/authorities/local/root.crt > /tmp/axn-caddy-ca.crt
   NODE_EXTRA_CA_CERTS=/tmp/axn-caddy-ca.crt axn-dev flow -f flows/axn-term-login.xml
   ```

### `*.localhost` resolution

`axn-term.localhost`, `axn-term-keycloak.localhost` etc. resolve to
127.0.0.1 on this macOS setup — no /etc/hosts needed.

### Which scenario am I actually running?

`axn-dev` resolves **global scenarios first**, then the current repo's
`scenarios/`. A scenario of the same name in a configured repo shadows the
project one — check the `Path:` line axn-dev prints if URLs/ports look
foreign.

### `dotnet build axn-term.slnx` fails only in SessionHost.Tests

`tests/AxnTerm.SessionHost.Tests` has pre-existing stale references to the
old `SessionHostService` API (`PtyExitedStatus`, `MaxReadBytes`, old ctor).
The app projects compile fine — the test project needs a rewrite, it is
not a port/sync regression.

## Login & terminal sessions

### `Invalid parameter: redirect_uri` at keycloak

The realm's `redirectUris`/`webOrigins` must contain the URL with the
**same scheme** the browser uses — under `AXN_TLS: internal` that is
`https://`. The file that actually gets imported is
`keycloak/axn-term-realm.json` (mounted via `--import-realm`); a copy at
the scenario root is not mounted and edits there do nothing. Keycloak
re-imports on container recreate (dev H2 dies with the container).

### "Failed to start shell session" / `connection lost` after login

Most likely cause on this stack: **the browser never accepted the cert
for `axn-term-gateway.localhost`.** The page loads over
`axn-term.localhost` (cert accepted once), but the terminal WebSocket
goes to `wss://axn-term-gateway.localhost:PORT` — a *different* hostname.
Browsers fail self-signed WebSocket connects **silently** (no warning
page), so nothing ever reaches the gateway.

Fix once: open `https://axn-term-gateway.localhost:18092/` in a tab and
accept, or better — trust the caddy internal CA in the OS keychain:

```bash
docker exec axn-term-online-caddy cat \
  /data/caddy/pki/authorities/local/root.crt
```

Other causes seen:

- **Stale per-user session-host container.** The gateway spawns
  `axn-term-host-<user>` via docker.sock; a leftover container with the
  same name (e.g. from an older run) makes the spawn fail silently.
  `docker rm -f axn-term-host-<user>` and retry.
- **Mixed http/https env.** `KC_HOSTNAME`, `VITE_KEYCLOAK_URL` and
  `VITE_SHELL_WS_URL` must all use `https`/`wss` under TLS internal —
  `AXN_SCHEME`/`AXN_WS_SCHEME` in axn-dev.yaml drive them. Watch for
  duplicate env keys in compose.yaml: later entries win, so a hardcoded
  `VITE_KEYCLOAK_URL=http://...` below the templated line overrides it.

### Ramphastos transport vs per-PTY `/ws`

`VITE_RAMPHASTOS_URL` switches terminals to `RemoteBackend` — sessions
ride the ramphastos hub (`/ramphastos`, proxied by the gateway) instead
of per-PTY `/ws` sockets. Required for attaching multiple browsers to
the same session. Leave it unset for the classic WsBackend mode.

### Flow readiness + playwright on self-signed certs

- Node probes: `NODE_EXTRA_CA_CERTS=<caddy root.crt>`.
- Playwright: the orchestrator tolerates the CA
  (`ignoreHTTPSErrors`), and `findChromium` locates Linux/macOS cache
  builds incl. arm64 / "Chrome for Testing" layouts. Override with
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.
