---
name: agent-team-setup
description: Sets up, and keeps growing, a team of specialist Claude Code agents shaped by the project it runs in. Builds departments of three to five agents, a roster, a charter, model tiers, a routing table and CLAUDE.md rules so the main session delegates by default; later audits the team against the repo and adds, splits, updates or retires agents as the project grows. Use when the user asks to create, set up, bootstrap, restructure, audit or grow a team of agents, a multi-agent workflow or specialist subagents per area, when a new service, package or stack has no owner, or when asked to "use agents for the work". Not for writing a single one-off subagent.
---

# Agent team setup

Builds `.claude/agents/`, `.claude/team/ROSTER.md`, `.claude/team/CHARTER.md` and a "Team agents" section in `CLAUDE.md`, so the main session routes work to the agent that owns it. The team is derived from the project it runs in, and it is kept in step as the project changes.

Shape that works: **few agents, each with a clear area of the repo**. A department has 3–5 agents; a department of one is a person, not a team, and more than five means the areas overlap.

Two modes:

- **Setup**: there is no `.claude/agents/` yet. Steps 1–8.
- **Grow**: a team exists. Go to [Keeping the team in step with the project](#keeping-the-team-in-step-with-the-project).

If unsure, run `python3 -I <skill-dir>/scripts/audit.py <repo>`; it says whether a team exists and where it has drifted.

## Setup

Do the steps in order. Don't write any agent file until step 3 is agreed.

### 1. Read the project (don't ask what the repo can answer)

Read `CLAUDE.md`, the README, the top-level layout, the build and test commands, and any docs on architecture or design. Note:

- the stacks and where each lives (`apps/web`, `src-tauri`, `services/api`, …);
- the areas where a mistake is expensive to undo (data stores, auth, payments, signing, releases, migrations);
- existing skills in `.claude/skills/` and rules in `CLAUDE.md` that agents must follow;
- how big the project is: number of apps and packages, languages, who works on it.

### 2. Size the team to the project, then draft departments

**Start as small as the project is.** The team is not a fixed template; it comes from the repo.

| Project | Start with |
| --- | --- |
| One app, one stack, one or two people | 1–2 departments, 3–6 agents in total: an architect-reviewer, an owner per major area, a quality and release owner |
| Several apps or services, a few people | 4–7 departments, 15–30 agents |
| A platform with many stacks and teams | The full set of departments below, 30–60 agents |

Group by **who would own the files**, not by job title. Candidate departments: Product & Delivery, Architecture, Frontend, Design, Backend, Data, Security, Quality, DevOps & Release. Use only the ones the project has; add what it does have (Mobile, ML, Algorithms, Cloud…). Then for each department pick 3–5 agents, each owning a named slice: directories, a subsystem or a concern. Check three things:

1. Every important directory has exactly one owner.
2. No agent owns more than it can hold in one brief (if its "owns" line needs three "and"s, split it).
3. Review is possible: for risky areas, someone other than the owner can review.

Give each agent a short lowercase first name (so `ben`, not `schema-diagram-engineer`), a role title and one line on what it owns. Names are the address; keep them unique and easy to type.

### 3. Show the plan and get it approved

Present a table: department, agent, role, owns, model tier. Say how many agents and departments. Ask the user to confirm or change it. This is the one question worth asking; everything else has a default below.

### 4. Choose model tiers

- `opus`: only the few roles where a wrong answer is costly and cross-cutting: chief architect, stack architects, security lead, performance architect. Around 5–8 per project, fewer in a small one.
- `sonnet`: everything else. The default.
- `haiku`: only for purely mechanical work (dependency bumps, triage). Omit if unsure; a haiku agent that gets a hard task costs more than it saves.

Tools: builders get no `tools:` line (all tools). Advisors and reviewers get `tools: Read, Grep, Glob, Bash, WebSearch`. Writers of docs and changelogs get `Read, Grep, Glob, Edit, Write, Bash`.

### 5. Write the agent files

One file per agent in `.claude/agents/<name>.md`, from [references/agent-template.md](references/agent-template.md). Fill in:

- `description`: who it is and **exactly when to use it**, naming the paths and concerns. This is what the main session reads to route, so make it specific.
- What it owns (real paths, checked against the repo), the references and techniques it draws on, how it works, who it hands off to, which project skills it may load and when.
- Ground rules: how to verify (the real type-check, test and lint commands), never commit unless asked, treat secrets as private, and that `CLAUDE.md` wins over the agent file.

Agents must not spawn agents. Only the main session delegates.

### 6. Write the roster and charter

- `.claude/team/ROSTER.md`: one table per department (agent, role, model, owns). Keep the `| \`name\` |` row format; the audit script reads it.
- `.claude/team/CHARTER.md`, from [references/charter-template.md](references/charter-template.md): the routing table ("the task is about → start with → then bring in"), the delegation rule, token discipline, how to brief an agent, the two ways of working (gated stages for hard-to-reverse work, sprints for the rest), definition of done, hand-offs, escalation, safety limits.

Fill the routing table with the real agent names; every department should appear in it.

### 7. Wire it into CLAUDE.md

Add a "Team agents" section, replacing any existing one:

```
## Team agents

`.claude/agents/` holds N specialist agents in M departments, each named (`a`, `b`, …).
Who they are is in `.claude/team/ROSTER.md`; how they work together is in
`.claude/team/CHARTER.md`.

**Delegate by default.** Any task beyond a trivial edit goes to the agent whose
department owns the files (routing table in the charter), not done inline in the
main session. Use the fewest agents that cover a task. Brief them with exact files
and ask for short answers. They never commit unless asked.

**Keep the team current.** When a task adds a new app, package, service, language
or major subsystem, or touches files no agent owns, run the `agent-team-setup`
skill in grow mode before finishing: add or update the owning agent, then the
roster, routing table and counts.
```

### 8. Check it

- Run `python3 -I <skill-dir>/scripts/audit.py <repo>`: it should report no unowned directories and no stale paths.
- Every `name:` matches its filename; no two agents share a name.
- Every name used in the charter and roster exists in `.claude/agents/`.
- Counts in `CLAUDE.md`, the roster and the charter agree.
- Run one real task through the routing table and confirm the right agent is picked from its `description`.

## Keeping the team in step with the project

A team that is set up once and never touched goes stale: new code has no owner, old owners point at deleted files, and agents grow into catch-alls. Run grow mode:

- **When**: a task adds a directory, package, service, language or integration; an agent says "that's outside my area" twice; an agent's description names paths that no longer exist; a department passes five agents or falls under three; before a release; or when the user asks for a team review.
- **How**:
  1. Run `python3 -I <skill-dir>/scripts/audit.py <repo>`. It lists directories no agent owns, paths agents claim that no longer exist, departments outside 3–5 agents, and roster/file mismatches.
  2. Read the git log since the team was last changed (`git log --oneline -- .claude/agents .claude/team`) and the new areas of the repo, to see what the project became.
  3. Propose changes as a short list, one of these per item:
     - **Add** an agent for an unowned area (name, role, owns, model, department). Put it in the department whose files it touches; start a new department only when the area is unlike any existing one.
     - **Extend** an agent whose neighbour area is small: add the paths to its ownership and its `description`.
     - **Split** an agent that has become a catch-all or whose brief no longer fits one task.
     - **Retire or merge** an agent whose area is gone or has become trivial.
     - **Fix** stale paths, descriptions and names.
  4. Get the user's approval for adds, splits and retirements. Fixes of stale paths can be applied directly and reported.
  5. Apply the changes to the agent files, then the roster, the routing table in the charter, and the counts in `CLAUDE.md`. Re-run the audit; it should come back clean.
  6. Put a line in the commit message: which agents were added, changed or removed, and why.

Rules while growing: don't rewrite agents that still fit; don't add an agent for a one-off task; keep each department at 3–5; keep model tiers as set unless an area has become high-risk.

## How the main session uses the team afterwards

Pick the owner from the routing table; add one reviewer for risky changes; run agents in parallel only when their files don't overlap (at most three); brief each with the goal, exact files, constraints and what to return; don't ask two agents the same question. For hard-to-reverse work use gated stages and name who signs each gate. If a task touches files nobody owns, finish it, then run grow mode.

## Merging an existing large roster

If the project already has many fine-grained agents, fold them into the departments above: the lead keeps its name and takes over the others' ownership lines, knowledge lists and working methods; delete the folded files in the same commit; update every name in the charter and roster. Don't keep both.
