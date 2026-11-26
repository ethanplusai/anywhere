# The Anywhere skill

`anywhere/SKILL.md` teaches an agent when to use Anywhere, how a project is laid out, what is worth
storing, how to resolve a conflict, and the `anywr pull` / `anywr push` routine for linked folders.
It works with the MCP tools alone when nothing is linked.

It also carries `scripts/map-work.mjs`, which the "set up Anywhere" flow runs (with the person's
agreement) to draft a map of the work already on their computer. It groups every checkout, copy and
worktree of a repository into one entry, groups repositories by owner and product, and sets aside
temporary folders, test runs, generated output and other people's projects. It reads folder names,
git remotes, each session's working folder, date and title (`--no-titles` leaves titles out), and
the names of a project's docs and deploy files, never file or full conversation content:

```bash
node skill/anywhere/scripts/map-work.mjs
```

## Install

For Claude Code (`~/.claude/skills/anywhere`) and Codex (`~/.codex/skills/anywhere`), from the root of
this repo:

```bash
node skill/install.mjs
```

One of them only: `node skill/install.mjs --claude` or `--codex`. Another folder:
`node skill/install.mjs --dest <skills-dir>`.

By hand, the same thing:

```bash
mkdir -p ~/.claude/skills && cp -R skill/anywhere ~/.claude/skills/
mkdir -p ~/.codex/skills && cp -R skill/anywhere ~/.codex/skills/
```

For one repo only, copy `skill/anywhere` to `<repo>/.claude/skills/` (Claude Code) or
`<repo>/.agents/skills/` (Codex). Start a new session afterwards so the skill is picked up. Check
with the skill list in Claude Code, or ask Codex to list its skills.

Claude chat does not need the skill: the connector's `guide` tool gives the same guidance.

## Changing it

`anywhere/SKILL.md` is generated. Edit `SKILL.template.md` for the prose and `docs/layout.md` for the
layout and rules (the single source, shared with the server), then:

```bash
node skill/build.mjs
```

`node skill/build.mjs --check` fails if the committed file is stale; the CLI package's tests run the
same check, so a layout change without a rebuild fails `pnpm --filter ./packages/cli test`.
