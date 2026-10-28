#!/usr/bin/env sh
# Build static/css/app.css with the pinned Tailwind CSS standalone CLI (no Node.js required).
# Usage: bin/tailwind.sh            # one-off minified build
#        bin/tailwind.sh --watch    # rebuild on template changes during development
set -eu

VERSION="4.1.11"
cd "$(dirname "$0")/.."

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) ASSET="tailwindcss-linux-x64"; SHA256="64805b84af4292e043ea6f86d242f191c0ac75359c1a498455dfe6c642afdbab" ;;
  Linux-aarch64 | Linux-arm64) ASSET="tailwindcss-linux-arm64"; SHA256="0409aa4222969f47fa6f4160fe5387e79bf7269e7afe0e8b22f7532c98e1d314" ;;
  Darwin-arm64) ASSET="tailwindcss-macos-arm64"; SHA256="f5984b9c005c3e67841c33906c7a7c92e85e405f61e029e9bb62e880dd662e79" ;;
  Darwin-x86_64) ASSET="tailwindcss-macos-x64"; SHA256="76e27326506d10d50e65b751795f0537f9304ecb100abe835ec138c41774f38c" ;;
  *) echo "Unsupported platform $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

BIN="bin/tailwindcss"
if [ ! -x "$BIN" ] || [ "$(cat bin/.tailwind-version 2>/dev/null)" != "$VERSION-$ASSET" ]; then
  echo "Downloading Tailwind CSS v$VERSION ($ASSET)…"
  curl -fsSL -o "$BIN.tmp" "https://github.com/tailwindlabs/tailwindcss/releases/download/v$VERSION/$ASSET"
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL="$(sha256sum "$BIN.tmp" | cut -d' ' -f1)"
  else
    ACTUAL="$(shasum -a 256 "$BIN.tmp" | cut -d' ' -f1)"
  fi
  if [ "$ACTUAL" != "$SHA256" ]; then
    rm -f "$BIN.tmp"
    echo "Checksum mismatch for $ASSET" >&2
    exit 1
  fi
  mv "$BIN.tmp" "$BIN"
  chmod +x "$BIN"
  echo "$VERSION-$ASSET" > bin/.tailwind-version
fi

if [ "${1:-}" = "--watch" ]; then
  exec "$BIN" -i assets/tailwind.css -o static/css/app.css --watch
fi
exec "$BIN" -i assets/tailwind.css -o static/css/app.css --minify
