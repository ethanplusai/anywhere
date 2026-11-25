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
| `where.md` | Where the work lives and how it fits together: the repositories and folders, where it runs and how a change is deployed, the services it uses (by name, never keys) and how its parts connect. |
| `rules.md` | How to work on it: conventions, things never to do, who approves or merges what. Link to the project's `CLAUDE.md` or `AGENTS.md` rather than copying them. |
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

## Where it lives

`where.md` is how an agent finds the code and knows what a change touches. Keep it in this shape,
and leave out a section that does not apply:

<!-- template: where.md -->
```markdown
# Where it lives

## Code
- Repository: host/owner/name, default branch. Folders on this computer, if it matters.

## Hosting
- Where it runs, its domains, and how a change reaches production.

## Services
- Databases, sign-in, email, payments and other services it uses, by name. Never keys.

## How the parts connect
- Which part calls or depends on which, including other projects.
```

## Groups, status and repositories

Besides its pages, a project has three details, set with `create_project` and `update_project`:

- **group**: the business or area it belongs to, such as a company, a client list or "Personal".
  Projects are listed under their group. One business with several products is one group with
  several projects, not one big project.
- **status**: `active`, `paused` or `archived`. Pause what nobody is working on; archive what is
  finished or abandoned. Archived projects are tucked away, not deleted.
- **repos**: the code repositories that make up the project. A product whose app, website and admin
  live in separate repositories is still one project with all three listed. In a code folder that
  is not linked to a project, look the project up by the folder's git remote
  (`list_projects` with `repo`) before asking the person.

## Setting up for the first time

People rarely start from nothing: they already have work spread across folders, copies and
conversations. Setting up is mapping that work into projects with the person, then filling them in.
When someone says "set up Anywhere" or connects it for the first time with existing work:

1. **Map before reading.** In a coding agent with the skill, run its `map-work` script: it groups
   folders by repository from folder names, git remotes, session dates and session titles, and reads
   no file contents. Elsewhere, ask what they work on. Never read a project's files before they
   confirm the map.
2. **Projects, not folders.** One project per product or piece of work. Merge every checkout, copy,
   worktree and renamed folder of a repository into one, and put a product's repositories together.
   Name it by what it is, not by the folder. Put each project in its group. Suggest leaving out
   experiments, test runs, generated output and copies of other people's projects.
3. **Confirm it together.** Show the map with `choose_projects`, each project marked bring in, one
   line or skip, with a short reason. Wait for their answer and apply every correction they make.
4. **Fill in what they bring in.** Create each project with its group and repos, then fill
   `overview.md`, `plan.md`, `where.md`, `rules.md`, `decisions.md` and `open-questions.md` from
   what already exists: the README, `CLAUDE.md`, `AGENTS.md`, plan documents, deploy settings, and
   what the person tells you. Write only what those sources say.
5. **One line for the rest.** For a project marked one line, create it with status `paused`, its
   group, repos and description, and say in `overview.md` where it lives. Nothing else.
6. Start every imported page with the line `> Imported from <sources> on <date>. Check and delete
   this line.` so the person knows what to review.
7. Tell them what was created, grouped by business, and what to check first.
