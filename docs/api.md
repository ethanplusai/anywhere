# Sync API (v1)

The contract between the server and the `anywr` CLI. The MCP tools are a second door onto the same
operations; this file covers only the HTTP API. Both sides are built against this file. If it has to
change, change it here first and tell the other side.

Base path: `/api/v1`. JSON in and out, UTF-8. Every request carries
`Authorization: Bearer <personal access token>`.

## Shapes

```ts
type Project = {
  slug: string;          // unique per user, [a-z0-9-], 1-64 chars
  name: string;
  description: string;
  updatedAt: string;     // ISO 8601, latest change to the project or any page
};

type PageMeta = {
  path: string;          // e.g. "overview.md", "topics/pricing.md"
  version: number;       // starts at 1, +1 on every change
  sha256: string;        // hex digest of the UTF-8 content
  size: number;          // bytes
  updatedAt: string;
};

type Page = PageMeta & { content: string };

type ApiError = { error: { code: string; message: string } };
```

Page paths: lowercase `[a-z0-9-]` segments, at most two segments, ending in `.md`.
Maximum page size 256 KiB.

## Endpoints

| Method and path | Body | 200 response | Errors |
|---|---|---|---|
| `GET /me` | | `{ user: { id, email } }` | 401 |
| `GET /projects` | | `{ projects: Project[] }` | 401 |
| `POST /projects` | `{ name, slug?, description? }` | `{ project: Project, pages: PageMeta[] }` (standard pages created) | 409 `slug_taken`, 422 |
| `GET /projects/:slug` | | `{ project: Project, pages: PageMeta[] }` | 404 |
| `GET /projects/:slug/pages/*path` | | `{ page: Page }` | 404 |
| `PUT /projects/:slug/pages/*path` | `{ content, baseVersion }` | `{ page: PageMeta }` | 409 `version_conflict`, 422 |
| `POST /projects/:slug/pages/*path/append` | `{ content }` | `{ page: PageMeta }` | 404, 422 |
| `DELETE /projects/:slug/pages/*path?baseVersion=N` | | `{ deleted: true }` | 409 `version_conflict`, 422 `standard_page` |
| `GET /projects/:slug/export` | | `application/zip` of all pages | 404, 422 `too_large` |
| `DELETE /projects/:slug?confirm=<slug>` | | `{ deleted: true }` | 404, 422 `invalid_body` |

### Writing

`PUT` with `baseVersion: 0` means "create; fail if it exists". Otherwise `baseVersion` must equal
the page's current version. On mismatch the server changes nothing and answers:

```json
{
  "error": { "code": "version_conflict", "message": "..." },
  "current": { "path": "...", "version": 7, "sha256": "...", "size": 123, "updatedAt": "...", "content": "..." }
}
```

`current` is `null` when the page was deleted on the server.

A `PUT` whose content is byte-identical to the current content succeeds without bumping the version.

`append` adds a newline if the page does not end with one, then the content, and bumps the version.
It never conflicts.

## Status codes

