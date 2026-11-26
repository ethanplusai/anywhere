---
name: anywhere
description: Shared project context that every agent a person uses can read and write (Claude chat, Claude Code, ChatGPT, Codex). Use when the user says "add this to anywhere", "check anywhere", "save this to anywhere", "what did we decide", "what do we know about <project>", "pick up where we left off", "set up anywhere", or asks to save decisions, plans, context or next steps so other agents can see them; at the start of work in any folder that has a `.anywhere/` directory; and before a long step in work that has a plan in Anywhere.
---

# Anywhere

Anywhere keeps one small set of markdown pages per project. Every agent the person uses reads and
writes the same pages, so a decision made in Claude chat on Monday is there for Claude Code on
Tuesday. Your own memory is separate and stays as it is; Anywhere is the part shared across agents.

## When to reach for it

- The person says "add this to anywhere", "save this for the other agents", "note that we decided...".
- The person asks "check anywhere", "what did we decide about X", "where did we leave the Acme
  project", or mentions a project by name and the answer might already be written down.
- You are starting work in a folder that contains `.anywhere/`: this project is linked (see below).
- You are finishing a session that produced a decision, a constraint or a next step another agent
  would need.
- The person says "pick up where we left off", "continue the build", or has just switched agent,
  account or provider: call `resume` for the project and start from Next in its plan.
- The person says "set up Anywhere", or connects it with lots of existing work: follow "Setting up"
  below.

Do not use it for scratch work, for things only this one conversation needs, or because a task
happens to be long.

## Two ways in

1. **MCP tools** (always available when the Anywhere connector is added): `guide`, `list_projects`,
   `create_project`, `update_project`, `get_project`, `resume`, `read_page`, `write_page`, `append_to_page`,
   `delete_page`, `search`, and four that show the person Anywhere itself, drawn in the conversation
   where their app can do that and returned to you as text where it cannot: `show_projects` (all
   their projects), `show_project` (where one stands), `show_page` (one page, for reading) and
   `choose_projects` (a map of their work to confirm when setting up). When the person asks to see, look at or open
   something in Anywhere, show it with these rather than describing it, and do not repeat what they
   can already see. Call `guide` once per conversation before first use. Resolve a project name to its slug
   with `list_projects`, then `get_project` returns the page list and the full `overview.md`.
2. **The local mirror**, only for coding agents in a linked folder: the same pages as real files in
   `.anywhere/`, kept in step by the `anywr` command. Optional; everything below also works with the
   MCP tools alone.

If you have no file access (chat), use the MCP tools. If nothing is linked, use the MCP tools. If
there is no Anywhere connector and no `.anywhere/`, follow "Getting connected" below; do not invent
a place to store things.

## Getting connected

When the person asks for Anywhere and you have none of its tools, connect it rather than handing
them commands. Ask once before changing their settings, then do the steps yourself.

