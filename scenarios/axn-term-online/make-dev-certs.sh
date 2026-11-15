#!/usr/bin/env bash
# Dev certificates for LAN serving: a local CA + a server certificate for
# this machine's names, written to ./certs (gitignored; AXN_TLS points at
# axn-term-dev.pem / axn-term-dev-key.pem).
#
# Install certs/ca.pem once on every device that should trust the stack:
#   - Android: Settings → Security → Encryption & credentials → Install a
#     certificate → CA certificate (the axn-term app trusts user CAs). The
#     stack also serves it at https://<host>:<port>/axn-term-ca.crt.
#   - Fedora:  sudo trust anchor certs/ca.pem
#   - macOS:   Keychain Access → System → import, set "Always Trust"
#
# Usage: ./make-dev-certs.sh [extra-name-or-ip ...]
# Names default to AXN_LAN_NAME / AXN_LAN_IP from .env plus the localhost
# names. Re-running keeps an existing CA (devices stay trusted) and only
# reissues the server certificate.
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] && set -a && . ./.env && set +a

mkdir -p certs
names=(localhost axn-term.localhost axn-term-gateway.localhost axn-term-keycloak.localhost
  "${AXN_LAN_NAME:-axn-term.local}" "${AXN_LAN_IP:-127.0.0.1}" 127.0.0.1 "$@")

san=""
for n in "${names[@]}"; do
  [ -n "$n" ] || continue
  if [[ "$n" =~ ^[0-9.]+$ || "$n" == *:* ]]; then entry="IP:$n"; else entry="DNS:$n"; fi
  [[ ",$san," == *",$entry,"* ]] || san="${san:+$san,}$entry"
done

if [ ! -f certs/ca.pem ] || [ ! -f certs/ca-key.pem ]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
    -subj "/CN=axn-term dev CA ($(hostname))" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -keyout certs/ca-key.pem -out certs/ca.pem 2>/dev/null
  echo "created CA certs/ca.pem — install it on your devices"
fi

openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -subj "/CN=${AXN_LAN_NAME:-axn-term.local}" \
  -keyout certs/axn-term-dev-key.pem -out certs/axn-term-dev.csr 2>/dev/null
# 397 days: Chromium (and so Android WebView) rejects longer server certs.
openssl x509 -req -in certs/axn-term-dev.csr -CA certs/ca.pem -CAkey certs/ca-key.pem \
  -CAcreateserial -days 397 -out certs/axn-term-dev-leaf.pem \
  -extfile <(printf 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=%s\n' "$san") 2>/dev/null
cat certs/axn-term-dev-leaf.pem certs/ca.pem > certs/axn-term-dev.pem
rm -f certs/axn-term-dev.csr certs/axn-term-dev-leaf.pem
chmod 644 certs/ca.pem certs/axn-term-dev.pem
chmod 600 certs/ca-key.pem certs/axn-term-dev-key.pem
# Caddy runs as a different user inside the container and must read the key.
chmod 644 certs/axn-term-dev-key.pem
echo "server certificate for: $san"
