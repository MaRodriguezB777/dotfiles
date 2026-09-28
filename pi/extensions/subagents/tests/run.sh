#!/usr/bin/env bash
set -euo pipefail
# Tests run in a disposable copy; no dependencies are installed in the extension.
source_dir="$(cd "$(dirname "$0")/.." && pwd)"
pi_root="${PI_PACKAGE_ROOT:-$(npm root -g)/@earendil-works/pi-coding-agent}"
[[ -d "$pi_root/node_modules" ]] || { echo "Set PI_PACKAGE_ROOT to the installed pi package" >&2; exit 1; }
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp -a "$source_dir/." "$work/"
# pi's own dependencies plus pi itself (guard.ts imports it at runtime).
mkdir -p "$work/node_modules/@earendil-works"
for d in "$pi_root"/node_modules/*; do [[ "$(basename "$d")" == @earendil-works ]] || ln -s "$d" "$work/node_modules/"; done
for d in "$pi_root"/node_modules/@earendil-works/*; do ln -s "$d" "$work/node_modules/@earendil-works/"; done
ln -s "$pi_root" "$work/node_modules/@earendil-works/pi-coding-agent"
cd "$work"
shopt -s nullglob
files=(tests/*.test.ts messaging/*.test.ts)
node --experimental-strip-types --test "${files[@]}"
