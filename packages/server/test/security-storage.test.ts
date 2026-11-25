// Audit 2026-11-23: D2 (quotas, revisions), D3 (memory-bounded reads and export), D5 (deletion).
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { Db } from "../src/db/db.js";
import { freshDb, makeTestApp, type TestApp } from "./helpers.js";

async function stored(db: Db, userId: string): Promise<{ counter: number; actual: number }> {
  const [row] = await db.query<{ counter: string; actual: string }>(
    `SELECT u.storage_bytes AS counter,
            COALESCE((SELECT sum(p.size) FROM pages p JOIN projects pr ON pr.id = p.project_id WHERE pr.user_id = u.id), 0)
          + COALESCE((SELECT sum(r.size) FROM revisions r JOIN pages p ON p.id = r.page_id JOIN projects pr ON pr.id = p.project_id WHERE pr.user_id = u.id), 0) AS actual
       FROM users u WHERE u.id = $1`,
    [userId],
  );
  return { counter: Number(row!.counter), actual: Number(row!.actual) };
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

describe("D2: storage quotas", () => {
  it("abuse: an append flood stops at the byte quota and history does not multiply it", async () => {
    const max = 64 * 1024;
    const t = await makeTestApp({ ANYWHERE_MAX_BYTES_PER_USER: String(max), ANYWHERE_API_RATE_LIMIT: "10000" });
    try {
      await t.api("POST", "/projects", { name: "Flood" });
      const chunk = "x".repeat(2000);
      let appended = 0;
      let refused: Response | undefined;
      for (let i = 0; i < 200; i++) {
        const res = await t.api("POST", "/projects/flood/pages/log.md/append", { content: chunk });
        if (res.status !== 200) {
          refused = res;
          break;
        }
        appended++;
      }
      expect(refused?.status).toBe(422);
      expect(await errorCode(refused!)).toBe("quota_exceeded");
      // Appends within the coalescing window share one revision, so the page can grow to about half the
      // quota (page + one revision) rather than a few kilobytes (page + one full copy per append).
      expect(appended).toBeGreaterThan(10);
      const s = await stored(t.db, t.user.id);
      expect(s.counter).toBe(s.actual);
      expect(s.actual).toBeLessThanOrEqual(max);
    } finally {
      await t.close();
    }
  });

  it("keeps only the last N revisions of a page", async () => {
    const t = await makeTestApp({ ANYWHERE_REVISIONS_KEPT: "3" });
    try {
      await t.api("POST", "/projects", { name: "Revs" });
      for (let v = 1; v <= 10; v++) await t.api("PUT", "/projects/revs/pages/ideas.md", { content: `v${v + 1}`, baseVersion: v });
      const revs = await t.db.query<{ version: number }>(
        "SELECT r.version FROM revisions r JOIN pages p ON p.id = r.page_id WHERE p.path = 'ideas.md' ORDER BY r.version",
      );
      expect(revs.map((r) => r.version)).toEqual([9, 10, 11]);
      const s = await stored(t.db, t.user.id);
      expect(s.counter).toBe(s.actual);
    } finally {
      await t.close();
    }
  });

  it("caps projects per user and pages per project", async () => {
    const t = await makeTestApp({ ANYWHERE_MAX_PROJECTS: "2", ANYWHERE_MAX_PAGES_PER_PROJECT: "9" });
    try {
      expect((await t.api("POST", "/projects", { name: "One" })).status).toBe(200);
      expect((await t.api("POST", "/projects", { name: "Two" })).status).toBe(200);
      const third = await t.api("POST", "/projects", { name: "Three" });
      expect(third.status).toBe(422);
      expect(await errorCode(third)).toBe("quota_exceeded");

      expect((await t.api("PUT", "/projects/one/pages/topics/a.md", { content: "a", baseVersion: 0 })).status).toBe(200);
      const ninth = await t.api("PUT", "/projects/one/pages/topics/b.md", { content: "b", baseVersion: 0 });
      expect(ninth.status).toBe(422);
      expect(await errorCode(ninth)).toBe("quota_exceeded");
      // Deleting a page frees its slot.
      await t.api("DELETE", "/projects/one/pages/topics/a.md?baseVersion=1");
      expect((await t.api("PUT", "/projects/one/pages/topics/b.md", { content: "b", baseVersion: 0 })).status).toBe(200);
    } finally {
      await t.close();
    }
  });

  it("holds the byte quota under simultaneous writes", async () => {
    const max = 120 * 1024;
    const t = await makeTestApp({ ANYWHERE_MAX_BYTES_PER_USER: String(max) });
    try {
      await t.api("POST", "/projects", { name: "Race" });
      const big = "y".repeat(20 * 1024);
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => t.api("PUT", `/projects/race/pages/topics/p${i}.md`, { content: big, baseVersion: 0 })),
      );
      const ok = results.filter((r) => r.status === 200).length;
      expect(ok).toBeGreaterThan(0);
      expect(ok).toBeLessThan(8);
      const s = await stored(t.db, t.user.id);
      expect(s.counter).toBe(s.actual);
      expect(s.actual).toBeLessThanOrEqual(max);
    } finally {
      await t.close();
    }
  });
});

