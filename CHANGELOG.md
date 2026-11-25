# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Setting up maps the work a person already has. The skill's new `scripts/map-work.mjs` replaces
  `find-projects.mjs`: it merges every checkout, copy and worktree of a repository, groups
  repositories by owner and product, reads session titles to say what each was about, notes where
  each is hosted, and sets aside temporary folders, test runs, generated sites, other people's
  projects and folders that no longer exist. `choose_projects` now shows that map grouped by
  business, with bring in, one line or skip for each and a box for corrections.
- Projects have a `group` (the business they belong to), a `status` (`active`, `paused` or
  `archived`) and `repos` (their code repositories). `create_project` takes them, the new
  `update_project` tool and `PATCH /api/v1/projects/:slug` change them, and `list_projects` (and
  `GET /projects?repo=`) finds the project for a folder from its git remote. The projects board
  lists projects under their group and tucks archived ones away.
- Two new standard pages: `where.md` (repositories, hosting, services and how the parts connect)
  and `rules.md` (how to work on the project).

## [0.1.0] - Unreleased

The first public release.

### Added

- MCP server over Streamable HTTP with fourteen tools: `guide`, `list_projects`, `create_project`, `get_project`, `resume`, `read_page`, `write_page`, `append_to_page`, `delete_page`, `search`, and `show_projects`, `show_project`, `show_page` and `choose_projects`, which draw Anywhere in the conversation.
- A standard page layout per project (`overview`, `decisions`, `open-questions`, `ideas`, `log` and `topics/`), described once in `docs/layout.md`.
- Versioned writes with conflict detection, the last 20 versions of every page kept, and a record of which app, token or person made each version.
- OAuth 2.1 authorization server with PKCE, dynamic client registration, client ID metadata documents, refresh-token rotation and revocation, and a consent page that warns about unverified apps.
- Web app: projects with recent changes, a page sidebar, editing with conflict handling, history with line diffs and restore, search, topic pages, zip export, connect guides per agent, connected apps, personal access tokens and account settings.
- Sync API and the `anywr` command, which mirrors a project into a git-ignored `.anywhere/` folder.
- The Anywhere skill for Claude Code and Codex.
- Sign-up modes (`open`, `approved`, `closed`), and an optional separate host for the MCP endpoint.
- Docker Compose setup with Postgres, and a demo data seed for local review.
- Local mode (`pnpm local`, or `ANYWHERE_LOCAL=1`): Anywhere for one person on their own computer. It listens on loopback only, refuses requests naming another host (DNS rebinding) or sent from another website, and has no accounts: a one-time link unlocks the browser and agents send a token from an owner-only file in `~/.anywhere`.
- The onboarding walkthrough at `/welcome`, with its own drawings, and the skill as a download at `/skill/anywhere.tar.gz`.
- `plan.md`, a standard page for where the work stands (goal, phases, Now, Next, Blocked), so work survives a change of agent, account or provider. Projects made earlier get it the first time they are opened.
- The `resume` tool: a short briefing to carry on with a project.
- "Set up Anywhere" in the skill, with `scripts/find-projects.mjs`, which lists a person's projects from Claude Code sessions, Codex sessions and git folders without reading any content.
- Local mode has no storage quotas: projects, pages per project, total storage and export size are unlimited unless a limit is set.
- One-click connect in local mode: the start page has a Connect button for Claude Code and for Codex that adds this Anywhere to the agent and installs the skill, in place of the four-step walkthrough of commands.
- Anywhere's interface in the conversation, for apps that support MCP Apps: `show_projects`, `show_project`, `show_page` and `choose_projects` draw the projects board, a project, a page and the set-up checklist in the chat, in the web app's design, and move between them in place. Apps that cannot draw panels get the same content as text.
- `docs/install-for-agents.md` and a "Getting connected" section in the skill, so an agent asked to set up Anywhere can install and connect it without the person running commands.
- Security hardening from a full audit: rate limits, per-account quotas, hashed tokens, content security policy, sanitised rendering and content markers for agents. See `docs/security`.
- A second security review before release: the `anywr` command no longer trusts a server or a link file to name files or to receive `ANYWR_TOKEN`, markdown formatting has a time limit, client registration is limited per address, the local unlock token is single-use, and Docker Compose passes every `.env` setting to the server. See `docs/security/2026-11-25-review.md`.
