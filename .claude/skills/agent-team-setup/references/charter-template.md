# Team charter

How the agents work together. The people to call are in [ROSTER.md](ROSTER.md); each is a file in `.claude/agents/`. `CLAUDE.md` always wins over this document.

## What the agents are

Each agent is a prompt with a role, a scope in this repo and working methods. They don't remember earlier runs and don't run on their own: the main session picks one to three per task, hands each the context it needs, and reads what they write back. More agents is not better; use the fewest that cover the work.

## Calling the right people

| The task is about | Start with | Then bring in |
| --- | --- | --- |
| <area> | `<agent>` | `<reviewer or helper>` |

(One row per department at least. Include "deciding how to run the work", "a cross-cutting design", "anything touching secrets", "tests", "a release".)

## Delegating

The main session hands work to the department that owns the files instead of doing it inline. Anything beyond a trivial edit goes to the owner from the table above. Do it yourself only when no agent's area fits or the change is a few lines.

## Spending tokens well

**Model tiers:** `opus` for the few cross-cutting or security roles (list them); `sonnet` for the rest. Move a task up a tier only when the agent says it is beyond its own.

**Choosing agents:** fewest that cover the task; one owner plus at most one reviewer is normal; parallel only when files don't overlap, cap three; never ask several agents the same question; pure searching goes to a read-only search agent.

**Briefing:** goal, exact files, constraints, what a finished result looks like, what to return and how long, what is out of scope, facts already established.

**Don't spend on:** re-reading files already in the brief; agents spawning agents (only the main session spawns); reviews of unchanged code.

## Two ways of working

Test: how costly is a mistake to undo? The program lead decides and writes it at the top of the task.

- **Gated stages** for hard-to-reverse work (<list: data layer, auth, signing, releases>): Requirements → Design → Build → Verify → Release, each signed off by a named agent before the next starts.
- **Sprints** for cheap-to-change work: short iterations; a ready story has an outcome, acceptance criteria and an owner.

## Definition of done

1. Does what the acceptance criteria say, failure paths handled.
2. `<typecheck>` and `<test>` pass.
3. UI changes follow the design system and are keyboard-operable.
4. User-visible changes are in the changelog.
5. Unused code the change replaced is removed.
6. No secrets or user data in files, logs or commits.
7. The commit message follows `CLAUDE.md`.

## Hand-offs

Written, four parts: Done (with paths), Open, Decisions (including what was rejected), Next.

## Escalation

If two agents disagree, each states the trade-off in one paragraph and the right owner decides (architecture: <agent>; scope: <agent>; security: <agent>). Record the decision; reopen only with new information.

## Growing the team

The team follows the project. When a task adds a new app, package, service, language or major subsystem, or touches files no agent owns, run the `agent-team-setup` skill in grow mode: add or extend the owning agent, then update the roster, the routing table above and the counts in `CLAUDE.md`. Keep every department at 3-5 agents; split an agent that has become a catch-all and retire one whose area is gone.

## Safety limits

Agents don't commit, push, publish or send anything off the machine unless the user asked in this session. No real credentials in the repo.
