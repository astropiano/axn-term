#!/usr/bin/env bash
# Stamp a SemVer version (e.g. 1.4.0 or 1.4.0-rc.1, no leading "v") into
# every file the desktop app reads its version from. Used by release builds;
# run it on a build copy, not on a checkout you commit from.
#
#   build/scripts/set-version.sh 1.4.0

set -euo pipefail

VERSION="${1:?usage: set-version.sh <semver>}"
# semver.org 2.0.0 (build metadata "+..." is left out: Windows installers
# and package managers do not keep it).
SEMVER='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)(\.(0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*))*))?$'
if [[ ! "$VERSION" =~ $SEMVER ]]; then
  echo "error: '$VERSION' is not a SemVer version like 1.4.0 or 1.4.0-rc.1" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

VERSION="$VERSION" ROOT="$ROOT" node <<'JS'
const fs = require('fs');
const path = require('path');
const { VERSION, ROOT } = process.env;

for (const file of ['package.json', 'apps/desktop/package.json', 'apps/desktop/src-tauri/tauri.conf.json']) {
  const p = path.join(ROOT, file);
  const json = JSON.parse(fs.readFileSync(p, 'utf8'));
  json.version = VERSION;
  fs.writeFileSync(p, JSON.stringify(json, null, 2) + '\n');
}

// Only the [package] version of the desktop crate, not dependency versions.
const cargoToml = path.join(ROOT, 'apps/desktop/src-tauri/Cargo.toml');
const toml = fs.readFileSync(cargoToml, 'utf8');
const stamped = toml.replace(/(\[package\][^\[]*?\nversion = )"[^"]*"/, `$1"${VERSION}"`);
if (stamped === toml && !toml.includes(`version = "${VERSION}"`)) {
  throw new Error(`could not find [package] version in ${cargoToml}`);
}
fs.writeFileSync(cargoToml, stamped);

// Keep Cargo.lock in step so the build does not rewrite it.
const cargoLock = path.join(ROOT, 'Cargo.lock');
const lock = fs.readFileSync(cargoLock, 'utf8');
fs.writeFileSync(cargoLock, lock.replace(/(\nname = "axn-term"\nversion = )"[^"]*"/, `$1"${VERSION}"`));
JS

echo "version set to $VERSION"
