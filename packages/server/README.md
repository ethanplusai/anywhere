# Anywhere server

One HTTP service that gives every agent you use the same markdown pages per project:

- `/mcp`: the MCP endpoint (Streamable HTTP, stateless) for Claude, Claude Code, ChatGPT and other clients
- `/api/v1`: the sync API used by the `anywr` command (contract: [`docs/api.md`](../../docs/api.md))
- its own OAuth 2.1 authorization server for MCP clients
- the web app: sign up and sign in, OAuth consent, projects, page editing with history and diffs, search, connect guides, connected apps, tokens, account settings and zip export

The page layout and the rules agents follow come from [`docs/layout.md`](../../docs/layout.md), read at startup.

## Run it

### Docker (server + Postgres)

From the repository root:

```bash
cp .env.example .env
```

Edit `BASE_URL` and `POSTGRES_PASSWORD` in `.env`, then:

```bash
docker compose up -d
```

Open `BASE_URL`, create your account, then set `ANYWHERE_SIGNUPS=closed` (or `approved`) and restart if nobody else should sign up.

For anything other than localhost put a TLS proxy (Caddy, nginx, a platform load balancer) in front. Claude's connectors require `https` on port 443, and the MCP URL people paste must be exactly `BASE_URL/mcp`. Pick the address once; changing it later means reconnecting every agent.

### Without Docker

Node 22 and pnpm:

```bash
pnpm install
```

```bash
pnpm --filter ./packages/server build
```

```bash
BASE_URL=http://localhost:3000 node packages/server/dist/main.js
```

With no `DATABASE_URL` the server uses an embedded Postgres (PGlite) stored in `./data`, which is fine for one person on one machine. Set `DATABASE_URL` to use a real Postgres 14 or newer. Migrations run automatically at startup.

## Configuration

Every limit has a safe default; set a variable only to change it. Invalid values stop the server at startup.

