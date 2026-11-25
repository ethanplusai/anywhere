import { describe, expect, it } from "vitest";
import {
  decidePull,
  decidePush,
  decideRemoteDiff,
  isPagePath,
  isStandardPage,
  type RecordEntry,
  type RemoteMeta,
} from "../src/sync.js";

const rec = (version: number, sha256: string, mergeBase?: number): RecordEntry =>
  mergeBase === undefined ? { version, sha256 } : { version, sha256, mergeBase };
const rem = (version: number, sha256: string): RemoteMeta => ({ version, sha256 });

describe("page paths", () => {
  it("accepts valid and rejects invalid", () => {
    expect(isPagePath("overview.md")).toBe(true);
    expect(isPagePath("topics/pricing.md")).toBe(true);
    expect(isPagePath("overview.remote.md")).toBe(false);
    expect(isPagePath("a/b/c.md")).toBe(false);
    expect(isPagePath("Upper.md")).toBe(false);
    expect(isPagePath(".link.json")).toBe(false);
    expect(isPagePath("notes.txt")).toBe(false);
  });
  it("knows standard pages", () => {
    for (const p of ["overview.md", "decisions.md", "open-questions.md", "ideas.md", "log.md"]) {
      expect(isStandardPage(p)).toBe(true);
    }
    expect(isStandardPage("topics/overview.md")).toBe(false);
  });
});

describe("decidePull (one test per row of the pull table)", () => {
  it("unchanged / changed -> overwrite", () => {
    expect(decidePull({ local: "A", record: rec(1, "A"), remote: rem(2, "B") })).toEqual({ kind: "overwrite" });
  });
  it("unchanged / deleted -> delete file and record", () => {
    expect(decidePull({ local: "A", record: rec(1, "A"), remote: null })).toEqual({ kind: "delete-local" });
  });
  it("any / unchanged -> leave alone", () => {
    for (const local of ["A", "X", null]) {
      expect(decidePull({ local, record: rec(1, "A"), remote: rem(1, "A") })).toEqual({ kind: "none" });
    }
  });
  it("none / new -> write file", () => {
    expect(decidePull({ local: null, record: null, remote: rem(3, "B") })).toEqual({ kind: "write" });
  });
  it("changed / changed, same bytes -> update record only", () => {
    expect(decidePull({ local: "B", record: rec(1, "A"), remote: rem(2, "B") })).toEqual({ kind: "record-only" });
  });
  it("new / new, same bytes -> update record only", () => {
    expect(decidePull({ local: "B", record: null, remote: rem(2, "B") })).toEqual({ kind: "record-only" });
  });
  it("changed / changed, different bytes -> conflict with mergeBase", () => {
    expect(decidePull({ local: "X", record: rec(1, "A"), remote: rem(2, "B") })).toEqual({
      kind: "conflict",
      mergeBase: 2,
    });
  });
  it("new / new, different bytes -> conflict", () => {
    expect(decidePull({ local: "X", record: null, remote: rem(2, "B") })).toEqual({ kind: "conflict", mergeBase: 2 });
  });
  it("changed / deleted -> keep file, drop record", () => {
    expect(decidePull({ local: "X", record: rec(1, "A"), remote: null })).toEqual({ kind: "keep-drop-record" });
  });
  it("deleted / changed -> restore server copy", () => {
    expect(decidePull({ local: null, record: rec(1, "A"), remote: rem(2, "B") })).toEqual({ kind: "restore" });
  });
  it("deleted / deleted -> drop record", () => {
    expect(decidePull({ local: null, record: rec(1, "A"), remote: null })).toEqual({ kind: "drop-record" });
  });
  it("nothing anywhere -> none", () => {
    expect(decidePull({ local: null, record: null, remote: null })).toEqual({ kind: "none" });
  });
  it("conflict already open and remote still at mergeBase -> leave alone", () => {
    expect(decidePull({ local: "X", record: rec(1, "A", 2), remote: rem(2, "B") })).toEqual({ kind: "none" });
  });
  it("conflict open and remote moved past mergeBase -> new conflict", () => {
    expect(decidePull({ local: "X", record: rec(1, "A", 2), remote: rem(3, "C") })).toEqual({
      kind: "conflict",
      mergeBase: 3,
    });
  });
  it("conflict open, merged result equals remote bytes -> record only", () => {
    expect(decidePull({ local: "B", record: rec(1, "A", 2), remote: rem(2, "B") })).toEqual({ kind: "record-only" });
  });
});

describe("decidePush", () => {
  it("skips a page with an open .remote.md", () => {
    expect(decidePush({ local: "X", record: rec(1, "A"), hasRemoteFile: true, path: "overview.md" })).toEqual({
      kind: "skip-conflict",
    });
  });
  it("unchanged -> none", () => {
    expect(decidePush({ local: "A", record: rec(1, "A"), hasRemoteFile: false, path: "overview.md" })).toEqual({
      kind: "none",
    });
  });
  it("changed -> put with recorded version", () => {
    expect(decidePush({ local: "X", record: rec(3, "A"), hasRemoteFile: false, path: "ideas.md" })).toEqual({
      kind: "put",
      baseVersion: 3,
    });
  });
  it("changed with mergeBase -> put with mergeBase", () => {
    expect(decidePush({ local: "X", record: rec(3, "A", 7), hasRemoteFile: false, path: "ideas.md" })).toEqual({
      kind: "put",
      baseVersion: 7,
    });
  });
  it("new -> put with base 0", () => {
    expect(decidePush({ local: "X", record: null, hasRemoteFile: false, path: "topics/x.md" })).toEqual({
      kind: "put",
      baseVersion: 0,
    });
  });
  it("deleted -> delete with recorded version", () => {
    expect(decidePush({ local: null, record: rec(4, "A"), hasRemoteFile: false, path: "topics/x.md" })).toEqual({
      kind: "delete",
      baseVersion: 4,
    });
  });
  it("deleted standard page -> restore", () => {
    expect(decidePush({ local: null, record: rec(4, "A"), hasRemoteFile: false, path: "log.md" })).toEqual({
      kind: "restore-standard",
    });
  });
  it("nothing local, no record -> none", () => {
    expect(decidePush({ local: null, record: null, hasRemoteFile: false, path: "x.md" })).toEqual({ kind: "none" });
  });
});

describe("decideRemoteDiff (409 with current)", () => {
  it("local changed vs current different -> conflict", () => {
    expect(decideRemoteDiff({ local: "X", current: rem(8, "B") })).toEqual({ kind: "conflict", mergeBase: 8 });
  });
  it("same bytes -> record only", () => {
    expect(decideRemoteDiff({ local: "B", current: rem(8, "B") })).toEqual({ kind: "record-only" });
  });
  it("local deleted -> restore", () => {
    expect(decideRemoteDiff({ local: null, current: rem(8, "B") })).toEqual({ kind: "restore" });
  });
  it("current null -> keep file, drop record", () => {
    expect(decideRemoteDiff({ local: "X", current: null })).toEqual({ kind: "keep-drop-record" });
  });
  it("local deleted and current null -> drop record", () => {
    expect(decideRemoteDiff({ local: null, current: null })).toEqual({ kind: "drop-record" });
  });
});
