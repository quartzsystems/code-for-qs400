#!/usr/bin/env bash
# Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
# licensed under the terms of the MIT license which can be found in the
# root directory of this project.

# Fails if a name this project must not use appears in any file, file path
# or commit message. Case-insensitive. If it fires, rename; never add an
# exception.
#
# Each pattern has one letter in brackets so this file does not match
# itself; the regex is unchanged.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

pattern='i[b]m|i[s]eries|a[s]400|a[s]/400|s[y]stem i|o[s]/400|i[5]/os|r[d]i|c[o]de for i|p[a]se|q[o]pensys|p[o]wer[0-9]'

# Subresource-integrity hashes (sha512-<base64>, as in package-lock.json)
# are random bytes, not words; they are blanked before matching.
sri='sha(1|256|384|512)-[A-Za-z0-9+/]+=*'

# Every file in the tree except .git/, node_modules/ and target/. In a git
# checkout that is what git sees (tracked plus untracked, minus ignored);
# elsewhere a plain walk.
list_files() {
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git ls-files -z --cached --others --exclude-standard
  else
    find . \( -name .git -o -name node_modules -o -name target \) -prune -o -type f -print0
  fi
}

hits=0
report() {
  echo "$1"
  hits=$((hits + 1))
}

while IFS= read -r -d '' f; do
  f="${f#./}"
  case "$f" in .git/* | */.git/* | node_modules/* | */node_modules/* | target/* | */target/*) continue ;; esac
  [ -f "$f" ] || continue
  if echo "$f" | grep -qiE "$pattern"; then
    report "$f: file name"
  fi
  # Text files only; -I treats binary files as non-matching.
  grep -Iq . "$f" 2>/dev/null || continue
  while IFS= read -r line; do
    report "$f:$line"
  done < <(sed -E "s#$sri##g" "$f" | grep -niE "$pattern" || true)
done < <(list_files)

if git rev-parse --verify -q HEAD >/dev/null 2>&1; then
  while IFS= read -r line; do
    report "commit message: $line"
  done < <(git log --format='%h %B' | grep -iE "$pattern" || true)
fi

if [ "$hits" -gt 0 ]; then
  echo "check-naming: $hits hit(s). Rename; do not add exceptions." >&2
  exit 1
fi
echo "check-naming: clean"
