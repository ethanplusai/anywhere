import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/*
 * The skill's map-work script, run against a made-up home folder: sessions from Claude Code and
 * Codex, a repository checked out twice under different names, a product split over two
 * repositories, a generated site, someone else's project and sessions in folders that are not
 * projects.
 */

const SCRIPT = fileURLToPath(new URL("../../../skill/anywhere/scripts/map-work.mjs", import.meta.url));
let home: string;

function repo(dir: string, remote: string | null, reflog: "commit" | "clone" = "commit") {
  mkdirSync(join(dir, ".git", "logs"), { recursive: true });
  writeFileSync(join(dir, ".git", "config"), remote ? `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${remote}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n` : "[core]\n");
  const ts = Math.floor(Date.now() / 1000) - 3600;
  const line = reflog === "clone" ? `clone: from ${remote}` : "commit: work";
  writeFileSync(join(dir, ".git", "logs", "HEAD"), `0000000 1111111 A Person <a@example.com> ${ts} +0000\t${line}\n`);
}
function claudeSession(dir: string, cwd: string, title: string, id: string) {
  const folder = join(home, ".claude", "projects", dir);
  mkdirSync(folder, { recursive: true });
  const lines = [
    { type: "user", cwd, message: { role: "user", content: title } },
    { type: "ai-title", aiTitle: title },
  ];
  writeFileSync(join(folder, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

beforeAll(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "map-work-")));
  const projects = join(home, "Projects");
  repo(join(projects, "rocket"), "git@github.com:Acme/rocket.git");
  repo(join(projects, "old-name"), "https://github.com/acme/rocket"); // the same repository, renamed folder
  repo(join(projects, "rocket-site"), "https://github.com/acme/rocket-site.git");
  repo(join(projects, "roofer-site-a1b2c3"), "https://github.com/acme/roofer-site-a1b2c3.git");
  repo(join(projects, "cool-tool"), "https://github.com/someone/cool-tool.git", "clone");
  mkdirSync(join(projects, "rocket", "docs", "plans"), { recursive: true });
  writeFileSync(join(projects, "rocket", "README.md"), "# Rocket\n");
  mkdirSync(join(projects, "rocket", ".vercel"), { recursive: true });
  writeFileSync(join(projects, "rocket", ".vercel", "project.json"), JSON.stringify({ projectId: "prj_x", orgId: "team_x", projectName: "rocket-app" }));

  for (let i = 0; i < 3; i++) claudeSession("-p-rocket", join(projects, "rocket"), `Ship the rocket launch page part ${i}`, `r${i}`);
  claudeSession("-p-old-name", join(projects, "old-name"), "Fix the countdown timer on the rocket", "o1");
  claudeSession("-p-site", join(projects, "rocket-site"), "Write the pricing section for the site", "s1");
  claudeSession("-tmp", "/tmp/scratch-thing", "Try something quickly in a temp folder", "t1");
  claudeSession("-home", home, "What should I work on today across everything", "h1");
  claudeSession("-gone", join(projects, "deleted-thing"), "Prototype for an idea that was deleted", "g1");
  claudeSession("-secret", join(projects, "rocket"), "Use key sk-ant-abcdefghijklmnopqrstuvwxyz0123456789 for this test", "k1");

  const codex = join(home, ".codex", "sessions", "2026", "11", "20");
  mkdirSync(codex, { recursive: true });
  writeFileSync(
    join(codex, "rollout-1.jsonl"),
    [
      { type: "session_meta", payload: { cwd: join(projects, "rocket"), source: "cli" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Review the rocket launch checklist" }] } },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n",
  );
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

type Repo = { name: string; repo: string | null; checkouts: string[]; hosting: string[]; has: string[]; plans: string[]; titles: string[]; renamed: string | null };
type Product = { owner: string | null; name: string; suggest: string; reason: string; sessions: number; repos: Repo[] };
type Result = { groups: { owner: string; products: Product[] }[]; setAside: Record<string, unknown> & { generated: Repo[]; others: Repo[]; goneFolders: { path: string }[] } };

function run(...extra: string[]): Result {
  const out = execFileSync(process.execPath, [SCRIPT, "--json", "--roots", join(home, "Projects"), ...extra], {
    env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: "", CODEX_HOME: "" },
    encoding: "utf8",
  });
  return JSON.parse(out) as Result;
}

describe("map-work", () => {
  it("merges copies of a repository and groups a product's repositories under their owner", () => {
    const r = run();
    const acme = r.groups.find((g) => g.owner === "github.com/acme");
    expect(acme).toBeDefined();
    expect(acme!.products).toHaveLength(1);
    const rocket = acme!.products[0]!;
    expect(rocket.name).toBe("rocket");
    expect(rocket.repos.map((x) => x.repo).sort()).toEqual(["github.com/acme/rocket", "github.com/acme/rocket-site"]);
    const main = rocket.repos.find((x) => x.repo === "github.com/acme/rocket")!;
    expect(main.checkouts.sort()).toEqual(["~/Projects/old-name", "~/Projects/rocket"]);
    expect(main.hosting).toEqual(["Vercel (rocket-app)"]);
    expect(main.has).toContain("README.md");
    expect(main.plans).toContain("docs/plans");
    // Claude Code and Codex sessions both count, and enough recent ones suggest bringing it in.
    expect(rocket.sessions).toBe(7);
    expect(rocket.suggest).toBe("bring_in");
  });

  it("sets aside generated sites, other people's projects, temp folders and folders that are gone", () => {
    const r = run();
    expect(r.setAside.generated.map((x) => x.name)).toEqual(["roofer-site-a1b2c3"]);
    expect(r.setAside.others.map((x) => x.repo)).toEqual(["github.com/someone/cool-tool"]);
    expect(r.setAside.goneFolders.map((x) => x.path)).toEqual(["~/Projects/deleted-thing"]);
    expect(r.setAside.sessionsInTempFolders).toBe(1);
    expect(r.setAside.sessionsNotInAProject).toBe(1);
  });

  it("keeps titles short and free of anything that looks like a key, and leaves them out on request", () => {
    const titles = run().groups.flatMap((g) => g.products.flatMap((p) => p.repos.flatMap((x) => x.titles)));
    expect(titles.length).toBeGreaterThan(0);
    expect(titles.join(" ")).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(titles.every((t) => t.length <= 90)).toBe(true);
    const none = run("--no-titles").groups.flatMap((g) => g.products.flatMap((p) => p.repos.flatMap((x) => x.titles)));
    expect(none).toEqual([]);
  });

  it("prints a readable draft without --json", () => {
    const out = execFileSync(process.execPath, [SCRIPT, "--roots", join(home, "Projects")], {
      env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: "", CODEX_HOME: "" },
      encoding: "utf8",
    });
    expect(out).toContain("## github.com/acme");
    expect(out).toContain("- rocket  [bring_in]");
    expect(out).toContain("2 copies: ~/Projects/rocket, ~/Projects/old-name");
    expect(out).toContain("## Set aside");
  });
});
