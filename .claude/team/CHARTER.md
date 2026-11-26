# Team charter

How the QluePrint agents work together. The people to call are in [ROSTER.md](ROSTER.md); each is a file in `.claude/agents/`. Project rules in `CLAUDE.md` always win over this document.

## What the agents are

Each agent is a prompt with a role, a scope in this repo and a set of working methods. They don't remember earlier runs and they don't run on their own: the main session picks one to three of them per task, hands each the context it needs, and reads what they write back. More agents on a task is not better. Use the fewest that cover the work.

## Calling the right people

| The task is about | Start with | Then bring in |
| --- | --- | --- |
| Deciding how to run a piece of work, planning, risk | `ron` | `pia` |
| A new feature's scope and acceptance | `pia` | `vera` (users), `tai` |
| A cross-cutting design | `vic` | `rae`, `ned`, `sol` |
| A UI change | the owner in Frontend (`tom`, `liv`, `ben`, `nat`) | `tai` for design, `zack` for accessibility |
| A command, driver or query path | the owner in Rust & Backend | `rae`, the engine's owner in Database Specialists |
| A schema, index, DDL or transaction question | `ada` | the engine's owner |
| Something that feels slow | `uma` | `tom` (UI), `reid` (measure) |
| Anything touching secrets, audit or auth | `sol` | `lena`, `milo` |
| Tests | `reid` | `ozzy`, `toby`, `vito` |
| Build, signing, installers, updates | `alma` | `cy`, `dina`, `dave` |
| A release | `kit` | `hugo`, `dina`, `lou` |

## Delegating

The main session hands work to the department that owns the files, instead of doing it inline. Anything beyond a trivial edit (a typo, a one-line fix) goes to the owner from the table above, briefed as described below. Take on a task yourself only when no agent's area fits or the change is a few lines.

## Spending tokens well

The goal is the best result for the fewest tokens. Every agent file already fixes its own model, tools and skills; this is how the main session uses them.

