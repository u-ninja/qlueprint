# Tech stack

The libraries QluePrint uses and why. Versions are the latest checked on 2026-11-01; the lockfiles and `Cargo.lock` are the source of truth.

Rule for every addition: reuse what is already in the repo first (see [product-spec §17](product-spec.md#17-instructions-for-coding-agents)). Add a library only when it fills something the app does not have yet.

## Desktop UI (`apps/desktop/src`)

| Need             | Library                                                                             | Why                                                                                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework        | React 19, Vite 8, TypeScript 6                                                      | Already in place.                                                                                                                                                             |
| Styling          | Tailwind CSS 4 (`@tailwindcss/vite`)                                                | Design tokens from [the prototype](design/README.md) become Tailwind theme variables; light/dark is one place.                                                                |
| Components       | shadcn/ui on Radix                                                                  | Accessible menus, dialogs, tabs, tooltips and selects. Component code lives in our repo, so it can match the design exactly. Add each component once and reuse it everywhere. |
| Icons            | lucide-react                                                                        | Outline style used by the design.                                                                                                                                             |
| Fonts            | `@fontsource-variable/geist`, `@fontsource-variable/jetbrains-mono`                 | Bundled with the app so they work offline (the prototype loads them from Google Fonts).                                                                                       |
| Resizable panels | react-resizable-panels                                                              | Sidebar, editor/results split, inspector. Used by shadcn's Resizable.                                                                                                         |
| Command palette  | cmdk                                                                                | Used by shadcn's Command.                                                                                                                                                     |
| Toasts           | sonner                                                                              | shadcn's default toast.                                                                                                                                                       |
| App state        | Zustand 5                                                                           | Tabs, panel layout, theme.                                                                                                                                                    |
| Backend data     | TanStack Query 5                                                                    | Caching, loading and error states for data from Rust commands and the cloud API.                                                                                              |
| SQL editor       | Monaco (`@monaco-editor/react` + `monaco-editor`)                                   | Must load Monaco from the app bundle, not the default CDN, so it works offline.                                                                                               |
| SQL formatting   | sql-formatter                                                                       | Supports PostgreSQL, MySQL, SQL Server and SQLite.                                                                                                                            |
| Results grid     | TanStack Table + TanStack Virtual                                                   | Virtualized rows for large results. Glide Data Grid rejected (no React 19 support); AG Grid rejected (heavy, paid features).                                                  |
| Routing          | None                                                                                | One window with tabs and panels. Add a router only when there is a real need.                                                                                                 |
| Cloud sign-in    | `@neondatabase/auth`, `@fabianlars/tauri-plugin-oauth`, `@tauri-apps/plugin-opener` | Already in place. Optional; see [product-spec §2.5](product-spec.md#25-accounts-and-sign-in).                                                                                 |

## Local backend (`apps/desktop/src-tauri`, Rust)

| Need                            | Crate                | Why                                                                                |
| ------------------------------- | -------------------- | ---------------------------------------------------------------------------------- |
| App framework                   | Tauri 2              | Already in place. Commands and events are the only way the UI reaches the backend. |
| PostgreSQL, MySQL, SQLite       | sqlx                 | Async drivers with runtime (not only compile-time) queries.                        |
| Query cancellation (PostgreSQL) | tokio-postgres       | Has cancel tokens, if sqlx's support is not enough.                                |
| SQL Server                      | tiberius             | Added in roadmap phase 6.                                                          |
| Saved passwords                 | keyring              | OS keychain on Windows, macOS and Linux.                                           |
| Settings (theme, panel sizes)   | `tauri-plugin-store` | Small settings file in the app data directory.                                     |
| TypeScript types for commands   | specta or ts-rs      | Generate UI types from Rust types. To be verified against Tauri 2.12 before use.   |

## Cloud API (`apps/api`)

Already in place: Fastify 5, Drizzle ORM, PostgreSQL on Neon, Neon Auth (JWT verified with `jose`), TypeBox route schemas, Zod for environment variables. Only used for optional sign-in and, later, collaboration.

## Testing and quality

| Need                    | Tool                                                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| TypeScript unit tests   | Vitest                                                                                                           |
| UI and end-to-end tests | Playwright                                                                                                       |
| Rust tests and lint     | `cargo test`, `cargo clippy`, `cargo fmt`                                                                        |
| TypeScript lint         | ESLint + typescript-eslint (type-aware rules need TypeScript < 6.1, so the cloud API on TypeScript 7 skips them) |
