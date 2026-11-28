import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/db.js";
import { createUser } from "../src/auth/users.js";
import { loadLayout } from "../src/content/layout.js";
import { createService, type Service } from "../src/service/projects.js";
import { STANDARD_PAGES } from "../src/service/validate.js";
import { freshDb } from "./helpers.js";

let db: Db;
let svc: Service;
let me: string;
let other: string;

beforeEach(async () => {
  db = await freshDb();
  svc = createService(db, loadLayout());
  me = (await createUser(db, "me@example.com")).id;
  other = (await createUser(db, "other@example.com")).id;
});
afterEach(async () => {
  await db.close();
});

const sha = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

async function expectError(p: Promise<unknown>, status: number, code: string) {
  await expect(p).rejects.toMatchObject({ status, code });
}

describe("projects", () => {
  it("derives the slug from the name and creates the five standard pages at version 1", async () => {
    const { project, pages } = await svc.createProject(me, { name: "Acme  Rebrand!" });
    expect(project).toMatchObject({ slug: "acme-rebrand", name: "Acme  Rebrand!", description: "" });
    expect(typeof project.updatedAt).toBe("string");
    expect(pages.map((p) => p.path).sort()).toEqual([...STANDARD_PAGES].sort());
    expect(pages.every((p) => p.version === 1)).toBe(true);
    const overview = await svc.getPage(me, "acme-rebrand", "overview.md");
    expect(overview.content).toBe(loadLayout().templates["overview.md"]);
    expect(overview.sha256).toBe(sha(overview.content));
    expect(overview.size).toBe(Buffer.byteLength(overview.content));
  });

  it("refuses a taken slug without inventing a suffix", async () => {
    await svc.createProject(me, { name: "Acme" });
    await expectError(svc.createProject(me, { name: "ACME" }), 409, "slug_taken");
    // Another user may use the same slug.
    await expect(svc.createProject(other, { name: "Acme" })).resolves.toBeTruthy();
  });

  it("validates slug, name and description", async () => {
    await expectError(svc.createProject(me, { name: "!!!" }), 422, "invalid_slug");
    await expectError(svc.createProject(me, { name: "x", slug: "Bad Slug" }), 422, "invalid_slug");
    await expectError(svc.createProject(me, { name: "x", slug: "a".repeat(65) }), 422, "invalid_slug");
    await expectError(svc.createProject(me, { name: "" }), 422, "invalid_body");
    const { project } = await svc.createProject(me, { name: "x", slug: "my-x", description: "One line." });
    expect(project).toMatchObject({ slug: "my-x", description: "One line." });
  });

  it("trims a long derived slug to 64 characters", async () => {
    const { project } = await svc.createProject(me, { name: "word ".repeat(30) });
    expect(project.slug.length).toBeLessThanOrEqual(64);
    expect(project.slug.endsWith("-")).toBe(false);
  });

  it("lists only the caller's projects and hides others' as 404", async () => {
    await svc.createProject(me, { name: "Mine" });
    await svc.createProject(other, { name: "Theirs" });
    expect((await svc.listProjects(me)).map((p) => p.slug)).toEqual(["mine"]);
    await expectError(svc.getProject(me, "theirs"), 404, "not_found");
    await expectError(svc.getPage(me, "theirs", "overview.md"), 404, "not_found");
    await expectError(svc.putPage(me, "theirs", "overview.md", "x", 1), 404, "not_found");
    await expectError(svc.deletePage(me, "theirs", "log.md", 1), 404, "not_found");
  });

  it("moves the project's updatedAt when a page changes", async () => {
    const { project } = await svc.createProject(me, { name: "P" });
    await new Promise((r) => setTimeout(r, 5));
    await svc.appendPage(me, "p", "log.md", "entry");
    const [after] = await svc.listProjects(me);
    expect(Date.parse(after!.updatedAt)).toBeGreaterThan(Date.parse(project.updatedAt));
  });
});

