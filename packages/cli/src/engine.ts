import { Api, ApiError, type Page } from "./api.js";
import { CliError } from "./errors.js";
import { listConflictFiles, listLocalPages, readBytes, remoteFileName, removeFile, sha256, writeBytes } from "./files.js";
import { DIR, type LinkFile } from "./link.js";
import {
  decidePull,
  decidePush,
  decideRemoteDiff,
  isPagePath,
  localState,
  remoteState,
  type LocalState,
  type PullAction,
  type RemoteDiffAction,
  type RemoteMeta,
  type RemoteState,
} from "./sync.js";

export type Change = { path: string; action: string; detail?: string };
export type OpenConflict = { path: string; remoteFile: string };
export type SyncResult = {
  changes: Change[];
  conflicts: OpenConflict[];
  warnings: string[];
  errors: { path: string; message: string }[];
};

export type Ctx = { dir: string; link: LinkFile; api: Api };

const emptyResult = (): SyncResult => ({ changes: [], conflicts: [], warnings: [], errors: [] });
const MAX_PAGE_BYTES = 256 * 1024;

type Action = PullAction | RemoteDiffAction;

async function apply(
  ctx: Ctx,
  res: SyncResult,
  path: string,
  a: Action,
  local: string | null,
  meta: RemoteMeta | null,
  getPage: () => Promise<Page>,
): Promise<void> {
  const { dir, link } = ctx;
  const stale = () => removeFile(dir, remoteFileName(path));
  const change = (action: string, detail?: string) =>
    res.changes.push(detail === undefined ? { path, action } : { path, action, detail });

  switch (a.kind) {
    case "none":
      return;
    case "overwrite":
    case "write":
    case "restore": {
      const page = await getPage();
      const bytes = Buffer.from(page.content, "utf8");
      await writeBytes(dir, path, bytes);
      link.pages[path] = { version: page.version, sha256: sha256(bytes) };
      await stale();
      if (a.kind === "overwrite") change("updated");
      else if (a.kind === "write") change("added");
      else change("restored", "it was deleted locally but changed on the server");
      return;
    }
    case "delete-local":
      await removeFile(dir, path);
      delete link.pages[path];
      await stale();
      change("deleted", "deleted on the server");
      return;
    case "record-only":
      if (!meta || local === null) return;
      link.pages[path] = { version: meta.version, sha256: local };
      await stale();
      change("in-sync", "same content on both sides");
      return;
    case "conflict": {
      const page = await getPage();
      await writeBytes(dir, remoteFileName(path), Buffer.from(page.content, "utf8"));
      const prev = link.pages[path] ?? { version: 0, sha256: "" };
      link.pages[path] = { version: prev.version, sha256: prev.sha256, mergeBase: page.version };
      change("conflict", `server copy written to ${DIR}/${remoteFileName(path)}`);
      return;
    }
    case "keep-drop-record":
      delete link.pages[path];
      change("kept-local", "deleted on the server; the next push recreates it");
      return;
    case "drop-record":
      delete link.pages[path];
      await stale();
      change("removed", "deleted on both sides");
      return;
  }
}

const asMeta = (p: Page | null | undefined): RemoteMeta | null => (p ? { version: p.version, sha256: p.sha256 } : null);

function rethrowAuth(e: unknown, server: string): void {
  if (e instanceof ApiError && e.status === 401) {
    throw new CliError(`The server rejected the token. Run: anywr login ${server}`);
  }
}

async function finish(ctx: Ctx, res: SyncResult): Promise<SyncResult> {
  const open = await listConflictFiles(ctx.dir);
  res.conflicts = open.map((path) => ({ path, remoteFile: `${DIR}/${remoteFileName(path)}` }));
  res.changes.sort((a, b) => a.path.localeCompare(b.path));
  return res;
}

/**
 * The server's pages, less any whose path is not a page path. The server is not trusted to name
 * files on this computer: a path such as "../../CLAUDE.md" is reported and never written.
 */
function pagesOf<T extends { path: string }>(pages: readonly T[], warnings: string[]): T[] {
  return pages.filter((p) => {
    if (isPagePath(p.path)) return true;
    warnings.push(`The server listed a page with the path ${JSON.stringify(String(p.path).slice(0, 120))}, which is not a page path; ignored it.`);
    return false;
  });
}

