# Project rules

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
