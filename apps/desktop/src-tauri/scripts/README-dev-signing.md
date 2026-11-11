# Dev signing on macOS (stops repeated Keychain prompts)

`tauri dev` rebuilds an unsigned binary each time, and macOS treats every rebuild as a new app,
so it asks for the login keychain password whenever QueryCraft reads a saved connection password.
Signing every debug build with the same local certificate makes macOS recognise it as the same app.

One-time setup:

1. Open **Keychain Access → Keychain Access (menu) → Certificate Assistant → Create a Certificate…**
2. Name: `QueryCraft Dev` · Identity Type: **Self Signed Root** · Certificate Type: **Code Signing** → Create.
3. Restart `pnpm tauri dev`. The runner (`scripts/dev-run.sh`, wired in `.cargo/config.toml`)
   signs each build with it.
4. The next Keychain prompt: enter your login password and choose **Always Allow**, once.
   It won't ask again for that saved password, even after rebuilds.

Use a different certificate name by setting `QUERYCRAFT_DEV_SIGNING_IDENTITY`.
Release builds are signed by the normal bundling process and don't need this.