export async function pull(ctx: Ctx): Promise<SyncResult> {
  const res = emptyResult();
  let remote;
  try {
    remote = await ctx.api.getProject(ctx.link.project);
  } catch (e) {
    rethrowAuth(e, ctx.api.server);
    if (e instanceof ApiError && e.status === 404) {
      throw new CliError(`Project "${ctx.link.project}" was not found on ${ctx.api.server}.`);
    }
    throw e;
  }
  const remoteMap = new Map(pagesOf(remote.pages, res.warnings).map((p) => [p.path, p]));
  const local = await listLocalPages(ctx.dir);
  const paths = [...new Set([...local.keys(), ...Object.keys(ctx.link.pages), ...remoteMap.keys()])].sort();
  for (const path of paths) {
    const meta = remoteMap.get(path) ?? null;
    const l = local.get(path) ?? null;
    try {
      const a = decidePull({ local: l, record: ctx.link.pages[path] ?? null, remote: meta });
      await apply(ctx, res, path, a, l, meta, () => ctx.api.getPage(ctx.link.project, path));
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      rethrowAuth(e, ctx.api.server);
      res.errors.push({ path, message: `${e.code}: ${e.message}` });
    }
  }
  return finish(ctx, res);
}

export async function push(ctx: Ctx): Promise<SyncResult> {
  const res = emptyResult();
  const { link, api, dir } = ctx;
  const local = await listLocalPages(dir);
  const conflictFiles = new Set(await listConflictFiles(dir));
  const paths = [...new Set([...local.keys(), ...Object.keys(link.pages)])].sort();
  const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

  for (const path of paths) {
    const l = local.get(path) ?? null;
    const record = link.pages[path] ?? null;
    const a = decidePush({ local: l, record, hasRemoteFile: conflictFiles.has(path), path });
    try {
      switch (a.kind) {
        case "none":
          break;
        case "skip-conflict":
          res.changes.push({ path, action: "skipped", detail: "open conflict; merge it first" });
          break;
        case "put": {
          const bytes = await readBytes(dir, path);
          let content: string;
          try {
            content = utf8.decode(bytes);
          } catch {
            res.errors.push({ path, message: "the file is not valid UTF-8, so it was not sent" });
            break;
          }
          if (bytes.length > MAX_PAGE_BYTES) {
            res.errors.push({ path, message: `the file is ${bytes.length} bytes; pages are limited to ${MAX_PAGE_BYTES}` });
            break;
          }
          try {
            const page = await api.putPage(link.project, path, content, a.baseVersion);
            link.pages[path] = { version: page.version, sha256: sha256(bytes) };
            res.changes.push({ path, action: a.baseVersion === 0 ? "created" : "pushed" });
          } catch (e) {
            await handle409(ctx, res, path, e, l);
          }
          break;
        }
        case "delete":
          try {
            await api.deletePage(link.project, path, a.baseVersion);
            delete link.pages[path];
            res.changes.push({ path, action: "deleted", detail: "deleted on the server" });
          } catch (e) {
            await handle409(ctx, res, path, e, null);
          }
          break;
        case "restore-standard":
          res.warnings.push(`${path} is a standard page and cannot be deleted; restored it from the server.`);
          try {
            const page = await api.getPage(link.project, path);
            await apply(ctx, res, path, { kind: "restore" }, null, asMeta(page), async () => page);
          } catch (e) {
            if (e instanceof ApiError && e.status === 404) delete link.pages[path];
            else throw e;
          }
          break;
      }
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      rethrowAuth(e, api.server);
      res.errors.push({ path, message: `${e.code}: ${e.message}` });
    }
  }
  return finish(ctx, res);
}

async function handle409(ctx: Ctx, res: SyncResult, path: string, e: unknown, l: string | null): Promise<void> {
  if (!(e instanceof ApiError) || e.status !== 409 || e.current === undefined) throw e;
  const current = e.current;
  const a = decideRemoteDiff({ local: l, current: asMeta(current) });
  await apply(ctx, res, path, a, l, asMeta(current), async () => current as Page);
}

export type PageStatus = {
  path: string;
  local: LocalState;
  /** "unknown" when the server could not be reached. */
  remote: RemoteState | "unknown";
  conflict: boolean;
};

export async function status(ctx: Ctx): Promise<{ pages: PageStatus[]; warning?: string }> {
  const local = await listLocalPages(ctx.dir);
  const conflicts = new Set(await listConflictFiles(ctx.dir));
  let remoteMap: Map<string, RemoteMeta> | null = null;
  let warning: string | undefined;
  try {
    remoteMap = new Map(pagesOf((await ctx.api.getProject(ctx.link.project)).pages, []).map((p) => [p.path, p]));
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) rethrowAuth(e, ctx.api.server);
    warning = `Could not reach the server (${(e as Error).message}); showing local state only.`;
  }
  const paths = [
    ...new Set([...local.keys(), ...Object.keys(ctx.link.pages), ...(remoteMap ? remoteMap.keys() : []), ...conflicts]),
  ].sort();
  const pages = paths.map((path): PageStatus => {
    const rec = ctx.link.pages[path] ?? null;
    return {
      path,
      local: localState(local.get(path) ?? null, rec),
      remote: remoteMap ? remoteState(remoteMap.get(path) ?? null, rec) : "unknown",
      conflict: conflicts.has(path),
    };
  });
  return { pages, ...(warning ? { warning } : {}) };
}
