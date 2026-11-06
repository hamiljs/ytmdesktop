#!/usr/bin/env bash
# Build the HDC fork of YouTube Music Desktop and install it in /Applications.
#
#   scripts/hdc-install.sh            build, sign, install, start
#   scripts/hdc-install.sh --no-install   build and sign only (output in out/)
#
# Why a local build: upstream's arm64 zip ships with a broken ad-hoc signature, so every
# update needed a manual re-sign. Building it here signs it once, correctly, and carries
# our changes.
#
# Last.fm: get an API account at https://www.last.fm/api/account/create. The key and
# secret are compiled into the app, exactly as upstream's CI does with its own key. Give
# them as LASTFM_API_KEY / LASTFM_API_SECRET, or put 1Password references in a git-ignored
# .hdc-secrets.env next to this repo's package.json:
#   LASTFM_API_KEY=op://<vault>/<item>/api_key
#   LASTFM_API_SECRET=op://<vault>/<item>/shared_secret
set -euo pipefail
cd "$(dirname "$0")/.."

APP_NAME="YouTube Music Desktop App"
INSTALLED="/Applications/$APP_NAME.app"
INSTALL=1
[[ "${1:-}" == "--no-install" ]] && INSTALL=0

echo "==> Rust helpers (call watcher, ytm CLI)"
cargo build --release --manifest-path native/callwatch/Cargo.toml --quiet
cargo build --release --manifest-path native/ytm-cli/Cargo.toml --quiet

echo "==> Tests"
node --test test/ >/dev/null
cargo test --release --manifest-path native/callwatch/Cargo.toml --quiet >/dev/null
cargo test --release --manifest-path native/ytm-cli/Cargo.toml --quiet >/dev/null

echo "==> Package"
corepack pnpm install --frozen-lockfile >/dev/null
if [[ -n "${LASTFM_API_KEY:-}" ]]; then
  corepack pnpm package >/dev/null
elif [[ -f .hdc-secrets.env ]]; then
  op run --env-file=.hdc-secrets.env -- corepack pnpm package >/dev/null
else
  echo "    no Last.fm key (LASTFM_API_KEY or .hdc-secrets.env): building without Last.fm" >&2
  corepack pnpm package >/dev/null
fi

BUILT="out/$APP_NAME-darwin-arm64/$APP_NAME.app"
[[ -d "$BUILT" ]] || { echo "build output missing: $BUILT" >&2; exit 1; }
[[ -x "$BUILT/Contents/Resources/callwatch" ]] || { echo "callwatch missing from the bundle" >&2; exit 1; }

echo "==> Sign (ad-hoc) and verify"
codesign --force --deep --sign - "$BUILT"
codesign --verify --deep --strict "$BUILT"
echo "    signature OK"

if [[ $INSTALL == 0 ]]; then
  echo "Built: $BUILT"
  exit 0
fi

echo "==> Install"
if pgrep -f "$APP_NAME.app/Contents/MacOS" >/dev/null; then
  osascript -e "tell application \"$APP_NAME\" to quit" || true
  for _ in $(seq 1 20); do pgrep -f "$APP_NAME.app/Contents/MacOS" >/dev/null || break; sleep 0.5; done
  pkill -f "$APP_NAME.app/Contents/MacOS" 2>/dev/null || true
fi
if [[ -d "$INSTALLED" ]]; then
  # The old copy goes to the Trash, not away: drag it back to roll back
  /usr/bin/trash "$INSTALLED"
fi
ditto "$BUILT" "$INSTALLED"
# The agent CLI: ytm state, ytm search ..., ytm play ...
mkdir -p "$HOME/.local/bin"
install -m 0755 native/ytm-cli/target/release/ytm "$HOME/.local/bin/ytm"
codesign --verify --deep --strict "$INSTALLED"
open -a "$INSTALLED"
echo "Installed $(defaults read "$INSTALLED/Contents/Info.plist" CFBundleShortVersionString) (HDC fork $(git rev-parse --short HEAD))"
