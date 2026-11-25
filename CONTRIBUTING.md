# Contributing to Anywhere

Thank you for wanting to help. Please read this page before opening a pull request; it will save you a round trip.

## What Anywhere is for

Anywhere is a shared memory for the agents a person uses: a few markdown pages per project that every agent reads and writes over MCP. Changes that make that simpler, safer or work with more agents are welcome. Changes that make the pages harder for a person to read, or that send people's notes anywhere they did not choose, are not.

For anything bigger than a fix, open an issue first so we can agree on the shape before you build it.

## Setting up locally

You need Node.js 22 (see `.nvmrc`) and pnpm 10.

```sh
git clone https://github.com/ethanplusai/anywhere.git
cd anywhere
pnpm install
pnpm build
```

To click through the web app with sample data, see "Try it locally with demo data" in the [README](README.md). Tests and the demo use an embedded Postgres (PGlite); never point them at a database that holds real data.

## Where things live

- `docs/layout.md` is the single description of how a project is organised. The server's `guide` tool, its tool descriptions and the skill are generated or loaded from it. Change it there, then run `node skill/build.mjs`.
- `docs/api.md` is the contract between the server and the `anywr` command. Change the contract and both sides in the same pull request.
- Database changes are a new numbered file in `packages/server/migrations`. Never edit or renumber one that has shipped.

## Branches, commits and pull requests

- Branch from `main` and name the branch for the change, for example `fix-append-coalescing`.
- One concern per pull request. A refactor bundled with a behaviour change is hard to review and harder to revert.
- Write commit subjects in the imperative mood, under about 72 characters, describing what the change does: `Keep the person's text when a save conflicts`, not `fixed stuff`.
- A pull request description says what the problem was, what the behaviour is now, and how you checked it. Paste the commands you ran.

## Checks to run

From the repository root:

```sh
pnpm test        # server and CLI tests
pnpm lint
pnpm typecheck
pnpm build
node skill/build.mjs && git diff --exit-code skill/anywhere   # the generated skill is current
node packages/server/scripts/embed-skill.mjs && git diff --exit-code packages/server/src/web/skill.generated.ts
node packages/server/scripts/embed-fonts.mjs && git diff --exit-code packages/server/src/web/fonts.generated.ts
```

Add tests with the change: a bug fix comes with the test that would have caught it. Security-relevant code (authentication, OAuth, anything that renders page content, anything that returns content to an agent) needs a test that tries the attack.

## Writing

Interface text, docs and tool descriptions are plain and direct. Say what something does in the words a person would use. Use fictional people and `.example` or `.test` domains in tests and fixtures, never a real person, company or address.

## Conduct

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Licence

By contributing you agree that your contribution is licensed under the [MIT licence](LICENSE).
