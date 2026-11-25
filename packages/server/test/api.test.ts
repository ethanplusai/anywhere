/* eslint-disable @typescript-eslint/no-explicit-any -- tests read loosely typed JSON bodies */
import { createHash } from "node:crypto";
import { unzipSync, strFromU8 } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUser } from "../src/auth/users.js";
import { createPat } from "../src/auth/tokens.js";
import { makeTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
beforeEach(async () => {
  t = await makeTestApp();
});
afterEach(async () => {
  await t.close();
});

const sha = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

async function json(res: Response) {
  return (await res.json()) as Record<string, any>;
}

async function expectApiError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  const body = await json(res);
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe("string");
  return body;
}

describe("auth", () => {
  it("401s with code unauthorized for missing, bad and revoked tokens", async () => {
    await expectApiError(await t.fetch("/api/v1/me"), 401, "unauthorized");
    await expectApiError(await t.api("GET", "/me", undefined, "anywr_wrong"), 401, "unauthorized");
    await expectApiError(await t.api("GET", "/projects", undefined, "garbage"), 401, "unauthorized");
  });

  it("GET /me returns the user", async () => {
    const res = await t.api("GET", "/me");
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ user: { id: t.user.id, email: "me@example.com" } });
  });
});

describe("projects", () => {
  it("creates, lists and gets projects with the documented shapes", async () => {
    const res = await t.api("POST", "/projects", { name: "Acme Rebrand", description: "Rebrand work." });
    expect(res.status).toBe(200);
    const created = await json(res);
    expect(created.project).toEqual({
      slug: "acme-rebrand",
      name: "Acme Rebrand",
      description: "Rebrand work.",
      updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(created.pages).toHaveLength(6);
    expect(Object.keys(created.pages[0]).sort()).toEqual(["path", "sha256", "size", "updatedAt", "version"]);

    const list = await json(await t.api("GET", "/projects"));
    expect(list.projects.map((p: { slug: string }) => p.slug)).toEqual(["acme-rebrand"]);

    const got = await json(await t.api("GET", "/projects/acme-rebrand"));
    expect(got.project.slug).toBe("acme-rebrand");
    expect(got.pages.map((p: { path: string }) => p.path)).toEqual([
      "decisions.md",
      "ideas.md",
      "log.md",
      "open-questions.md",
      "overview.md",
      "plan.md",
    ]);
  });

  it("returns 409 slug_taken, 422 invalid_slug and 422 invalid_body", async () => {
    await t.api("POST", "/projects", { name: "Acme" });
    await expectApiError(await t.api("POST", "/projects", { name: "Acme" }), 409, "slug_taken");
    await expectApiError(await t.api("POST", "/projects", { name: "x", slug: "NO" }), 422, "invalid_slug");
    await expectApiError(await t.api("POST", "/projects", { slug: "x" }), 422, "invalid_body");
    await expectApiError(await t.api("POST", "/projects", "{not json"), 422, "invalid_body");
    await expectApiError(await t.api("POST", "/projects", "[1,2]"), 422, "invalid_body");
  });

  it("404s an unknown project and another user's project", async () => {
    const other = await createUser(t.db, "o@example.com", "long enough pw");
    const { token } = await createPat(t.db, other.id, "o");
    await t.api("POST", "/projects", { name: "Secret" }, token);
    await expectApiError(await t.api("GET", "/projects/secret"), 404, "not_found");
    await expectApiError(await t.api("GET", "/projects/nope"), 404, "not_found");
    await expectApiError(await t.api("GET", "/projects/secret/pages/overview.md"), 404, "not_found");
    await expectApiError(await t.api("GET", "/projects/secret/export"), 404, "not_found");
  });
});

describe("pages", () => {
  beforeEach(async () => {
    await t.api("POST", "/projects", { name: "P" });
  });

  it("reads a page with content", async () => {
    const body = await json(await t.api("GET", "/projects/p/pages/overview.md"));
    expect(body.page).toMatchObject({ path: "overview.md", version: 1 });
    expect(body.page.sha256).toBe(sha(body.page.content));
  });

  it("creates and updates nested pages through the wildcard path", async () => {
    const created = await t.api("PUT", "/projects/p/pages/topics/pricing.md", { content: "# Pricing\n", baseVersion: 0 });
    expect(created.status).toBe(200);
    expect((await json(created)).page).toEqual({
      path: "topics/pricing.md",
      version: 1,
      sha256: sha("# Pricing\n"),
      size: 10,
      updatedAt: expect.any(String),
    });
    const updated = await json(await t.api("PUT", "/projects/p/pages/topics/pricing.md", { content: "v2", baseVersion: 1 }));
    expect(updated.page.version).toBe(2);
    const read = await json(await t.api("GET", "/projects/p/pages/topics/pricing.md"));
    expect(read.page.content).toBe("v2");
  });

  it("answers a stale PUT with 409 and current", async () => {
    await t.api("PUT", "/projects/p/pages/ideas.md", { content: "mine", baseVersion: 1 });
    const res = await t.api("PUT", "/projects/p/pages/ideas.md", { content: "theirs", baseVersion: 1 });
    const body = await expectApiError(res, 409, "version_conflict");
    expect(body.current).toMatchObject({ path: "ideas.md", version: 2, content: "mine", sha256: sha("mine"), size: 4 });
    const create = await t.api("PUT", "/projects/p/pages/ideas.md", { content: "x", baseVersion: 0 });
    expect((await expectApiError(create, 409, "version_conflict")).current.version).toBe(2);
  });

  it("answers 409 with current null for a deleted page", async () => {
    await t.api("PUT", "/projects/p/pages/topics/x.md", { content: "x", baseVersion: 0 });
    expect(await json(await t.api("DELETE", "/projects/p/pages/topics/x.md?baseVersion=1"))).toEqual({ deleted: true });
    const body = await expectApiError(
      await t.api("PUT", "/projects/p/pages/topics/x.md", { content: "y", baseVersion: 1 }),
      409,
      "version_conflict",
    );
    expect(body.current).toBeNull();
    const recreated = await json(await t.api("PUT", "/projects/p/pages/topics/x.md", { content: "z", baseVersion: 0 }));
    expect(recreated.page.version).toBe(3);
  });

  it("validates bodies, paths and sizes with 422 codes", async () => {
    await expectApiError(await t.api("PUT", "/projects/p/pages/ideas.md", { baseVersion: 1 }), 422, "invalid_body");
    await expectApiError(await t.api("PUT", "/projects/p/pages/ideas.md", { content: "x" }), 422, "invalid_body");
    await expectApiError(await t.api("PUT", "/projects/p/pages/ideas.md", { content: "x", baseVersion: "1" }), 422, "invalid_body");
    await expectApiError(await t.api("PUT", "/projects/p/pages/ideas.md", { content: "x", baseVersion: 1.5 }), 422, "invalid_body");
    await expectApiError(await t.api("PUT", "/projects/p/pages/Ideas.md", { content: "x", baseVersion: 0 }), 422, "invalid_path");
    await expectApiError(await t.api("PUT", "/projects/p/pages/a/b/c.md", { content: "x", baseVersion: 0 }), 422, "invalid_path");
    await expectApiError(await t.api("PUT", "/projects/p/pages/x.remote.md", { content: "x", baseVersion: 0 }), 422, "invalid_path");
    await expectApiError(await t.api("PUT", "/projects/p/pages/a%2Fb.md", { content: "x", baseVersion: 0 }), 422, "invalid_path");
    await expectApiError(await t.api("GET", "/projects/p/pages/NOPE.md"), 422, "invalid_path");
    await expectApiError(
      await t.api("PUT", "/projects/p/pages/big.md", { content: "a".repeat(262145), baseVersion: 0 }),
      422,
      "too_large",
    );
  });

  it("refuses request bodies over 1 MiB with 422 too_large", async () => {
    const res = await t.api("PUT", "/projects/p/pages/big.md", { content: "a".repeat(1024 * 1024 + 10), baseVersion: 0 });
    await expectApiError(res, 422, "too_large");
  });

  it("appends, 404s an append to a missing page, and validates", async () => {
    const res = await t.api("POST", "/projects/p/pages/log.md/append", { content: "2026-11-22 did a thing\n" });
    expect(res.status).toBe(200);
    expect((await json(res)).page.version).toBe(2);
    await expectApiError(await t.api("POST", "/projects/p/pages/topics/none.md/append", { content: "x" }), 404, "not_found");
    await expectApiError(await t.api("POST", "/projects/p/pages/log.md/append", { text: "x" }), 422, "invalid_body");
    await expectApiError(await t.api("POST", "/projects/p/pages/log.md", { content: "x" }), 404, "not_found");
  });

  it("deletes with baseVersion, refuses standard pages and stale versions", async () => {
    await expectApiError(await t.api("DELETE", "/projects/p/pages/log.md?baseVersion=1"), 422, "standard_page");
    await t.api("PUT", "/projects/p/pages/topics/d.md", { content: "a", baseVersion: 0 });
    await t.api("PUT", "/projects/p/pages/topics/d.md", { content: "b", baseVersion: 1 });
    const stale = await expectApiError(await t.api("DELETE", "/projects/p/pages/topics/d.md?baseVersion=1"), 409, "version_conflict");
    expect(stale.current).toMatchObject({ version: 2, content: "b" });
    await expectApiError(await t.api("DELETE", "/projects/p/pages/topics/d.md"), 422, "invalid_body");
    await expectApiError(await t.api("DELETE", "/projects/p/pages/topics/d.md?baseVersion=x"), 422, "invalid_body");
    await expectApiError(await t.api("DELETE", "/projects/p/pages/topics/none.md?baseVersion=1"), 404, "not_found");
    expect((await t.api("DELETE", "/projects/p/pages/topics/d.md?baseVersion=2")).status).toBe(200);
    await expectApiError(await t.api("GET", "/projects/p/pages/topics/d.md"), 404, "not_found");
  });

  it("exports a zip with pages under one folder named after the slug, and nothing else", async () => {
    await t.api("PUT", "/projects/p/pages/topics/pricing.md", { content: "# Pricing ✓\n", baseVersion: 0 });
    await t.api("PUT", "/projects/p/pages/topics/gone.md", { content: "x", baseVersion: 0 });
    await t.api("DELETE", "/projects/p/pages/topics/gone.md?baseVersion=1");
    const res = await t.api("GET", "/projects/p/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toContain('filename="p.zip"');
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual([
      "p/decisions.md",
      "p/ideas.md",
      "p/log.md",
      "p/open-questions.md",
      "p/overview.md",
      "p/plan.md",
      "p/topics/pricing.md",
    ]);
    expect(strFromU8(files["p/topics/pricing.md"]!)).toBe("# Pricing ✓\n");
  });

  it("returns ApiError 404 for unknown API routes", async () => {
    await expectApiError(await t.api("GET", "/nope"), 404, "not_found");
  });
});

describe("rate limiting", () => {
  it("answers 429 with Retry-After once the limit is passed", async () => {
    const limited = await makeTestApp({ ANYWHERE_API_RATE_LIMIT: "3" });
    try {
      for (let i = 0; i < 3; i++) expect((await limited.api("GET", "/me")).status).toBe(200);
      const res = await limited.api("GET", "/me");
      await expectApiError(res, 429, "rate_limited");
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    } finally {
      await limited.close();
    }
  });
});