**In a chat app (no shell):** say that Anywhere is added in the app's settings as a connector, with
the address `https://mcp.anywr.ai/mcp` (or their own server's `/mcp` address), and stop there.

**With a shell (Claude Code, Codex):**

1. See whether an Anywhere is already running on this computer:

   ```bash
   curl -s http://127.0.0.1:3341/healthz
   ```

   `{"ok":true}` means it is. Go to step 3.
2. If nothing answers, ask which they want.
   - **On this computer** (one person, no account; needs Node.js 22 and pnpm). Start it and leave it
     running in the background:

     ```bash
     git clone https://github.com/ethanplusai/anywhere.git ~/anywhere
     cd ~/anywhere && pnpm install && pnpm local
     ```

   - **The hosted service** (works in chat apps too, needs an account at https://anywr.ai):
     `claude mcp add --scope user --transport http anywhere https://mcp.anywr.ai/mcp`, or
     `codex mcp add anywhere --url https://mcp.anywr.ai/mcp` then `codex mcp login anywhere`. In
     Claude Code the person then types `/mcp`, picks `anywhere` and chooses Authenticate. Skip to
     step 4.
3. Connect yourself to the local one. Its token is in a file only the person can read. Never read
   it into the conversation or print it: pass it straight from the file.
   - Claude Code:

     ```bash
     claude mcp add --scope user --transport http anywhere-local http://127.0.0.1:3341/mcp --header "Authorization: Bearer $(cat ~/.anywhere/agent-token)"
     ```

   - Codex, or if that fails: open the app for them and ask them to press **Connect** beside their
     agent's name. It does the same thing and installs this skill.

     ```bash
     open "http://127.0.0.1:3341/local/unlock#token=$(cat ~/.anywhere/browser-token)"
     ```

4. A connection only loads in a new session, so you cannot use it in this one. Say exactly that,
   and what to do next: "Anywhere is connected. Open a new session and say: Set up Anywhere."

## The layout and the rules

<!-- layout:start -->
{{LAYOUT}}
<!-- layout:end -->

## Picking work back up

When work continues in a new session, on another account, or with another agent or provider:

1. Call `resume` with the project's slug. It returns the current state, the plan (goal, phases, Now,
   Next, Blocked), recent decisions, open questions, the latest log entries and who changed what.
   When the person asks to see where a project stands, call `show_project` instead: it shows them
   the project and gives you the same briefing. `show_projects` shows all of them, and `show_page`
   one page.
2. Start from Next in `plan.md`. If the repository has a detailed plan the summary links to, open it.
3. As you work, keep `plan.md` current: tick phases and steps off, rewrite Now and Next. Do it before
   any long step, so if this session is cut off by a usage limit, the next one starts in the right
   place. At the end, append a dated line to `log.md`.

If `plan.md` is empty and there is work in progress, fill it in first.

## Setting up

Most people already have work spread over many folders, copies and conversations. Setting up is
mapping that work into projects together with the person, then filling in the ones they keep.

1. Call `list_projects` to see what is already there.
2. **Map their work.** With file access (Claude Code, Codex), ask first: "Can I map the work on this
   computer? I'd read folder names, git remotes, the dates and titles of your past agent sessions,
   and which docs each project has. Not your files or full conversations." When they agree, run

   ```bash
   node <this skill's folder>/scripts/map-work.mjs
   ```

   It prints the work grouped by repository owner (usually a business), then by product, each
   repository with every folder that holds a copy of it, where it is hosted, which docs it has and
   what recent sessions were about, and a suggestion: `bring_in`, `brief` or `skip`. At the end it
   lists what it set aside: generated output, other people's projects, folders that no longer exist
   and sessions outside any project. `--json` gives the same as data.

   Without file access (Claude chat, ChatGPT), ask what they work on, by business, and what you
   remember of it from past conversations.
3. **Turn it into a map.** The script groups by name; you judge by meaning. Read the session titles
   and folder names, then:
   - Make one project per product or piece of work. A product's app, website and admin are one
     project with several repos. A folder named after an old name (a rename) is the same project.
   - Name each by what it is, and give it a group: the business it belongs to. Repository owners
     are a first guess; a person's own account often holds several businesses' work.
   - Clients' sites usually belong in their agency's group. If there are many, suggest one project
     per active client and `brief` for the rest.
   - Folders that no longer exist and sessions outside any project still tell you what was worked
     on: fold them into the project they were about, or mention them.
   - Keep the map short: at most about 40 entries. Leave long tails of skipped repositories out of
     the map and say how many there are.
4. **Confirm it together.** Call `choose_projects` with the map: one entry per project with its
   `group`, `description`, `repos`, `checkouts`, `last_active`, `suggest` and a few-word `reason`.
   Mark ones already in Anywhere with `existing`. Then stop and wait. Their answer lists what to
   bring in fully, what to keep as one line, what to leave out, and any corrections. Apply every
   correction; if one changes the map a lot, show it again. If they answer without having seen a
   map, show it as a short grouped list and ask them to confirm or correct it.
5. **Bring in what they chose.** For each project to bring in fully, in turn:
   - Create it with `create_project`: name, one-line description, `group` and every `repos`
     address. For one already in Anywhere, use `update_project` instead and leave its pages.
   - Read only that project's README, `CLAUDE.md`, `AGENTS.md`, `.agents/memory.md`, the newest
     files in its plan folders, its newest `.agents/sessions/` notes, and its deploy settings
     (`vercel.json`, `.vercel/project.json`, `wrangler.toml`, `package.json` scripts), if present.
     In a product with several repositories, read each one's README and agent files.
   - If the map lists saved agent memory for it (Claude Code's own notes, in a `memory/` folder
     next to its sessions), read those notes too. They hold rules, preferences and decisions the
     person's agents were told over time: put rules and preferences in `rules.md` and decisions in
     `decisions.md`. Leave out notes about other projects or about the agent itself.
   - Fill `overview.md` (what, who for, current state), `where.md` (repositories and folders, hosting
     and domains, services, how the parts connect), `rules.md` (the conventions and limits their
     agent files set, linked rather than copied), `plan.md` (only if there is work in progress with a
     clear next step), `decisions.md` and `open-questions.md`. Write only what the sources say;
     leave a page as it is when there is nothing for it. Never copy keys, tokens or passwords: say
     where a secret is kept instead. Anywhere refuses a page that contains one (`contains_secret`).
   - Start each page you fill with `> Imported from <files> on <YYYY-MM-DD>. Check and delete this line.`
6. **One line for the rest.** For each project marked one line: `create_project` with status
   `paused`, its group, repos and a one-line description, and a short `overview.md` saying what it is
   and where its code is. Read nothing else.
7. Finish with what was created, grouped by business, and the page most worth checking first. If
   the `anywr` command is installed, offer `anywr link <slug>` in a project's main folder.

A few projects done well beat every folder imported. The person can run it again later; projects
already in Anywhere are updated, not duplicated.

## Finding the project for a folder

When you start in a code folder that has no `.anywhere/` link and the person has not named a
project, look it up by repository before asking: read the folder's remote with
`git remote get-url origin` and call `list_projects` with it as `repo`. If a project lists that
repository, use it. If none does, ask which project the folder belongs to, then add the repository
to that project with `update_project` (pass its existing repos too).

## Read before you write

1. Find the project: `list_projects`, or read `.anywhere/overview.md` in a linked folder.
2. Read `overview.md` (`get_project` returns it with the page list). It tells you what the project is
   and where things live.
3. Read the page you are about to change, in full, even if you only mean to add a line. You need its
   current text to edit it and its version to write it.
4. Only then write. Never write a page you have not read in this conversation.

## What is worth storing

Store what a different agent would need tomorrow, as a conclusion plus the reason.

Good:
- `decisions.md`: "2026-11-22: Two-tier pricing (Starter, Pro). Three tiers confused the pilot customers."
- `overview.md`: rewrite "Current state" to "Landing page live; checkout in review; launch blocked on the logo."
- `open-questions.md`: "Do we offer annual billing at launch? Needs Sam's answer on refunds."
- `topics/brand-voice.md`: "Plain, warm, no exclamation marks. Never say 'solutions'."
- A preference: "The client wants every change summarized in two sentences, no jargon."

Not worth storing:
- Secrets, passwords, API keys, tokens: never.
- Transcripts or long quotes of the conversation. Write the conclusion.
- Things already in the code or git history (what a function does, what a commit changed).
- Guesses presented as facts, and half-formed thoughts that belong in `ideas.md` at most.
- Anything the person did not want shared: if unsure, ask.

After writing, tell the person which page you changed and what you put there in a line.

## Writing with the MCP tools

- New page: `write_page` without `base_version`. It never overwrites an existing page.
- Changing a page: `write_page` with `base_version` set to the version you read.
- Adding a dated line to `log.md` or a quick note: `append_to_page` (no version needed, cannot conflict).
- `delete_page` needs `base_version`; the standard pages cannot be deleted.

### If a write is refused

A refused write comes back as an error result saying the page changed, with the current version and
the full current content. Do not retry with the same text. Read what is there, merge your change
into it (keep what the other agent added, replace what yours supersedes), and call `write_page`
again with `base_version` set to that current version. Repeat if it changes again.

## Linked projects: the local mirror

A folder is linked when it contains `.anywhere/.link.json`. The pages are ordinary files in
`.anywhere/` (`.anywhere/overview.md`, `.anywhere/topics/pricing.md`). The folder is gitignored:
never commit it and never move it.

The routine:

1. **At the start of the session**, run `anywr pull`. Then read `.anywhere/overview.md`.
2. **Edit pages as files** following the rules above (read first, update in place, keep it short).
3. **After each edit worth sharing**, run `anywr push`, so chat and other agents can see it.
4. `anywr status` shows what differs; add `--json` to any of `status`, `pull`, `push` for
   machine-readable output. All of them exit non-zero while a conflict is open.

Other commands: `anywr login <server-url>` (once per machine; the person pastes a personal access
token from the Anywhere web page), `anywr projects`, `anywr link <project-slug>` in a repo root
(`--create "Name"` makes the project first).

Both the MCP tools and the files reach the same pages, so you may use either in a linked folder. If
you write with the MCP tools, run `anywr pull` afterwards so the file matches.

### If `pull` or `push` reports a conflict

A conflict means the page changed here and on the server. Nothing is lost: the server's copy is
saved beside the page as `<name>.remote.md` (for example `.anywhere/decisions.remote.md`), and your
file is untouched.

1. Open `<name>.remote.md` and `<name>.md`.
2. Merge what matters into `<name>.md`: keep the other side's additions, keep yours, resolve
   contradictions in favour of the more recent and say so with a dated note.
3. Delete `<name>.remote.md`.
4. Run `anywr push`.

`push` skips any page that still has a `.remote.md` beside it, so deleting it is the signal that
the merge is done. Other pages are pushed regardless.

## Without any link

If there is no `.anywhere/` folder, nothing here needs it. Use the MCP tools alone: `guide`, then
`list_projects` and `get_project`, read, write, and tell the person which page you changed.