`401` missing or bad token. `404` unknown project or page (also used for another user's project).
`409` as above. `422` validation, with `code` one of `invalid_path`, `invalid_slug`, `too_large`,
`standard_page`, `invalid_body`, `quota_exceeded`. `429` rate limited, with `Retry-After`; also sent
after repeated failed authentication from one address, and when a user has too many requests in
flight at once (`Retry-After: 1`).

`422 quota_exceeded`: the account is at a storage limit (projects per user, pages per project, or
total bytes of pages plus kept history). The message says which. Retrying does not help; the user
must delete something. It applies to `POST /projects`, `PUT` and `POST .../append`.

## CLI link file

`.anywhere/.link.json`, written by `anywr link`, owned by the CLI:

```json
{
  "server": "https://example.com",
  "project": "acme-rebrand",
  "pages": { "overview.md": { "version": 3, "sha256": "..." } }
}
```

`pages` records the state last synced. A local file is "changed locally" when its hash differs from
the recorded hash; a page is "changed remotely" when the server version differs from the recorded
version.

## Details settled after review

These are binding for both sides.

### Paths, sizes, bytes

- A page path matches `^[a-z0-9][a-z0-9-]{0,62}(/[a-z0-9][a-z0-9-]{0,62})?\.md$`. So the final
  segment is a name plus `.md`, with no other dots. `overview.remote.md` is therefore not a valid
  page path, which keeps the CLI's conflict files out of sync.
- The standard pages are exactly `overview.md`, `plan.md`, `decisions.md`, `open-questions.md`,
  `ideas.md` and `log.md`. They cannot be deleted. They can be emptied. A project made before a
  standard page existed gets it, from its template, the first time the project is opened.
- `*path` in URLs is the path with `/` left as-is and nothing else needing encoding.
- Content is stored and hashed as the exact UTF-8 bytes sent. Nothing is normalised: no line-ending
  conversion, no trimming, no BOM stripping. The CLI reads and writes files as raw bytes. `size` and
  the 256 KiB limit are in bytes. Request bodies over 1 MiB are refused with 422 `too_large`.
- `GET /projects` is not paginated.

### Versions and deletes

- A page's version never goes backwards and never restarts. Deleting a page keeps a tombstone; a
  page recreated at the same path continues from the tombstone's version plus one. A client holding
  an old version can therefore never match by accident.
- The server keeps the last 20 revisions of each page (configurable), and appends within ten minutes
  share one revision. Deleting a page removes its earlier revisions; a tombstone revision remains.
  v1 has no endpoint or tool that reads revisions.
- A `PUT` with identical bytes changes nothing: no version bump, no `updatedAt` change.
- Writes are serialised in the database (`UPDATE ... WHERE version = $base`, or a row lock). Two
  simultaneous writes on the same base: exactly one wins, the other gets `version_conflict`.
- `DELETE` conflicts use the same 409 body as `PUT`, including `current`.
- `append` on a page that does not exist is 404. It never creates a page.
- `PUT` with `baseVersion: 0` on a path that exists is a `version_conflict` carrying `current`.

### Projects

- `slug` is optional on create. Without it the server derives one from the name (lowercase, runs of
  other characters become `-`, trimmed to 64). If the result is taken, the answer is 409
  `slug_taken`; the server does not invent a suffix.
- `description` defaults to the empty string.
- Standard pages are created with a level-one heading and one line of italic guidance each, taken
  from `docs/layout.md`. They are ordinary pages at version 1.
- The export zip has pages at their paths under a single top-level folder named after the slug, and
  nothing else. A project larger than the export limit (64 MiB by default) answers `422 too_large`.
- Deleting a project deletes all its pages and their history. `confirm` must repeat the slug.

### Tokens and auth

- `/api/v1` accepts personal access tokens only. `/mcp` accepts personal access tokens and OAuth
  access tokens issued for the MCP resource.
- Personal access tokens look like `anywr_` followed by random characters, are stored hashed, have
  a user-given name, no scopes, may have an expiry chosen when created (an expired token is a 401
  like a revoked one), and can be revoked on the web page.
- `anywr login <server-url>` asks the user to paste a token created on the web page and verifies it
  with `GET /me`. There is no device flow in v1.
- A 401 from `/api/v1` uses the `ApiError` body with code `unauthorized`. A 401 from `/mcp` also
  carries the `WWW-Authenticate: Bearer resource_metadata="..."` header the MCP spec requires.
- Rate limiting: the CLI retries once after `Retry-After`, then fails with the server's message.

### CLI sync rules

The link file records, per page, `version` and `sha256` as last synced. Extend each entry with an
optional `mergeBase` number, used only while a conflict is open (below).

Local state of a page: **unchanged** (hash equals record), **changed** (hash differs), **new** (file
exists, no record), **deleted** (record exists, no file). Remote state: **unchanged** (version
equals record), **changed**, **new** (no record), **deleted** (record exists, server has no page).

Files the CLI ignores entirely: `.link.json`, anything ending `.remote.md`, anything that is not a
valid page path.

`anywr pull`, per page:

| Local | Remote | Result |
|---|---|---|
| unchanged | changed | overwrite the file, update the record |
| unchanged | deleted | delete the file and the record |
| any | unchanged | leave alone (push deals with it) |
| none | new | write the file, add the record |
| changed or new | changed or new, same bytes | update the record, write nothing |
| changed or new | changed or new, different bytes | **conflict**: write the server copy to `<name>.remote.md`, set `mergeBase` to the server version, leave the file and the recorded hash alone |
| changed | deleted | keep the file, drop the record, report it; the next push recreates the page |
| deleted | changed | restore the server copy, update the record, report it |
| deleted | deleted | drop the record |

`anywr push`, per page:

- A page with a `<name>.remote.md` beside it is skipped and reported as an open conflict.
- **changed**: `PUT` with `baseVersion` = `mergeBase` if set, else the recorded version. On success
  update the record and clear `mergeBase`.
- **new**: `PUT` with `baseVersion: 0`.
- **deleted**: `DELETE` with the recorded version. A standard page is not deleted: it is restored
  from the server with a warning.
- A 409 with `current` set is handled exactly like the pull conflict row. For a deleted local file
  it restores the server copy instead.
- A 409 with `current: null` (deleted on the server): keep the file, drop the record, report it. The
  next push creates it again.
- Push runs every page it can and ends with a non-zero exit code if any conflict is open.

The merge routine the skill teaches: open `<name>.remote.md`, merge what matters into `<name>.md`,
delete the `.remote.md`, run `anywr push`.

`log.md` gets no special treatment in the CLI.

## MCP tool behaviour that mirrors this API

- `write_page` without `base_version` means create (the same as `baseVersion: 0`). Used on a page
  that exists, it returns a conflict; it never overwrites.
- A conflict is a tool result with `isError: true` whose text states plainly that the page changed,
  gives the current version and full current content, and says: merge your change into this content
  and call `write_page` again with `base_version` set to that version.
- `create_project` takes `name`, optional `slug`, optional `description`, and surfaces `slug_taken`.
- `get_project`, `read_page` and the write tools take a project slug. Agents resolve a name with
  `list_projects`.
- `get_project` computes each page's first non-empty line itself; that field is not in `PageMeta`.
- Page content in tool results is wrapped in `----- BEGIN PAGE CONTENT <id> (...) -----` and
  `----- END PAGE CONTENT <id> -----` markers. Clients must not rely on content starting at a fixed
  offset in the text.
- `/mcp` refuses JSON-RPC batches (array bodies) with 400 and error code -32600.
- `search` queries are at most 256 characters. `search` uses `websearch_to_tsquery('english', ...)` over current page content only, returns at
  most 20 results ranked by `ts_rank`, each with project slug, page path, version and a
  `ts_headline` snippet. It takes an optional project slug.