| Variable | Default | Meaning |
|---|---|---|
| `BASE_URL` | `http://localhost:$PORT` | Public origin, no trailing slash. OAuth metadata and the MCP URL are built from it. With `NODE_ENV=production` it must be `https` (loopback hosts excepted). |
| `PORT` | `3000` | Listening port. |
| `DATABASE_URL` | unset | Postgres connection string. Unset means embedded PGlite, which `main.js` refuses in production unless `ANYWHERE_ALLOW_EMBEDDED_DB=1`. |
| `ANYWHERE_ALLOW_EMBEDDED_DB` | `0` | `1` allows the embedded database with `NODE_ENV=production`. |
| `ANYWHERE_PGLITE_DIR` | `./data` | Where the embedded database lives. |
| `ANYWHERE_DB_POOL_MAX` | `10` | Postgres connections per process. Keep it small on serverless. |
| `ANYWHERE_DB_STATEMENT_TIMEOUT_MS` | `15000` | Statements running longer are cancelled. |
| `ANYWHERE_DB_IDLE_TX_TIMEOUT_MS` | `10000` | Transactions idle this long are ended by Postgres. |
| `ANYWHERE_LOCAL` | `0` | `1` runs local mode: one person on their own computer, loopback only, no accounts (see `src/local.ts`). `pnpm local` sets it. In local mode the quotas below (projects, pages per project, storage and export size) have no limit unless you set one. |
| `ANYWHERE_HOME` | `~/.anywhere` | Local mode's folder for its database and token files. |
| `ANYWHERE_HOST` | `0.0.0.0` (`127.0.0.1` in local mode) | Address to listen on. Local mode accepts loopback addresses only. |
| `ANYWHERE_SIGNUPS` | `open` | `open`: anyone can create an account. `approved`: only emails on the early-access list (approve one with `node packages/server/scripts/approve-email.mjs you@example.com`). `closed`: nobody. |
| `ANYWHERE_DISABLE_SIGNUPS` | `0` | Older spelling of `ANYWHERE_SIGNUPS=closed`. |
| `ANYWHERE_EARLY_ACCESS_URL` | empty | Where people request access while sign-ups are `approved`. |
| `ANYWHERE_MCP_ORIGIN` | `BASE_URL` | Give agents a host of their own, e.g. `https://mcp.example.com`. The MCP endpoint is then only served there, at `/mcp`, and other paths on that host redirect to `BASE_URL`. |
| `ANYWHERE_SITE_URL` | `https://anywr.ai` | The website the app's footer links to for docs, security, privacy and terms. |
| **Email and sign-in** | | |
| `RESEND_API_KEY` | unset | Send email through Resend. Use a key restricted to sending from your mail domain. |
| `ANYWHERE_SMTP_URL` | unset | Or send through any SMTP server, e.g. `smtps://user:pass@smtp.example.com:465`. Set one of the two; with `NODE_ENV=production` the server refuses to start with neither. In development, emails are printed to the console. |
| `ANYWHERE_MAIL_FROM` | none | The sender, e.g. `Anywhere <hello@mail.example.com>`. Send from a subdomain with SPF, DKIM and DMARC set up. |
| `ANYWHERE_MAIL_REPLY_TO` | unset | Where replies go. |
| `ANYWHERE_SUPPORT_EMAIL` | unset | The help address shown in emails and on the security page. |
| `ANYWHERE_MAIL_ALLOWLIST` | unset | Comma-separated addresses or `@domains`. When set, mail to anyone else is dropped with a log line. Set it on staging and previews. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | unset | Offer sign-in with GitHub through your own GitHub OAuth app. Its callback URL is `BASE_URL/auth/github/callback`. |
| `ANYWHERE_PRODUCT_NAME` | `Anywhere` | The name used in emails and passkey prompts. |
| **Addresses** | | |
| `ANYWHERE_CLIENT_IP_HEADER` | unset | A header your platform sets to the client address and clients cannot forge, e.g. `x-real-ip` (Vercel, nginx), `cf-connecting-ip` (Cloudflare), `fly-client-ip`. Wins over `ANYWHERE_TRUST_PROXY`. |
| `ANYWHERE_TRUST_PROXY` | `0` | Number of proxies you control that append to `X-Forwarded-For` (`1`/`true` = one). Rate limits use the entry that many places from the right; entries further left are whatever the client sent. |
| **Rate limits** (counted in Postgres, shared by every instance) | | |
| `ANYWHERE_API_RATE_LIMIT` | `600` | Requests per minute per user on `/api/v1` and `/mcp`. |
| `ANYWHERE_MAX_CONCURRENT_PER_USER` | `8` | Concurrent `/api/v1` and `/mcp` requests per user in one process. |
| `ANYWHERE_AUTH_RATE_LIMIT` | `20` | Per minute per address: sign-in and sign-up, client registration, token creation, client metadata lookups. |
| `ANYWHERE_SIGNIN_EMAIL_LIMIT` | `5` | Sign-in and confirmation codes sent to one address per hour. |
| `ANYWHERE_UNAUTH_RATE_LIMIT` | `30` | Failed bearer authentications per minute per address on `/api/v1` and `/mcp`; then `429`. |
| `ANYWHERE_WEB_RATE_LIMIT` | `300` | Web page requests per minute per signed-in user, or per address when signed out. |
| `ANYWHERE_REGISTRATIONS_PER_HOUR` | `200` | Dynamic client registrations per hour, server-wide. |
| `ANYWHERE_REGISTRATIONS_PER_ADDRESS_PER_HOUR` | `20` | Dynamic client registration attempts per hour from one address. |
| `ANYWHERE_CIMD_FETCH_LIMIT` | `60` | Client ID Metadata Document fetches per minute, server-wide. |
| **Storage quotas** (checked inside each write) | | |
| `ANYWHERE_MAX_PROJECTS` | `50` | Projects per user. |
| `ANYWHERE_MAX_PAGES_PER_PROJECT` | `500` | Live pages per project. |
| `ANYWHERE_MAX_BYTES_PER_USER` | `52428800` (50 MiB) | Current page content plus kept revisions, per user. |
| `ANYWHERE_REVISIONS_KEPT` | `20` | Revisions kept per page, the current version included. |
| `ANYWHERE_APPEND_COALESCE_SECONDS` | `600` | Appends to one page within this window share one revision. `0` turns it off. |
| `ANYWHERE_MAX_SEARCH_QUERY` | `256` | Characters in a search query. |
| `ANYWHERE_MAX_EXPORT_BYTES` | `67108864` (64 MiB) | Largest project a zip export will stream. |
| **Sessions and grants** | | |
| `ANYWHERE_GRANT_LIFETIME_DAYS` | `90` | A connected app must be approved again after this long, however often it refreshes. |
| `ANYWHERE_SESSION_IDLE_DAYS` | `14` | A web session ends after this long unused (and always 30 days after sign-in). |
| `ANYWHERE_VERIFIED_REDIRECTS` | unset | Extra `host=Name` or `scheme:=Name` pairs, comma-separated, that the consent page names as verified. Built in: claude.ai, claude.com, chatgpt.com, chat.openai.com, `cursor:`, `vscode:`. |
| `ANYWHERE_LAYOUT_PATH` | `docs/layout.md` | Override the layout file. |
| `ANYWHERE_ALLOW_PRIVATE_CIMD` | `0` | Allow OAuth client metadata documents on private addresses. Tests only. |

Quota errors are `422` with code `quota_exceeded`. Without a configured address source the server logs one warning and every client shares one address bucket; per-account and per-user limits still apply.

### Running hosted (serverless)

Nothing depends on process memory between requests: rate limits, quotas, sessions, grants and the metadata-fetch failure cache live in Postgres. The concurrency caps are per process on purpose, because they bound that process's memory. Call `purgeExpired(db)` (exported from the package) on a schedule, for example a daily cron; it deletes expired sessions, codes, tokens, grants, rate-limit windows and registered clients that never connected. Requests also run it now and then.

Backups: deleting a page, a project or an account removes the rows at once, but copies stay in database backups for as long as your provider keeps them. Say so in your privacy policy, and keep backup retention short.

## Connecting agents

