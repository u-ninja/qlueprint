---
name: agent-team-setup
description: Sets up a team of specialist Claude Code agents for a project, organised in departments of three to five agents each, with a roster, a working charter, model tiers, a routing table and CLAUDE.md rules so the main session delegates by default. Use when the user asks to create, set up, bootstrap or restructure a team of agents, a multi-agent workflow, specialist subagents per area, or to "use agents for the work". Not for writing a single one-off subagent.
---

# Agent team setup

Builds `.claude/agents/`, `.claude/team/ROSTER.md`, `.claude/team/CHARTER.md` and a "Team agents" section in `CLAUDE.md`, so the main session routes work to the agent that owns it. The shape that works: **few agents, each with a clear area of the repo**. Aim for 3–5 per department; a department of one is a person, not a team, and more than five means the areas overlap.

Do the steps in order. Don't write any agent file until step 3 is agreed.

## 1. Read the project (don't ask what the repo can answer)

Read `CLAUDE.md`, the README, the top-level layout, the build and test commands, and any docs on architecture or design. Note:

- the stacks and where each lives (`apps/web`, `src-tauri`, `services/api`, …);
- the areas where a mistake is expensive to undo (data stores, auth, payments, signing, releases, migrations);
- existing skills in `.claude/skills/` and rules in `CLAUDE.md` that agents must follow.

## 2. Draft the departments

Group by **who would own the files**, not by job title. Typical departments: Product & Delivery, Architecture, Frontend, Design, Backend, Data, Security, Quality, DevOps & Release. Drop what the project doesn't have; add what it does (Mobile, ML, Algorithms…). Then for each department pick 3–5 agents, each owning a named slice: directories, a subsystem or a concern. Check three things:

1. Every important directory has exactly one owner.
2. No agent owns more than it can hold in one brief (if its "owns" line needs three "and"s, split it).
3. Review is possible: for risky areas, someone other than the owner can review.

Give each agent a short lowercase first name (so `ben`, not `schema-diagram-engineer`), a role title and one line on what it owns. Names are the address; keep them unique and easy to type.

## 3. Show the plan and get it approved

Present a table: department, agent, role, owns, model tier. Say how many agents and departments. Ask the user to confirm or change it. This is the one question worth asking; everything else has a default below.

## 4. Choose model tiers

- `opus`: only the few roles where a wrong answer is costly and cross-cutting: chief architect, language or stack architects, security lead, performance architect. Around 5–8 per project.
- `sonnet`: everything else. The default.
- `haiku`: only for purely mechanical work (dependency bumps, triage). Omit if unsure; a haiku agent that gets a hard task costs more than it saves.

Tools: builders get no `tools:` line (all tools). Advisors and reviewers get `tools: Read, Grep, Glob, Bash, WebSearch`. Writers of docs and changelogs get `Read, Grep, Glob, Edit, Write, Bash`.

## 5. Write the agent files

One file per agent in `.claude/agents/<name>.md`, from [references/agent-template.md](references/agent-template.md). Fill in:

- `description`: who it is and **exactly when to use it**, naming the paths and concerns. This is what the main session reads to route, so make it specific.
- What it owns, the references and techniques it draws on, how it works, who it hands off to, which project skills it may load and when.
- Ground rules: how to verify (the real type-check, test and lint commands), never commit unless asked, treat secrets as private, and that `CLAUDE.md` wins over the agent file.

Agents must not spawn agents. Only the main session delegates.

## 6. Write the roster and charter

- `.claude/team/ROSTER.md`: one table per department (agent, role, model, owns).
- `.claude/team/CHARTER.md`, from [references/charter-template.md](references/charter-template.md): the routing table ("the task is about → start with → then bring in"), the delegation rule, token discipline, how to brief an agent, the two ways of working (gated stages for hard-to-reverse work, sprints for the rest), definition of done, hand-offs, escalation, safety limits.

Fill the routing table with the real agent names; every department should appear in it.

## 7. Wire it into CLAUDE.md

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
```

## 8. Check it

- Every `name:` matches its filename; no two agents share a name.
- Every name used in the charter and roster exists in `.claude/agents/`.
- Counts in `CLAUDE.md`, the roster and the charter agree.
- Run one real task through the routing table and confirm the right agent is picked from its `description`.

## How the main session uses the team afterwards

Pick the owner from the routing table; add one reviewer for risky changes; run agents in parallel only when their files don't overlap (at most three); brief each with the goal, exact files, constraints and what to return; don't ask two agents the same question. For hard-to-reverse work use gated stages and name who signs each gate.

## Merging an existing large roster

If the project already has many fine-grained agents, fold them into the departments above: the lead keeps its name and takes over the others' ownership lines, knowledge lists and working methods; delete the folded files in the same commit; update every name in the charter and roster. Don't keep both.