describe("D5: deleting data", () => {
  it("deletes a project through the API only with ?confirm=<slug>, and frees its storage", async () => {
    const t = await makeTestApp();
    try {
      await t.api("POST", "/projects", { name: "Doomed" });
      await t.api("PUT", "/projects/doomed/pages/topics/x.md", { content: "x".repeat(5000), baseVersion: 0 });
      expect((await stored(t.db, t.user.id)).counter).toBeGreaterThan(10_000);
      const unconfirmed = await t.api("DELETE", "/projects/doomed");
      expect(unconfirmed.status).toBe(422);
      expect((await t.api("DELETE", "/projects/doomed?confirm=other")).status).toBe(422);
      const res = await t.api("DELETE", "/projects/doomed?confirm=doomed");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ deleted: true });
      expect((await t.api("GET", "/projects/doomed")).status).toBe(404);
      const left = await t.db.query("SELECT 1 FROM revisions");
      expect(left).toHaveLength(0);
      expect(await stored(t.db, t.user.id)).toEqual({ counter: 0, actual: 0 });
      expect((await t.api("DELETE", "/projects/doomed?confirm=doomed")).status).toBe(404);
    } finally {
      await t.close();
    }
  });

  it("cannot delete someone else's project", async () => {
    const t = await makeTestApp();
    try {
      await t.api("POST", "/projects", { name: "Mine" });
      const other = await makeTestApp({}, { db: t.db });
      const [o] = await t.db.query<{ id: string }>("INSERT INTO users (id, email, password_hash) VALUES ('u2', 'o@example.com', 'x') RETURNING id");
      const { createPat } = await import("../src/auth/tokens.js");
      const { token } = await createPat(t.db, o!.id, "o");
      expect((await other.api("DELETE", "/projects/mine?confirm=mine", undefined, token)).status).toBe(404);
      expect((await t.api("GET", "/projects/mine")).status).toBe(200);
    } finally {
      await t.close();
    }
  });
});

/** Largest total of bytea bytes returned by any single query, to bound what one request holds in memory. */
function maxResultBytes(db: Db): { db: Db; max: () => number } {
  let max = 0;
  const wrap = (inner: Db): Db => ({
    query: async <T,>(sql: string, params?: unknown[]) => {
      const rows = await inner.query<T>(sql, params);
      let bytes = 0;
      for (const r of rows as Record<string, unknown>[]) for (const v of Object.values(r)) if (Buffer.isBuffer(v)) bytes += v.length;
      max = Math.max(max, bytes);
      return rows;
    },
    transaction: (fn) => inner.transaction((tx) => fn(wrap(tx))),
    close: () => inner.close(),
  });
  return { db: wrap(db), max: () => max };
}

/** Inserts `count` pages of `size` bytes straight into the database (fast setup for big projects). */
async function bulkPages(t: TestApp, slug: string, count: number, size: number) {
  const [p] = await t.db.query<{ id: string }>("SELECT id FROM projects WHERE slug = $1", [slug]);
  const body = Buffer.alloc(size, "z");
  for (let i = 0; i < count; i++) {
    await t.db.query(
      `INSERT INTO pages (id, project_id, path, content, search_text, search, version, sha256, size)
       VALUES ($1, $2, $3, $4, '', ''::tsvector, 1, 'x', $5)`,
      [`bulk${i}`, p!.id, `topics/page-${String(i).padStart(4, "0")}.md`, body, size],
    );
  }
}