The signed-in web page `/connect` has the steps for each client. In short, every client uses `BASE_URL/mcp`:

- **Claude** (web, desktop, mobile): Settings → Connectors → Add custom connector.
- **Claude Code**: `claude mcp add --transport http anywhere BASE_URL/mcp`, then `/mcp` → Authenticate.
- **ChatGPT**: Developer mode, then create a connector with OAuth.
- **`anywr` and header-only clients**: a personal access token from `/tokens`, sent as `Authorization: Bearer anywr_…`.

## How sign-in works

- There are no passwords. People sign in three ways:
  - **Email code.** A six-digit code and a one-time link, sent together, valid for 10 minutes and stored as hashes. The code works only in the browser that asked for it (tied to an HttpOnly browser-id cookie), and five wrong guesses end it. The link works once on any device; opening it shows a button rather than signing in, so mail scanners cannot use it up. Signing in and signing up are one form: an address with no account gets one when its code is entered, if `ANYWHERE_SIGNUPS` allows it. The page answers the same whatever the address; only the email differs.
  - **GitHub**, through the server's own GitHub OAuth app, with `state` and PKCE. Only a verified primary email is used. GitHub's token is used once and never stored. An existing account with that email gets GitHub linked, and its owner is emailed.
  - **Passkeys** (WebAuthn), with user verification required. Challenges are stored server-side, tied to the browser and used once.
- Sessions are HttpOnly, SameSite=Lax cookies named with the `__Host-` prefix on https; every signed-in form carries a CSRF token, and sign-in posts need a matching `Origin` (or `Sec-Fetch-Site: same-origin`). Signing in ends any session already in that browser.
- Deleting a project or the account, changing the email, adding or removing a passkey, linking or unlinking GitHub and downloading everything need the person to have confirmed it is them in the last 10 minutes, with a passkey or an emailed code.
- `/account/security` lists the ways to sign in, passkeys, every signed-in browser (each can be signed out) and recent account activity. New sign-ins with GitHub, new tokens, connected apps, passkey and GitHub changes and email changes are emailed to the owner, with the browser and network they came from (an address with its last part hidden). An email change is sent to the old address.
- `/account` lists usage, signs out everywhere and deletes the account; `/account/apps` lists connected apps (each can be disconnected); `/account/export.zip` downloads every project. Personal access tokens can be given an expiry.
- MCP clients use OAuth: protected-resource metadata (RFC 9728) at `/.well-known/oauth-protected-resource/mcp`, authorization-server metadata (RFC 8414) at `/.well-known/oauth-authorization-server`, dynamic client registration (RFC 7591) at `/oauth/register`, Client ID Metadata Documents (an `https` URL as `client_id`), PKCE S256 only, loopback redirects matched ignoring the port, form-encoded `/oauth/token` with refresh-token rotation (reusing a spent refresh token revokes the whole grant).
- Access tokens last an hour, refresh tokens 30 days, and neither outlives its grant (90 days). RFC 7009 revocation at `/oauth/revoke`. All tokens are opaque and stored as SHA-256 hashes.
- The consent page names a client only when its redirect host is on the verified list; otherwise it leads with "An unverified app at <redirect>".
- An unauthenticated `/mcp` request gets `401` with `WWW-Authenticate: Bearer resource_metadata="BASE_URL/.well-known/oauth-protected-resource/mcp"`.

## Develop

```bash
pnpm --filter ./packages/server test
```

```bash
pnpm --filter ./packages/server typecheck
```

```bash
pnpm --filter ./packages/server lint
```

Tests run against PGlite in-process: no database server and no Docker. They cover the sync API, the MCP tools through the SDK's real client, and the OAuth flow end to end.

### Layout

```
src/
  app.ts            builds the Hono app from its parts
  main.ts           entrypoint: config, database, migrations, listen
  service/          every project and page rule (the API, MCP and web pages all call this)
  api/              /api/v1
  mcp/              /mcp: tools, instructions
  oauth/            authorization server: metadata, registration, CIMD, authorize, token
  auth/             email codes, GitHub, passkeys, sessions, account events, personal access tokens, bearer resolution, rate limits
  mail/             sending (Resend, SMTP, console) and the email templates
  web/              server-rendered pages (signin.ts, security.ts, account.ts) and markdown rendering
  export/           streamed zip export
  db/               pg and PGlite drivers, migration runner, purgeExpired
migrations/         SQL, applied in name order
```

Page content is stored as raw bytes (`bytea`) so it round-trips exactly; versions never restart because a deleted page keeps a tombstone row; every page write locks its project row, so concurrent writes on the same base version produce exactly one winner and `version_conflict` for the rest.

## Try the web app with demo data

```bash
pnpm --filter ./packages/server build
node packages/server/scripts/demo.mjs
ANYWHERE_PGLITE_DIR=packages/server/.demo ANYWHERE_ALLOW_EMBEDDED_DB=1 PORT=3341 node packages/server/dist/main.js
```

Open http://localhost:3341 and sign in with the details in `packages/server/.demo/credentials.txt`.
