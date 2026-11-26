// Pure sync decisions. No I/O. Implements "CLI sync rules" in docs/api.md.

export type RecordEntry = { version: number; sha256: string; mergeBase?: number };
export type RemoteMeta = { version: number; sha256: string };

const PAGE_PATH = /^[a-z0-9][a-z0-9-]{0,62}(\/[a-z0-9][a-z0-9-]{0,62})?\.md$/;
const STANDARD = new Set(["overview.md", "plan.md", "where.md", "rules.md", "decisions.md", "open-questions.md", "ideas.md", "log.md"]);

export const isPagePath = (p: string): boolean => PAGE_PATH.test(p);
export const isStandardPage = (p: string): boolean => STANDARD.has(p);

/** Local hash (sha256 hex) or null when the file does not exist. */
export type LocalHash = string | null;

export type LocalState = "unchanged" | "changed" | "new" | "deleted" | "none";
export type RemoteState = "unchanged" | "changed" | "new" | "deleted" | "none";

export function localState(local: LocalHash, record: RecordEntry | null): LocalState {
  if (local === null) return record ? "deleted" : "none";
  if (!record) return "new";
  return record.sha256 === local ? "unchanged" : "changed";
}

/**
 * While a conflict is open the record carries `mergeBase`: the server version the conflict file was
 * taken from. A server still at that version has not changed since, so it counts as unchanged.
 */
export function remoteState(remote: RemoteMeta | null, record: RecordEntry | null): RemoteState {
  if (!record) return remote ? "new" : "none";
  if (!remote) return "deleted";
  if (remote.version === record.version || remote.version === record.mergeBase) return "unchanged";
  return "changed";
}

export type PullAction =
  | { kind: "none" }
  | { kind: "overwrite" }
  | { kind: "write" }
  | { kind: "restore" }
  | { kind: "delete-local" }
  | { kind: "record-only" }
  | { kind: "conflict"; mergeBase: number }
  | { kind: "keep-drop-record" }
  | { kind: "drop-record" };

export function decidePull(i: { local: LocalHash; record: RecordEntry | null; remote: RemoteMeta | null }): PullAction {
  const l = localState(i.local, i.record);
  const r = remoteState(i.remote, i.record);
  const remote = i.remote;

  if (r === "none" || r === "unchanged") {
    // A merged file that already equals the server copy: settle the record so push has nothing to do.
    if (r === "unchanged" && i.record?.mergeBase !== undefined && remote && i.local === remote.sha256) {
      return { kind: "record-only" };
    }
    return { kind: "none" };
  }
  if (r === "deleted") {
    if (l === "unchanged") return { kind: "delete-local" };
    if (l === "changed") return { kind: "keep-drop-record" };
    return { kind: "drop-record" }; // local deleted
  }
  // remote is new or changed, so `remote` is non-null
  if (!remote) return { kind: "none" };
  if (l === "none") return { kind: "write" };
  if (l === "deleted") return { kind: "restore" };
  if (l === "unchanged") return { kind: "overwrite" };
  // local changed or new
  return i.local === remote.sha256 ? { kind: "record-only" } : { kind: "conflict", mergeBase: remote.version };
}

export type PushAction =
  | { kind: "none" }
  | { kind: "skip-conflict" }
  | { kind: "put"; baseVersion: number }
  | { kind: "delete"; baseVersion: number }
  | { kind: "restore-standard" };

export function decidePush(i: {
  local: LocalHash;
  record: RecordEntry | null;
  hasRemoteFile: boolean;
  path: string;
}): PushAction {
  if (i.hasRemoteFile) return { kind: "skip-conflict" };
  const l = localState(i.local, i.record);
  const base = i.record ? (i.record.mergeBase ?? i.record.version) : 0;
  switch (l) {
    case "changed":
      return { kind: "put", baseVersion: base };
    case "new":
      return { kind: "put", baseVersion: 0 };
    case "deleted":
      return isStandardPage(i.path) ? { kind: "restore-standard" } : { kind: "delete", baseVersion: base };
    default:
      return { kind: "none" };
  }
}

export type RemoteDiffAction =
  | { kind: "conflict"; mergeBase: number }
  | { kind: "record-only" }
  | { kind: "restore" }
  | { kind: "keep-drop-record" }
  | { kind: "drop-record" };

/** A push refused with 409: `current` is the server's page, or null when it was deleted there. */
export function decideRemoteDiff(i: { local: LocalHash; current: RemoteMeta | null }): RemoteDiffAction {
  if (i.current === null) return i.local === null ? { kind: "drop-record" } : { kind: "keep-drop-record" };
  if (i.local === null) return { kind: "restore" };
  return i.local === i.current.sha256
    ? { kind: "record-only" }
    : { kind: "conflict", mergeBase: i.current.version };
}
