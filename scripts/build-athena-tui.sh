#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="${ATHENA_OPENCODE_SOURCE:-/tmp/athena-opencode-source}"
REVISION="1772e8ee6e794d1241dac6fa10d28e708f53b881"
# This build clones a repo and installs node_modules (~3GB) under SOURCE, which
# defaults to /tmp. Leaving it behind is a top contributor to /tmp filling up and
# the resulting ENOSPC/SIGBUS crashes, so clean it on exit unless asked to keep it
# (e.g. for fast incremental rebuilds via ATHENA_TUI_KEEP_SOURCE=1).
KEEP_SOURCE="${ATHENA_TUI_KEEP_SOURCE:-0}"

# Fail fast with a clear message instead of dying mid-install with a cryptic
# ENOSPC once the volume is already exhausted. The clone + install needs ~5GB.
MIN_FREE_MB=5000
free_mb="$(df -Pm "$(dirname "$SOURCE")" | awk 'NR==2 {print $4}')"
if [[ -n "$free_mb" && "$free_mb" -lt "$MIN_FREE_MB" ]]; then
  echo "error: only ${free_mb}MB free near $SOURCE; need ~${MIN_FREE_MB}MB to build the Athena TUI." >&2
  echo "       Free up space or set ATHENA_OPENCODE_SOURCE to a roomier volume." >&2
  exit 1
fi

cleanup() {
  if [[ "$KEEP_SOURCE" != "1" ]]; then
    rm -rf "$SOURCE"
  fi
}
trap cleanup EXIT

if [[ ! -d "$SOURCE/.git" ]]; then
  git clone https://github.com/anomalyco/opencode.git "$SOURCE"
fi

git -C "$SOURCE" fetch origin "$REVISION"
git -C "$SOURCE" checkout --detach "$REVISION"
git -C "$SOURCE" apply "$ROOT/docs/athena-opencode-branding.patch"

# Overlay Athena-owned native source (memory store + frozen snapshot) on top of
# the patched checkout. These are maintained as real files under athena-code/
# rather than as patch hunks; the branding patch only wires them in (e.g. prompt.ts
# imports ./memory/snapshot). Copy after the patch so the imported files exist
# before install/build.
cp -R "$ROOT/athena-code/overlay/." "$SOURCE/"

cd "$SOURCE"
npx --yes bun@1.3.14 install --frozen-lockfile
npx --yes bun@1.3.14 run --cwd packages/opencode script/build.ts --single --skip-install --skip-embed-web-ui
install -D packages/opencode/dist/opencode-linux-x64/bin/opencode "$ROOT/runtime-bin/linux-x64/athena-code"
