# QluePrint brand

**QluePrint** (_KLOO-print_) — _Every Database. One Workspace._ Always one word, capital Q and capital P.

## The mark

A Q drawn as a blueprint. Its ring is the Q; its tail is a connector that leaves the ring, drops and turns along the drafting grid to a node, like a relationship line in a schema diagram. The node is the clue: the point where data connects. The tile is blueprint paper with a 12-step grid.

## Files

| File                            | Use                                                     |
| ------------------------------- | ------------------------------------------------------- |
| `qlueprint-logo-light.svg`      | Horizontal logo on light backgrounds                    |
| `qlueprint-logo-dark.svg`       | Horizontal logo on dark backgrounds                     |
| `qlueprint-logo-mono-black.svg` | One colour, black, no tile                              |
| `qlueprint-logo-mono-white.svg` | One colour, white, no tile                              |
| `qlueprint-icon.svg`            | App icon, 1024 canvas on the macOS icon grid (824 body) |
| `qlueprint-favicon.svg`         | Small sizes (16–32 px): no grid, heavier strokes        |

The app's icons are generated from `apps/desktop/src-tauri/icons/logo.svg` (a copy of `qlueprint-icon.svg`) with `pnpm tauri icon src-tauri/icons/logo.svg`.

## Colours

| Token     | Hex       | Use                                          |
| --------- | --------- | -------------------------------------------- |
| Blueprint | `#173f9e` | The tile                                     |
| Linework  | `#ffffff` | The mark on the tile; the grid at 7% and 16% |
| Ink       | `#111318` | Wordmark on light                            |
| Paper     | `#f5f7fb` | Wordmark on dark                             |

## Type

The wordmark is Geist SemiBold (SIL Open Font License 1.1), outlined, with the mark's own Q. `build-logos.py` regenerates every file:

```sh
python3 -m venv .venv && .venv/bin/pip install fonttools brotli
.venv/bin/python -I docs/brand/build-logos.py \
  apps/desktop/node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2 \
  docs/brand apps/desktop/src-tauri/icons/logo.svg
```

## What still says QueryCraft, on purpose

The rename keeps these so existing installs keep their data:

- Bundle identifier `com.querycraft.app`: where saved connections, workspaces, query tabs, local servers and the audit log are stored.
- Keychain service `QueryCraft`: where saved passwords are filed.
- Docker labels `com.querycraft.*`: how the app recognises the local servers it created.
- Sample tables marked “QueryCraft sample data” are still recognised; new ones say “QluePrint sample data”.
