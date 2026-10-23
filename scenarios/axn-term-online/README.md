# axn-term-online scenario

Web frontend (`apps/web`) + .NET gateway/session host + per-user session
hosts behind Caddy on one port. Driven by `axn-dev`:

```bash
axn-dev start -s axn-term-online        # build + boot the stack
axn-dev flow -f flows/axn-term-login.xml  # flow tests against it
axn-dev stop -s axn-term-online -p 18092
```

## Troubleshooting — read this before debugging

### `stat /libraries: no such file or directory` (or `ramphastos` sibling) at build time

`AXN_LIBS_ROOT` must point at the directory **containing the sibling
checkouts** (`ramphastos`, `reflectiontools`, `totalserializer`) — it feeds
`additional_contexts: libraries` and the sibling bind-mount. The compose
default already resolves it relative to this file; only override if your
checkouts live elsewhere. Never point it at a container path like
`/libraries` — that only exists inside images, not on the host.

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