describe("D3: memory-bounded reads", () => {
  it("abuse: exporting a large project streams it a batch at a time", async () => {
    const probe = maxResultBytes(await freshDb());
    const t = await makeTestApp({ ANYWHERE_MAX_EXPORT_BYTES: String(64 * 1024 * 1024) }, { db: probe.db });
    try {
      await t.api("POST", "/projects", { name: "Huge" });
      const pageSize = 200 * 1024;
      const count = 60; // 12 MB of pages
      await bulkPages(t, "huge", count, pageSize);
      const res = await t.api("GET", "/projects/huge/export");
      expect(res.status).toBe(200);
      const zip = unzipSync(new Uint8Array(await res.arrayBuffer()));
      expect(Object.keys(zip)).toHaveLength(count + 8);
      expect(zip["huge/topics/page-0042.md"]!.length).toBe(pageSize);
      // No query result held more than one export batch (16 pages), against 12 MB in the project.
      expect(probe.max()).toBeLessThanOrEqual(16 * pageSize + 64 * 1024);
      expect(probe.max()).toBeLessThan((count * pageSize) / 3);
    } finally {
      await t.close();
    }
  });

  it("refuses to export a project over the size cap", async () => {
    const t = await makeTestApp({ ANYWHERE_MAX_EXPORT_BYTES: String(100 * 1024) });
    try {
      await t.api("POST", "/projects", { name: "Big" });
      await bulkPages(t, "big", 3, 50 * 1024);
      const res = await t.api("GET", "/projects/big/export");
      expect(res.status).toBe(422);
      expect(await errorCode(res)).toBe("too_large");
    } finally {
      await t.close();
    }
  });

  it("get_project reads only the head of each page", async () => {
    const probe = maxResultBytes(await freshDb());
    const t = await makeTestApp({}, { db: probe.db });
    try {
      await t.api("POST", "/projects", { name: "Wide" });
      await bulkPages(t, "wide", 100, 200 * 1024);
      const { service } = await import("../src/service/projects.js").then(async (m) => ({
        service: m.createService(probe.db, (await import("../src/content/layout.js")).loadLayout()),
      }));
      const result = await service.getProjectWithOverview(t.user.id, "wide");
      expect(result.pages).toHaveLength(108);
      expect(result.pages.find((p) => p.path === "topics/page-0001.md")!.firstLine).toBe("z".repeat(200));
      expect(result.overview?.path).toBe("overview.md");
      expect(probe.max()).toBeLessThanOrEqual(105 * 1024 + 256 * 1024);
    } finally {
      await t.close();
    }
  });
});

describe("D4: search limits", () => {
  it("refuses queries over 256 characters", async () => {
    const t = await makeTestApp();
    try {
      const { createService } = await import("../src/service/projects.js");
      const { loadLayout } = await import("../src/content/layout.js");
      const svc = createService(t.db, loadLayout());
      await expect(svc.search(t.user.id, "a".repeat(257))).rejects.toMatchObject({ code: "invalid_body", status: 422 });
      await expect(svc.search(t.user.id, "a".repeat(256))).resolves.toEqual([]);
    } finally {
      await t.close();
    }
  });

  it("builds snippets only for the 20 returned rows, from a prefix of each page", async () => {
    const t = await makeTestApp();
    try {
      const { searchSql } = await import("../src/service/projects.js");
      const plan = await t.db.query<{ "QUERY PLAN": string }>(`EXPLAIN (VERBOSE) ${searchSql(false)}`, [t.user.id, "pricing"]);
      const lines = plan.map((r) => r["QUERY PLAN"]);
      const limitLine = lines.findIndex((l) => /->\s+Limit|^Limit/.test(l.trim()) || l.includes("Limit"));
      expect(limitLine).toBeGreaterThan(-1);
      // ts_headline appears only above the Limit node, never in the scan below it.
      const below = lines.slice(limitLine + 1).join("\n");
      expect(below).not.toContain("ts_headline");
      expect(lines.slice(0, limitLine + 1).join("\n")).toContain("ts_headline");
      expect(searchSql(false)).toContain("left(p.search_text, 20000)");
    } finally {
      await t.close();
    }
  });

  it("answers a 256-character OR query over many pages quickly", async () => {
    const t = await makeTestApp({ ANYWHERE_MAX_PAGES_PER_PROJECT: "1000" });
    try {
      await t.api("POST", "/projects", { name: "Words" });
      const words = Array.from({ length: 300 }, (_, i) => `word${i}`);
      for (let i = 0; i < 150; i++) {
        await t.api("PUT", `/projects/words/pages/topics/w${i}.md`, { content: words.join(" ").repeat(20), baseVersion: 0 });
      }
      const query = words.slice(0, 60).join(" OR ").slice(0, 256);
      const { createService } = await import("../src/service/projects.js");
      const { loadLayout } = await import("../src/content/layout.js");
      const svc = createService(t.db, loadLayout());
      const started = Date.now();
      const results = await svc.search(t.user.id, query);
      expect(results).toHaveLength(20);
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      await t.close();
    }
  });
});

describe("D4: database pool settings", () => {
  it("sets a pool size, a statement timeout and an idle-in-transaction timeout by default", async () => {
    const { poolConfig } = await import("../src/db/db.js");
    const cfg = poolConfig("postgres://x@localhost/db");
    expect(cfg.max).toBe(10);
    expect(cfg.statement_timeout).toBe(15_000);
    expect(cfg.idle_in_transaction_session_timeout).toBe(10_000);
    const { loadConfig } = await import("../src/config.js");
    const c = loadConfig({ ANYWHERE_DB_POOL_MAX: "3", ANYWHERE_DB_STATEMENT_TIMEOUT_MS: "5000" });
    expect(poolConfig("postgres://x", c.db)).toMatchObject({ max: 3, statement_timeout: 5000 });
  });
});
