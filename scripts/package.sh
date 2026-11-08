#!/usr/bin/env bash
# Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
# licensed under the terms of the MIT license which can be found in the
# root directory of this project.

# Builds qs400-code-host for the current platform, copies it to bin/, and
# packages a platform-specific VSIX.
#
#   scripts/package.sh              host + VSIX
#   scripts/package.sh --host-only  host into bin/ only (for npm test)

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

host_only=false
for arg in "$@"; do
  case "$arg" in
    --host-only) host_only=true ;;
    *) echo "package.sh: unknown argument: $arg" >&2; exit 64 ;;
  esac
done

if [ "$(uname -m)" != "x86_64" ]; then
  echo "package.sh: only x86_64 hosts are supported (got $(uname -m))" >&2
  exit 1
fi
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
    triple=x86_64-pc-windows-msvc; target=win32-x64; exe=qs400-code-host.exe ;;
  Linux)
    triple=x86_64-unknown-linux-musl; target=linux-x64; exe=qs400-code-host ;;
  *)
    echo "package.sh: unsupported platform $(uname -s)" >&2; exit 1 ;;
esac

echo "==> building qs400-code-host for $triple"
(cd host && cargo build --release --locked --target "$triple")

echo "==> bin/$exe"
mkdir -p bin
find bin -mindepth 1 ! -name .gitkeep -exec rm -rf {} +
cp "host/target/$triple/release/$exe" "bin/$exe"
chmod +x "bin/$exe"
"bin/$exe" --version

if [ "$host_only" = true ]; then
  exit 0
fi

echo "==> checking VSIX contents"
files="$(npx --no-install vsce ls)"
echo "$files"
if echo "$files" | grep -Eq '^(host|test|src|node_modules)/'; then
  echo "package.sh: VSIX would contain sources or tests" >&2; exit 1
fi
if [ "$(echo "$files" | grep -c '^bin/')" != "1" ] || ! echo "$files" | grep -qx "bin/$exe"; then
  echo "package.sh: VSIX must carry exactly bin/$exe" >&2; exit 1
fi

out="code-for-qs400-$target.vsix"
echo "==> $out"
npx --no-install vsce package --target "$target" --out "$out"