describe("pages", () => {
  beforeEach(async () => {
    await svc.createProject(me, { name: "P" });
  });

  it("creates with baseVersion 0 and refuses baseVersion 0 on an existing page with current", async () => {
    const created = await svc.putPage(me, "p", "topics/pricing.md", "# Pricing\n", 0);
    expect(created).toMatchObject({ path: "topics/pricing.md", version: 1, sha256: sha("# Pricing\n"), size: 10 });
    const err = await svc.putPage(me, "p", "topics/pricing.md", "other", 0).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, code: "version_conflict" });
    expect((err as { extra: { current: unknown } }).extra.current).toMatchObject({
      path: "topics/pricing.md",
      version: 1,
      content: "# Pricing\n",
    });
  });

  it("replaces with the right baseVersion and conflicts on a stale one without changing anything", async () => {
    const v2 = await svc.putPage(me, "p", "overview.md", "# Overview\n\nNew.\n", 1);
    expect(v2.version).toBe(2);
    await expectError(svc.putPage(me, "p", "overview.md", "stale", 1), 409, "version_conflict");
    const page = await svc.getPage(me, "p", "overview.md");
    expect(page).toMatchObject({ version: 2, content: "# Overview\n\nNew.\n" });
  });

  it("treats a byte-identical PUT as a no-op: same version, same updatedAt", async () => {
    const before = await svc.getPage(me, "p", "ideas.md");
    await new Promise((r) => setTimeout(r, 5));
    const after = await svc.putPage(me, "p", "ideas.md", before.content, 1);
    expect(after.version).toBe(1);
    expect(after.updatedAt).toBe(before.updatedAt);
    const revs = await db.query("SELECT 1 FROM revisions r JOIN pages p ON p.id = r.page_id WHERE p.path = 'ideas.md'");
    expect(revs).toHaveLength(1);
  });

  it("stores and hashes the exact bytes sent", async () => {
    const content = "﻿line one\r\nline two  \r\n\ttabbed 🎉 é\u0000end";
    const meta = await svc.putPage(me, "p", "topics/bytes.md", content, 0);
    expect(meta.sha256).toBe(sha(content));
    expect(meta.size).toBe(Buffer.byteLength(content, "utf8"));
    const page = await svc.getPage(me, "p", "topics/bytes.md");
    expect(page.content).toBe(content);
    expect(page.sha256).toBe(sha(content));
  });

  it("refuses pages over 256 KiB and accepts exactly 256 KiB", async () => {
    await expect(svc.putPage(me, "p", "topics/big.md", "a".repeat(262144), 0)).resolves.toMatchObject({ size: 262144 });
    await expectError(svc.putPage(me, "p", "topics/big2.md", "a".repeat(262145), 0), 422, "too_large");
    // Multi-byte characters count as bytes.
    await expectError(svc.putPage(me, "p", "topics/big3.md", "é".repeat(131073), 0), 422, "too_large");
    await expectError(svc.appendPage(me, "p", "topics/big.md", "x"), 422, "too_large");
  });

  it("validates paths", async () => {
    for (const bad of [
      "Overview.md",
      "a/b/c.md",
      "overview.remote.md",
      "../x.md",
      "x.txt",
      "-x.md",
      "topics/.md",
      "/x.md",
      "x.md/",
      "a".repeat(64) + ".md",
    ]) {
      await expectError(svc.putPage(me, "p", bad, "x", 0), 422, "invalid_path");
    }
    await expect(svc.putPage(me, "p", "a".repeat(63) + ".md", "x", 0)).resolves.toBeTruthy();
  });

  it("refuses to delete a standard page but lets it be emptied", async () => {
    await expectError(svc.deletePage(me, "p", "log.md", 1), 422, "standard_page");
    await expect(svc.putPage(me, "p", "log.md", "", 1)).resolves.toMatchObject({ version: 2, size: 0 });
  });

  it("keeps a tombstone so a recreated page continues the version count", async () => {
    await svc.putPage(me, "p", "topics/x.md", "one", 0); // v1
    await svc.putPage(me, "p", "topics/x.md", "two", 1); // v2
    await svc.deletePage(me, "p", "topics/x.md", 2); // tombstone v3
    await expectError(svc.getPage(me, "p", "topics/x.md"), 404, "not_found");
    expect((await svc.getProject(me, "p")).pages.map((p) => p.path)).not.toContain("topics/x.md");

    // Writes against the old version see the page as deleted: current is null.
    const err = await svc.putPage(me, "p", "topics/x.md", "three", 2).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "version_conflict", extra: { current: null } });
    const delErr = await svc.deletePage(me, "p", "topics/x.md", 2).catch((e: unknown) => e);
    expect(delErr).toMatchObject({ status: 409, code: "version_conflict", extra: { current: null } });

    const recreated = await svc.putPage(me, "p", "topics/x.md", "again", 0);
    expect(recreated.version).toBe(4);
    // A client still holding version 1 or 2 can never match by accident.
    await expectError(svc.putPage(me, "p", "topics/x.md", "old", 1), 409, "version_conflict");
  });

  it("delete conflicts carry current like PUT", async () => {
    await svc.putPage(me, "p", "topics/y.md", "one", 0);
    await svc.putPage(me, "p", "topics/y.md", "two", 1);
    const err = await svc.deletePage(me, "p", "topics/y.md", 1).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, code: "version_conflict", extra: { current: { version: 2, content: "two" } } });
  });

  it("404s for pages that never existed", async () => {
    await expectError(svc.getPage(me, "p", "topics/none.md"), 404, "not_found");
    await expectError(svc.deletePage(me, "p", "topics/none.md", 1), 404, "not_found");
    await expectError(svc.appendPage(me, "p", "topics/none.md", "x"), 404, "not_found");
  });

  it("appends with a newline only when the page lacks one, and bumps the version", async () => {
    await svc.putPage(me, "p", "topics/a.md", "no newline", 0);
    const m1 = await svc.appendPage(me, "p", "topics/a.md", "second\n");
    expect(m1.version).toBe(2);
    await svc.appendPage(me, "p", "topics/a.md", "third");
    expect((await svc.getPage(me, "p", "topics/a.md")).content).toBe("no newline\nsecond\nthird");
  });

  it("does not append to a deleted page", async () => {
    await svc.putPage(me, "p", "topics/gone.md", "x", 0);
    await svc.deletePage(me, "p", "topics/gone.md", 1);
    await expectError(svc.appendPage(me, "p", "topics/gone.md", "y"), 404, "not_found");
  });

  it("keeps one revision per version, and a delete purges all but its tombstone", async () => {
    await svc.putPage(me, "p", "topics/r.md", "one", 0);
    await svc.putPage(me, "p", "topics/r.md", "two", 1);
    await svc.appendPage(me, "p", "topics/r.md", "three");
    const revs = () =>
      db.query<{ version: number; deleted: boolean; content: Buffer | null }>(
        "SELECT r.version, r.deleted, r.content FROM revisions r JOIN pages p ON p.id = r.page_id WHERE p.path = 'topics/r.md' ORDER BY r.version",
      );
    expect((await revs()).map((r) => [r.version, r.deleted, r.content?.toString("utf8") ?? null])).toEqual([
      [1, false, "one"],
      [2, false, "two"],
      [3, false, "two\nthree"],
    ]);
    await svc.deletePage(me, "p", "topics/r.md", 3);
    expect((await revs()).map((r) => [r.version, r.deleted, r.content?.toString("utf8") ?? null])).toEqual([[4, true, null]]);
  });

  it("serialises simultaneous writes: exactly one wins on the same base", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => svc.putPage(me, "p", "overview.md", `writer ${i}`, 1)),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const conflicts = results.filter(
      (r) => r.status === "rejected" && (r.reason as { code?: string }).code === "version_conflict",
    );
    expect(ok).toHaveLength(1);
    expect(conflicts).toHaveLength(9);
    expect((await svc.getPage(me, "p", "overview.md")).version).toBe(2);
  });

  it("serialises simultaneous creates of the same new path", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => svc.putPage(me, "p", "topics/new.md", `c${i}`, 0)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("serialises simultaneous appends without losing any", async () => {
    await Promise.all(Array.from({ length: 8 }, (_, i) => svc.appendPage(me, "p", "log.md", `entry ${i}\n`)));
    const page = await svc.getPage(me, "p", "log.md");
    expect(page.version).toBe(9);
    for (let i = 0; i < 8; i++) expect(page.content).toContain(`entry ${i}\n`);
  });

  it("lists pages with metadata and gives first non-empty lines", async () => {
    await svc.putPage(me, "p", "topics/z.md", "\n\n  Heading here\nmore", 0);
    const { pages } = await svc.getProjectWithOverview(me, "p");
    const z = pages.find((p) => p.path === "topics/z.md");
    expect(z).toMatchObject({ version: 1, firstLine: "Heading here" });
  });
});

