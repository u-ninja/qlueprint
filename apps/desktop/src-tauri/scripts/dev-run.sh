#!/bin/sh
# Cargo runner for `tauri dev` on macOS: signs each fresh debug build with the same local identity
# before it starts, so the Keychain's "Always Allow" survives rebuilds. An unsigned rebuild is a
# new binary to macOS, which asks for the login keychain password again on every launch.
# One-time setup: see scripts/README-dev-signing.md. Without the identity it just runs unsigned.
IDENTITY="${QUERYCRAFT_DEV_SIGNING_IDENTITY:-QueryCraft Dev}"
if [ "$(uname)" = "Darwin" ] && security find-identity -p codesigning 2>/dev/null | grep -q "\"$IDENTITY\""; then
    codesign --force --sign "$IDENTITY" "$1" >/dev/null 2>&1 || echo "dev-run: couldn't sign $1 with \"$IDENTITY\"; it will ask for keychain access" >&2
fi
exec "$@"
