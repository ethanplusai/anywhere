import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const load = async (name: string) =>
  (await import(pathToFileURL(join(repo, "skill", name)).href)) as Record<string, (...a: never[]) => unknown>;

const skill = readFileSync(join(repo, "skill", "anywhere", "SKILL.md"), "utf8");
const layout = readFileSync(join(repo, "docs", "layout.md"), "utf8");

describe("skill", () => {
  it("committed SKILL.md matches what the build produces (fails on drift; run: node skill/build.mjs)", async () => {
    const { buildSkill } = await load("build.mjs");
    expect(skill).toBe((buildSkill as () => string)());
  });

  it("contains every row and rule of docs/layout.md verbatim", () => {
    const lines = layout.split("\n").filter((l) => /^\| `/.test(l) || /^\d+\. /.test(l) || /^ {3}\S/.test(l));
    expect(lines.length).toBeGreaterThanOrEqual(14);
    for (const l of lines) expect(skill).toContain(l);
  });

  it("has the frontmatter and the trigger phrases", () => {
    expect(skill).toMatch(/^---\nname: anywhere\ndescription: .+\n---\n/);
    const description = skill.split("\n")[2] ?? "";
    for (const phrase of ["add this to anywhere", "check anywhere", "what did we decide", ".anywhere/"]) {
      expect(description).toContain(phrase);
    }
  });

  it("covers the routines an agent needs", () => {
    for (const s of ["anywr pull", "anywr push", ".remote.md", "base_version", "MCP tools alone", "Read before you write", "Not worth storing"]) {
      expect(skill).toContain(s);
    }
  });

  it("installs into Claude Code and Codex skill folders", async () => {
    const { install, targets } = (await load("install.mjs")) as unknown as {
      install: (d: string[]) => string[];
      targets: (o: object) => string[];
    };
    const home = mkdtempSync(join(tmpdir(), "anywr-skill-"));
    try {
      const dirs = targets({ env: {}, home });
      expect(dirs).toEqual([join(home, ".claude/skills/anywhere"), join(home, ".codex/skills/anywhere")]);
      install(dirs);
      for (const d of dirs) expect(readFileSync(join(d, "SKILL.md"), "utf8")).toBe(skill);
      install(dirs); // idempotent
      expect(existsSync(join(dirs[0] as string, "SKILL.md"))).toBe(true);
      expect(targets({ codex: true, env: {}, home })).toEqual([join(home, ".codex/skills/anywhere")]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
