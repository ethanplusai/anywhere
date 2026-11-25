## What this changes

<!-- The problem, and the resulting behaviour. One concern per pull request. -->

## Why

<!-- What made the current behaviour wrong or insufficient. Link the issue if there is one. -->

## How it was validated

<!-- Paste the commands you ran and their results. -->

```
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

## Checklist

- [ ] One concern, and the diff is as small as that concern allows.
- [ ] Tests added or updated, including a test that would have caught the bug.
- [ ] Tests, lint, typecheck and build all pass.
- [ ] Fixtures use fictional people and `.example` or `.test` domains.
- [ ] No secrets, `.env` files, database dumps or real page content are committed.

### If this touches the database

- [ ] A new migration with the next number; no shipped migration was edited or renumbered.

### If this touches the page layout or the contract

- [ ] `docs/layout.md` or `docs/api.md` changed in the same pull request, and `node skill/build.mjs` was run.

### If this touches what agents receive or what pages render

- [ ] A test tries the attack: script in page content, a remote image, or instructions written into a page.
