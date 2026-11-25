# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| Latest commit on `main` | Yes. Fixes land here. |
| Older commits and forks | No. Update to the latest `main`. |

Updating means pulling the latest source and restarting the server; database migrations run on start.

## Reporting a vulnerability

Report privately through GitHub: open this repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue, pull request or discussion for a security problem.

Include:

- the commit you are running, or that it is the hosted service at anywr.ai,
- a minimal reproduction using **fictional data only**,
- the impact you believe it has.

Do not post tokens, passwords, database URLs, real page content or exploit instructions in public.

## What to expect

- **Acknowledgement within 3 business days.**
- **An initial assessment within 10 business days**, saying whether the report is accepted, how severe it is and what happens next.
- **Updates at least every 14 days** while the report is open.
- Credit in [CHANGELOG.md](CHANGELOG.md) when the fix ships, unless you ask to stay anonymous.

Anywhere is maintained by a very small team. These are commitments about answering you, not about how fast a fix can be engineered.

## Scope

**In scope**

- The server in `packages/server`: the MCP endpoint, the OAuth authorization server, the sync API, the web app and the database migrations.
- Reading, writing or inferring another person's projects or pages.
- Authentication and authorization bypasses: a token acting beyond its account, an OAuth flow that can be redirected or replayed, getting past closed or approval-only sign-up.
- Page content that can run script, load remote resources or make an agent follow instructions as if they came from the person.
- The `anywr` command in `packages/cli` and the skill in `skill/`.
- The hosted service at anywr.ai, app.anywr.ai and mcp.anywr.ai, tested only against your own account.

**Out of scope**

- An installation someone else operates. Report it to that operator.
- Denial of service by volume, and findings that need a compromised device or browser.
- Social engineering of maintainers or users.
- Missing hardening with no demonstrated impact, such as a header on a page that holds no data.

Never test against other people's accounts or data. Stop and report as soon as you see data that is not yours.

The security review this code went through is in [docs/security](docs/security).