describe("search", () => {
  beforeEach(async () => {
    await svc.createProject(me, { name: "Alpha" });
    await svc.createProject(me, { name: "Beta" });
    await svc.createProject(other, { name: "Gamma" });
    await svc.putPage(me, "alpha", "topics/pricing.md", "We chose a two-tier pricing model.", 0);
    await svc.putPage(me, "beta", "topics/pricing.md", "Pricing for beta is usage based.", 0);
    await svc.putPage(other, "gamma", "topics/pricing.md", "Secret pricing of someone else.", 0);
  });

  it("finds words across the caller's projects only, with snippets", async () => {
    const results = await svc.search(me, "pricing");
    expect(results.map((r) => r.project).sort()).toEqual(["alpha", "beta"]);
    expect(results[0]).toMatchObject({ path: "topics/pricing.md", version: 1 });
    expect(results.every((r) => typeof r.snippet === "string" && r.snippet.length > 0)).toBe(true);
  });

  it("filters to one project and ignores deleted pages", async () => {
    expect((await svc.search(me, "pricing", "alpha")).map((r) => r.project)).toEqual(["alpha"]);
    await svc.deletePage(me, "alpha", "topics/pricing.md", 1);
    expect((await svc.search(me, "pricing")).map((r) => r.project)).toEqual(["beta"]);
    await expectError(svc.search(me, "pricing", "gamma"), 404, "not_found");
  });

  it("accepts web-search syntax and caps results at 20", async () => {
    for (let i = 0; i < 25; i++) await svc.putPage(me, "alpha", `topics/t${i}.md`, `widget number ${i}`, 0);
    expect(await svc.search(me, "widget")).toHaveLength(20);
    expect(await svc.search(me, '"two-tier" -usage')).toHaveLength(1);
    expect(await svc.search(me, "")).toEqual([]);
  });
});

describe("standard pages added after a project was made", () => {
  it("adds a missing plan.md the first time the project is opened, recorded as Anywhere", async () => {
    const { freshDb } = await import("./helpers.js");
    const { createService } = await import("../src/service/projects.js");
    const { loadLayout } = await import("../src/content/layout.js");
    const { createUser } = await import("../src/auth/users.js");
    const db = await freshDb();
    try {
      const svc = createService(db, loadLayout());
      const u = await createUser(db, "old@example.test");
      await svc.createProject(u.id, { name: "Old" });
      await db.query("DELETE FROM pages WHERE path = 'plan.md'");
      const before = await db.query("SELECT 1 FROM pages WHERE path = 'plan.md'");
      expect(before).toHaveLength(0);
      const { pages } = await svc.getProjectPages(u.id, "old");
      const plan = pages.find((p) => p.path === "plan.md");
      expect(plan?.lastActor).toBe("anywhere");
      expect((await svc.getPage(u.id, "old", "plan.md")).content).toContain("## Next");
    } finally {
      await db.close();
    }
  });
});