**Model tiers** (set in each agent's `model:` line, see the Model column in [ROSTER.md](ROSTER.md)):

| Tier | Used for | Count |
| --- | --- | --- |
| `opus` | Cross-cutting design and security calls where a wrong answer is expensive: `vic`, `rae`, `ned`, `ada`, `sol`, `uma`, `lena` | 7 |
| `sonnet` | Building, reviewing and specialist advice. The default | 37 |

Move a task up a tier only when the agent says it is beyond its own, and never run an `opus` agent for work a `sonnet` one can do. When the main session spawns an agent it may override the model for a single task.

**Choosing agents**

1. Use the fewest agents that cover the task. One owner plus, at most, one reviewer is the normal shape.
2. Run agents in parallel only when their work is independent: different files, no shared decision. Cap it at three at once. Agents that depend on each other's output run in sequence.
3. Pure searching ("where is X used") goes to a read-only search agent, not a specialist.
4. Do not ask several agents the same question. If two disagree, escalate (see below) rather than adding a third opinion.

**Briefing an agent** (this is where most tokens are saved)

- Give the goal, the exact files or directories, the constraints, and what a finished result looks like. An agent that has to rediscover the context pays for it again.
- Say what to return and how long: a decision, a ranked list with file and line, or a diff summary. Under 300 words unless the task needs more.
- Say what is out of scope, so the agent does not wander into another owner's area.
- Pass facts you have already established rather than asking the agent to find them again.

**Skills**

Each agent lists the project skills it may use and the trigger for each. A skill is loaded only when its trigger applies: `react-best-practices` for React edits, `web-design-guidelines` for auditing changed UI, `security-review` for security checks, and so on. Skills are not preloaded into agents, because a loaded skill costs tokens on every turn that follows.

**What not to spend on**

- Re-reading files already in the brief, or whole files when a search finds the lines.
- Agents spawning agents. Only the main session spawns.
- Reviews of unchanged code, or running every review on a one-line fix. Match the review to the risk: a typo needs none, a driver change needs a gate.

## Two ways of working, chosen per piece of work

`ron` decides which one applies and writes it at the top of the task. The test is how costly a mistake is to undo.

### Gated stages (waterfall)

For work that is hard to reverse, or where being wrong late is expensive:

- Database driver behaviour and catalog queries
- The audit log's format and the credential store
- Security design and authentication
- Code signing, installers and the updater
- Releases

| Gate | Entry | Exit (signed off by) |
| --- | --- | --- |
| 1. Requirements | A request | Numbered, testable requirements traced to the spec (`pia`) |
| 2. Design | Approved requirements | Written design with an ADR for each real choice, a threat model if it touches trust, and complexity and performance budgets (`vic`, plus `sol` and `uma` where relevant) |
| 3. Build | Approved design | Code and tests that meet the design, reviewed by someone who did not write them |
| 4. Verify | Build done | Test plan run, including the failure paths, on every supported platform that applies (`reid`, `toby`) |
| 5. Release | Verified | Release checklist green, rollback ready, notes written (`kit`, `hugo`) |

Nothing starts a stage before the one before it is signed. Anyone may send work back a gate; nobody skips one.

### Sprints (agile)

For work that is cheap to change: UI features, polish, most fixes.

- Two-week sprints. `pia` owns the order of the backlog, `ron` owns the flow.
- A story is ready when it has a user outcome, acceptance criteria and a named owner. It is done when it meets the definition below.
- Bugs run as a Kanban lane with a work-in-progress limit. `toby` triages by user impact.
- Each sprint ends with a demo of working software and a short retrospective with one change to try. `ron` reports cycle time and forecasts as ranges.

### Definition of done (both modes)

1. It does what the acceptance criteria say, and the failure paths are handled.
2. `pnpm exec tsc --noEmit` is clean for TypeScript and `cargo check` and `cargo test` pass for Rust.
3. UI changes use the existing design system and pass `web-design-guidelines`, and are keyboard-operable (`zack`).
4. Anything user-visible is described in `apps/desktop/CHANGELOG.md`.
5. New code has a stated complexity where it loops over schema-sized or result-sized data, and the unused code it replaced is gone (`/simplify`).
6. No secrets, connection strings or row data in files, logs or commits.
7. The commit message ends with the `Pending:` and `Next:` sections that `CLAUDE.md` requires.

## Engineering standards

- **Algorithms and data structures are a design decision, not an afterthought.** Write the complexity next to any loop over tables, columns or rows. Pick the structure by the access pattern: a heap for due jobs, a trie for completion, a ring or LRU for bounded caches, a topological order and strongly connected components for diagrams, a rope or piece table for large text. `reid` reviews claims; `ben` (graphs), `jude`, `kai`, `lola` and `moss` own the techniques.
- **Measure before optimising.** `uma` sets a budget per interaction; `reid` measures against it on realistic data sizes.
- **Decide in writing.** A real choice gets a short ADR (context, options, decision, consequences) in `docs/`. `vic` keeps them.
- **Review by someone else.** The author does not approve their own change. A Rust change is reviewed by a second Rust owner, a UI change by a second UI owner plus accessibility.
- **One source of truth per fact.** Link to it rather than copying it.
- **Safe by default.** Destructive actions are staged, shown as exact SQL and confirmed. Metadata is never invented: what a database does not report stays empty.

## Hand-offs

Every hand-off is written and has four parts:

1. **Done:** what changed, with file paths.
2. **Open:** what is not done or is known to be wrong.
3. **Decisions:** what was decided and why, including what was rejected.
4. **Next:** what the receiver should do first.

## Escalation

If two agents disagree, each states the trade-off in one paragraph and `vic` decides on technical matters, `pia` on scope and priority, `sol` on anything security. `ron` decides which of those applies. A decision made this way is recorded, and reopened only with new information.

## Growing the team

The team follows the project. When a task adds a new app, package, service, language or major subsystem, or touches files no agent owns, run the `agent-team-setup` skill in grow mode: add or extend the owning agent, then update the roster, the routing table above and the counts in `CLAUDE.md`. Keep every department at 3-5 agents; split an agent that has become a catch-all and retire one whose area is gone.

## Safety limits

- Agents do not commit, push, publish or send anything outside the machine unless the user asked in this session.
- Test data lives in the `shop` and `hr` schemas of the development Postgres and in SQLite fixtures. Nothing in this repo may contain a real credential: connection strings come from the environment.
- Security testing (`lena`) covers QluePrint's own code and fixtures only.
