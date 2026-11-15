#!/bin/bash
# Adds this deployment's own origins to the axn-term client's redirect URIs
# and web origins, so the realm file stays generic and a self-hosted stack
# works under whatever names it is reached by (LAN name/IP, tailnet name).
#
# AXN_ALLOWED_ORIGINS: comma-separated origins, e.g.
#   https://fedora.local:18092,https://192.168.1.41:18092
# Empty entries are ignored; existing entries are kept (idempotent).
set -euo pipefail

KC=/opt/keycloak/bin/kcadm.sh
REALM="${KEYCLOAK_REALM:-axn-term}"
CLIENT="${KEYCLOAK_CLIENT_ID:-axn-term}"

$KC config credentials --server "${KEYCLOAK_INTERNAL_URL:-http://keycloak:8082}" \
  --realm master --user "${KEYCLOAK_ADMIN:-admin}" --password "${KEYCLOAK_ADMIN_PASSWORD:-admin}" >/dev/null

id=$($KC get clients -r "$REALM" -q clientId="$CLIENT" --fields id --format csv --noquotes)
if [ -z "$id" ]; then
  echo "client $CLIENT not found in realm $REALM" >&2
  exit 1
fi

# json_array <comma list> → ["a","b"] with duplicates and blanks removed
# (pure bash: the keycloak image ships no awk/jq).
json_array() {
  local -A seen=()
  local out="" item
  IFS=',' read -ra items <<<"$1"
  for item in "${items[@]}"; do
    item="${item#"${item%%[![:space:]]*}"}"
    item="${item%"${item##*[![:space:]]}"}"
    [ -n "$item" ] && [ -z "${seen[$item]:-}" ] || continue
    seen[$item]=1
    out+="${out:+,}\"${item//\"/\\\"}\""
  done
  printf '[%s]' "$out"
}

redirects=$($KC get "clients/$id" -r "$REALM" --fields redirectUris --format csv --noquotes)
origins=$($KC get "clients/$id" -r "$REALM" --fields webOrigins --format csv --noquotes)

for origin in ${AXN_ALLOWED_ORIGINS//,/ }; do
  origin="${origin%/}"
  [ -n "$origin" ] || continue
  redirects="$redirects,$origin/*"
  origins="$origins,$origin"
done

# Never shrink the client to nothing — a failed read must not wipe it.
if [ "$(json_array "$redirects")" = "[]" ] || [ "$(json_array "$origins")" = "[]" ]; then
  echo "refusing to write empty redirect/origin lists" >&2
  exit 1
fi

$KC update "clients/$id" -r "$REALM" \
  -s "redirectUris=$(json_array "$redirects")" \
  -s "webOrigins=$(json_array "$origins")"
echo "allowed origins for $CLIENT: $(json_array "$origins")"

# Clients added after a realm was first imported (realm import skips an
# existing realm): create each keycloak-init/<clientId>.json that is missing.
for file in /init/*.json; do
  [ -f "$file" ] || continue
  cid=$(basename "$file" .json)
  if [ -z "$($KC get clients -r "$REALM" -q clientId="$cid" --fields id --format csv --noquotes)" ]; then
    $KC create clients -r "$REALM" -f "$file" >/dev/null
    echo "created client $cid"
  fi
done

# The mobile app keeps its sign-in as an offline token (survives days of
# idle). Realms imported before that need the role: default roles for new
# users, and every existing user of this dev realm.
$KC add-roles -r "$REALM" --rname "default-roles-${REALM}" --rolename offline_access >/dev/null 2>&1 || true
for uid in $($KC get users -r "$REALM" --fields id --format csv --noquotes); do
  $KC add-roles -r "$REALM" --uid "$uid" --rolename offline_access >/dev/null 2>&1 || true
done
