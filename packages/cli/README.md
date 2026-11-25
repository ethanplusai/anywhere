# anywr

The command line tool for [Anywhere](../../README.md). It mirrors one project's pages into a git-ignored `.anywhere/` folder in your repository and keeps it in sync with the server, so coding agents can read and edit the pages as plain files.

## Install

From the root of this repository:

```sh
pnpm install
pnpm --filter anywr build
npm install -g ./packages/cli
```

## Use

```sh
anywr login https://app.anywr.ai    # paste a personal access token from Settings, Tokens
anywr projects                       # list your projects
anywr link acme-rebrand              # create .anywhere/, ignore it in git, and pull
anywr pull                           # fetch what other agents changed
anywr push                           # send your edits
anywr status                         # what changed on each side
```

If a page changed on both sides, your copy stays and the server's copy is written next to it as `<page>.remote.md`. Merge the two, delete the `.remote.md` file and push again.

`status`, `pull`, `push` and `projects` take `--json` for scripts. A conflict makes them exit with code 1. The token is stored with mode 0600. `ANYWR_TOKEN` is used instead only for the server you name with `--server` or `ANYWR_SERVER`, never for a server named by a linked folder alone, because a link file can arrive with a cloned repository. Servers must use `https://` unless they are on this computer. The HTTP contract with the server is [docs/api.md](../../docs/api.md).
