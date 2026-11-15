#!/usr/bin/env bash
# Publish this stack on your tailnet with a real certificate (*.ts.net,
# Let's Encrypt via Tailscale) so phones keep working away from home.
#
# Needs: `tailscale up` on this machine, and Serve + HTTPS certificates
# enabled for the tailnet (the first run prints an approval link if not).
#
# The whole stack is one origin (web /, Keycloak /auth, gateway /gw), so
# one serve entry on 443 is enough: Tailscale terminates TLS and forwards
# to Caddy's loopback-only plain port. Prints the .env lines to add.
#
# Usage: ./tailscale-serve.sh          set up
#        ./tailscale-serve.sh --off    remove the serve config
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] && set -a && . ./.env && set +a

PLAIN="${AXN_PLAIN_PORT:-18097}"

if [ "${1:-}" = "--off" ]; then
  tailscale serve --https=443 off || true
  exit 0
fi

name=$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
[ -n "$name" ] || { echo "tailscale is not up — run: sudo tailscale up" >&2; exit 1; }

# Without Serve enabled for the tailnet, this blocks on an approval link —
# bound it so the link is printed instead of hanging forever.
if ! timeout 20 tailscale serve --bg --https=443 "http://127.0.0.1:$PLAIN"; then
  echo "tailscale serve did not finish — approve Serve/HTTPS for this tailnet with the link above, then re-run." >&2
  exit 1
fi

cat <<EOF

Tailnet endpoint is up: https://$name

Add to scenarios/axn-term-online/.env, then restart the stack (axn-dev stop + start):

AXN_TAILNET_URL=https://$name

To let phones also SIGN IN away from home, make the tailnet the public
address (the login page lives there; reachable at home too while Tailscale
is on):

AXN_PUBLIC_URL=https://$name

Once signed in, the app refreshes its session over any address — also on
the home Wi-Fi with Tailscale off.
EOF
