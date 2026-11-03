# Project rules

## UI and UX work

The design source of truth is `docs/design/` and product-spec §4 (Obsidian Flow);
skills guide execution, they don't override it. For any change in
`apps/desktop/src`:

- While building: follow `frontend-design`, `ui-typography` (quotes, dashes,
  spacing, hierarchy) and `bencium-controlled-ux-designer` (stay inside the
  existing design system rather than inventing new styles).
- React code: follow `react-best-practices` (skip its Next.js/server rules, this
  is a Vite SPA) and `composition-patterns`.
- Before committing UI changes: run `web-design-guidelines` on the changed
  files and fix what it finds.

## Before committing

Run `/simplify` on the pending diff and apply its fixes: reuse existing code
instead of duplicating it, and remove anything unused (dead code, imports,
files, dependencies) that the change introduced or left behind.

## Git commit messages

Every commit body must end with a status section before the
`Co-Authored-By` trailer, so the git log works as a progress tracker:

```
Pending:
- unfinished or known-broken parts of this change

Next:
- the best next step(s) to pick up, most important first
```

Keep each list short (1–5 bullets). Write `Pending: none` if nothing is left
open. To see where work stands, read the latest commit's `Next:` section.
