import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadLayout } from "../src/content/layout.js";
import { pgliteDb } from "../src/db/db.js";
import { migrate } from "../src/db/migrate.js";
import { STANDARD_PAGES } from "../src/service/validate.js";

describe("layout", () => {
  const layout = loadLayout();

  it("has a template for exactly the five standard pages", () => {
    expect(Object.keys(layout.templates).sort()).toEqual([...STANDARD_PAGES].sort());
  });

  it("builds each template from the docs/layout.md table row", () => {
    expect(layout.templates["overview.md"]).toMatch(/^# Overview\n\n_What the project is/);
    expect(layout.templates["overview.md"].endsWith("_\n")).toBe(true);
    expect(layout.templates["open-questions.md"]).toMatch(/^# Open questions\n\n_/);
    expect(layout.templates["log.md"]).toBe("# Log\n\n_Short dated entries about what a session did or discussed. Append only._\n");
  });

  it("gives the guide the rules but not the maintainer note", () => {
    expect(layout.guide).toContain("## Rules");
    expect(layout.guide).toContain("Read `overview.md` before you write");
    expect(layout.guide).not.toContain("This is the one description");
  });

  it("reads the repo's docs/layout.md, not a copy", () => {
    const source = readFileSync(new URL("../../../docs/layout.md", import.meta.url), "utf8");
    expect(source).toContain(layout.guide.split("\n").at(-1));
  });
});

describe("migrate", () => {
  it("is idempotent", async () => {
    const db = await pgliteDb();
    const first = await migrate(db);
    expect(first[0]).toBe("001_init.sql");
    expect(first).toEqual([...first].sort());
    expect(await migrate(db)).toEqual([]);
    const rows = await db.query("SELECT name FROM schema_migrations");
    expect(rows).toHaveLength(first.length);
    await db.close();
  });
});
