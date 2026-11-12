# QluePrint design prototype

`QluePrint.dc.html` is the interactive desktop workspace prototype exported from Claude Design. It is the visual reference for the app; build screens to match it, one step at a time.

`support.js` is the runtime the prototype needs. Keep the two files together.

## Viewing it

Opening the HTML straight from disk may not work, so serve the folder locally:

```sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory docs/design
```

Then open http://127.0.0.1:8765/QluePrint.dc.html.

## What it contains

- **Shell:** title bar, workspace switcher, "Offline · No account required" indicator, command search (⌘K), theme toggle (light / dark / system), optional "Sign in".
- **Navigation rail:** Workspace, Connections, Queries, History, Snippets.
- **Workspace sidebar:** explorer tree with environment badges (DEV / STG / PROD), saved queries, local servers.
- **SQL workspace:** editor tabs, Run / Stop / Explain / Format toolbar, connection picker, results grid, Messages and Plan tabs, status bar.
- **Inspector:** selected table's stats, columns, indexes, and Select top 100 / Copy DDL actions.
- **Dialogs:** new local server wizard (engine → configure → review → create), new connection form, command palette, confirmation dialog.

Design tokens (colors in `oklch`, both themes) are defined in the `:root` / `[data-theme]` blocks at the top of the HTML. Fonts are Geist for UI and JetBrains Mono for code.
