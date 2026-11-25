# How a project is organized in Anywhere

This is the one description of the layout. The server's `guide` tool, its tool descriptions and the
skill all take their wording from this file. Change it here and nowhere else.

Anywhere is shared project context that every agent a person uses can read and write: Claude chat,
Claude Code, ChatGPT, Codex and others. A project is a small set of markdown pages. Keep them short,
current and readable by a person.

## Pages every project has

| Page | Holds |
|---|---|
| `overview.md` | What the project is, who it is for, the goals and the current state. Rewrite it as things change; do not append. |
| `plan.md` | Where the work stands: the goal, the phases, what is being done now, what comes next and what is blocked. Any agent can pick the work up from here. |
| `decisions.md` | Decisions, newest first. Each has a date, the decision in one line, and the reason. |
| `open-questions.md` | Things not yet decided. When one is settled, move it to `decisions.md`. |
| `ideas.md` | Brainstorm material nobody has committed to. |
| `log.md` | Short dated entries about what a session did or discussed. Append only. |
| `topics/<slug>.md` | One page per subject that has outgrown the pages above. |

## Rules

1. Read `overview.md` before you write anything to a project. To continue work, call `resume`
   first: it returns the current state, the plan's Now and Next, recent decisions and open questions.
2. Find the page a thing belongs on and update it. Do not create a second page for a subject that
   already has one.
3. Replace what is out of date. A reversed decision is edited where it stands, with a dated note,
   not added again lower down.
4. Keep entries short. Write the conclusion and the reason, not the conversation.
5. Date entries as `YYYY-MM-DD`.
6. Store what a different agent would need tomorrow: decisions, constraints, preferences, names,
   current state, next steps. Do not store secrets, passwords, API keys or transcripts.
7. After writing, tell the person which page you changed.
8. If a write is refused because the page changed, read the current version, merge your change into
   it, and write again.

## The plan

`plan.md` is how work survives a change of agent, account or provider. Keep it in this shape:

<!-- template: plan.md -->
```markdown
# Plan

## Goal
One line: what done looks like.

## Phases
- [x] Phase 1: what it covers
- [ ] Phase 2: what it covers

## Now
- What is in progress, by whom, and where (branch, file or document).

## Next
1. The next step, specific enough to start without asking.

## Blocked
- Nothing.
```

- Tick a phase or step off as soon as it is done, and rewrite Now and Next as you go. Do it before
  a long step, so a session that is cut off (a usage limit, a crash) leaves the plan current.
- Next is written for someone with no memory of this session: name the file, the command, the
  decision it depends on.
- If a planning tool or skill already keeps a detailed plan in the repository, link to it from
  `plan.md` and keep only the summary here.
- Planning and orchestration are up to the agent and the person. Anywhere only keeps the state.

## Setting up for the first time

When someone says "set up Anywhere" or connects it for the first time with existing work:

1. Ask which projects they want in Anywhere, or, in a coding agent with the skill, list the ones
   found on their computer and let them choose. Never read files before they agree.
2. For each project, create it and fill `overview.md`, `plan.md`, `decisions.md` and
   `open-questions.md` from what already exists: the project's README, `CLAUDE.md`, `AGENTS.md`,
   plan documents, and what the person tells you. Write only what those sources say.
3. Start every imported page with the line `> Imported from <sources> on <date>. Check and delete
   this line.` so the person knows what to review.
4. Tell them what was created, one line per project, and what to check first.
