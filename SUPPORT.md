# Support

## Where to ask

| You want to | Go to |
| --- | --- |
| Ask a question about running Anywhere | **GitHub Issues** on this repository; start the title with "Question:" |
| Report a reproducible bug | **GitHub Issues**, using the bug report form |
| Suggest a feature | **GitHub Issues**, using the feature request form |
| Report a vulnerability | Privately, through the **Security** tab. See [SECURITY.md](SECURITY.md) |

## Before you ask

Most setup questions are answered by [README.md](README.md), [packages/server/README.md](packages/server/README.md) and the [docs at anywr.ai](https://anywr.ai/docs).

When you ask, include:

- how you run Anywhere (the hosted service, Docker, or Node.js directly, and on which host),
- the commit you are on,
- the agent you connected (Claude, ChatGPT, Claude Code, Codex or another) and its version,
- the exact steps and what happened, with tokens and passwords removed.

Never paste a token, a password, a database URL with its password, or real page content. Reproduce with fictional data.

## What maintainers help with

- Bugs in this source: the server, the MCP tools, OAuth, the web app, the CLI and the skill.
- Documentation that is wrong, missing or misleading.
- Questions about the intended behaviour of a tool or the sync API.

## What is yours to run

On a server you run yourself, the maintainers cannot see your installation:

- **Infrastructure:** Postgres, containers, the TLS proxy, DNS and backups.
- **Your data:** retention, restores and recovering from a deletion.
- **Your agents' accounts:** Claude, ChatGPT and other clients have their own settings and plans.
- **Your modifications:** a fork is supported by whoever made it.

Support is best effort from a very small team, with no service level agreement.
