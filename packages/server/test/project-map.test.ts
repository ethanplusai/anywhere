import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPat } from "../src/auth/tokens.js";
import { createUser } from "../src/auth/users.js";
import { APP_HTML } from "../src/mcp/panels.js";
import { normalizeRepo } from "../src/service/validate.js";
import { BASE, makeTestApp, type TestApp } from "./helpers.js";

/*
 * Where a project sits in someone's work: its group (the business), its status and its repos, and
 * the setting-up map that proposes them.
 */

let t: TestApp;
let client: Client;

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean; structuredContent?: unknown };
async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult & { text: string }> {
  const res = (await client.callTool({ name, arguments: args })) as ToolResult;
  return { ...res, text: res.content.map((c) => c.text).join("\n") };
}
const json = async (res: Response) => (await res.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeEach(async () => {
  t = await makeTestApp();
  client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      fetch: (url, init) => t.fetch(String(url), init),
      requestInit: { headers: { authorization: `Bearer ${t.token}` } },
    }),
  );
});
afterEach(async () => {
  await client.close();
  await t.close();
});

describe("normalizeRepo", () => {
  it("reads every way a remote is written as host/owner/name", () => {
    for (const remote of [
      "git@github.com:Acme/Rocket.git",
      "https://github.com/Acme/Rocket",
      "https://github.com/acme/rocket.git/",
      "ssh://git@github.com/acme/rocket.git",
      "ssh://git@github.com:22/acme/rocket.git",
      "github.com/acme/rocket",
      "https://user@github.com/acme/rocket",
    ]) {
      expect(normalizeRepo(remote), remote).toBe("github.com/acme/rocket");
    }
    expect(normalizeRepo("https://gitlab.com/group/sub/repo.git")).toBe("gitlab.com/group/sub/repo");
    for (const bad of ["", "rocket", "github.com/acme", "/Users/me/rocket", "file:///tmp/x", 42, null, "a".repeat(400)]) {
      expect(normalizeRepo(bad), String(bad)).toBeNull();
    }
  });
});

describe("project details over the API", () => {
  it("creates with a group, status and repos, finds by any spelling of a remote, and patches", async () => {
    const created = await json(
      await t.api("POST", "/projects", {
        name: "Rocket",
        group: "Acme",
        repos: ["git@github.com:Acme/Rocket.git", "https://github.com/acme/rocket-site", "github.com/acme/rocket"],
      }),
    );
    expect(created.project).toMatchObject({ group: "Acme", status: "active", repos: ["github.com/acme/rocket", "github.com/acme/rocket-site"] });
    expect(created.pages.map((p: { path: string }) => p.path)).toEqual(expect.arrayContaining(["where.md", "rules.md"]));
    await t.api("POST", "/projects", { name: "Other" });

    const found = await json(await t.api("GET", `/projects?repo=${encodeURIComponent("https://github.com/ACME/rocket-site.git")}`));
    expect(found.projects.map((p: { slug: string }) => p.slug)).toEqual(["rocket"]);
    expect((await json(await t.api("GET", "/projects?repo=github.com/acme/nothing"))).projects).toEqual([]);
    expect((await t.api("GET", "/projects?repo=not-a-repo")).status).toBe(422);

    const patched = await json(await t.api("PATCH", "/projects/rocket", { status: "paused", group: "Acme Inc", repos: ["github.com/acme/rocket"] }));
    expect(patched.project).toMatchObject({ slug: "rocket", status: "paused", group: "Acme Inc", repos: ["github.com/acme/rocket"] });
  });

  it("refuses bad details", async () => {
    await t.api("POST", "/projects", { name: "Rocket" });
    for (const body of [{ status: "done" }, { repos: "github.com/a/b" }, { repos: ["nope"] }, { group: "x".repeat(81) }, { group: "a\u0000b" }, { name: "" }, {}]) {
      expect((await t.api("PATCH", "/projects/rocket", body)).status, JSON.stringify(body)).toBe(422);
    }
    expect((await t.api("POST", "/projects", { name: "R2", repos: Array.from({ length: 21 }, (_, i) => `github.com/a/r${i}`) })).status).toBe(422);
    expect((await t.api("PATCH", "/projects/missing", { status: "paused" })).status).toBe(404);
  });

  it("keeps one user's repos to themselves", async () => {
    await t.api("POST", "/projects", { name: "Rocket", repos: ["github.com/acme/rocket"] });
    const someone = await createUser(t.db, "other@example.com", "long enough pw");
    const { token } = await createPat(t.db, someone.id, "test");
    expect((await json(await t.api("GET", "/projects?repo=github.com/acme/rocket", undefined, token))).projects).toEqual([]);
  });
});

describe("project details over MCP", () => {
  it("create_project and update_project set them, and list_projects finds a folder's project by remote", async () => {
    expect((await call("create_project", { name: "Rocket", group: "Acme", repos: ["git@github.com:acme/rocket.git"] })).isError).toBeFalsy();
    await call("create_project", { name: "Side thing" });

    const hit = await call("list_projects", { repo: "https://github.com/acme/rocket" });
    expect(hit.text).toContain("rocket: Rocket");
    expect(hit.text).toContain("group Acme");
    expect(hit.text).not.toContain("side-thing");
    const miss = await call("list_projects", { repo: "github.com/acme/elsewhere" });
    expect(miss.text).toContain("update_project");

    const upd = await call("update_project", { project: "side-thing", status: "archived", group: "Personal", repos: ["github.com/me/side"] });
    expect(upd.text).toContain("archived");
    expect((await call("list_projects", { repo: "github.com/me/side" })).text).toContain("side-thing");
    expect((await call("update_project", { project: "side-thing" })).isError).toBe(true);
    expect((await call("update_project", { project: "side-thing", repos: ["not a repo"] })).isError).toBe(true);
  });

  it("show_projects carries each project's group and status for the board", async () => {
    await call("create_project", { name: "Rocket", group: "Acme" });
    await call("create_project", { name: "Old thing", group: "Acme", status: "archived" });
    const res = await call("show_projects");
    const board = res.structuredContent as { projects: { slug: string; group: string; status: string }[] };
    expect(board.projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: "rocket", group: "Acme", status: "active" }),
        expect.objectContaining({ slug: "old-thing", group: "Acme", status: "archived" }),
      ]),
    );
    expect(res.text).toContain("archived");
  });

  it("choose_projects shows the map with suggestions and asks the agent to wait for corrections", async () => {
    await call("create_project", { name: "Rocket" });
    const candidates = [
      { name: "Rocket", group: "Acme", repos: ["github.com/acme/rocket", "github.com/acme/rocket-site"], checkouts: 3, suggest: "bring_in", reason: "40 sessions this month", existing: "rocket" },
      { name: "Lander", group: "Acme", suggest: "brief", reason: "paused since October" },
      { name: "someone-elses-tool", group: "Other", suggest: "skip", reason: "cloned, never worked in" },
    ];
    const res = await call("choose_projects", { candidates });
    expect(res.structuredContent).toMatchObject({ kind: "picker", candidates, existing: [{ slug: "rocket", name: "Rocket" }] });
    expect(res.text).toContain("Acme / Lander: brief (paused since October)");
    expect(res.text).toContain("corrections");
    expect((await call("choose_projects", { candidates: [{ name: "x", suggest: "maybe" }] })).isError).toBe(true);
  });
});

describe("the in-chat map", () => {
  it("draws three choices per project, a box for corrections, and groups the board", () => {
    // The panel's script is one string; check the parts that carry the behaviour are in it.
    expect(APP_HTML).toContain("Here is the work I found. Is this right?");
    expect(APP_HTML).toContain('["bring_in", "Bring in"], ["brief", "One line"], ["skip", "Skip"]');
    expect(APP_HTML).toContain("Anything to correct?");
    expect(APP_HTML).toContain("Set up Anywhere with this map of my work.");
    expect(APP_HTML).toContain('el("summary", "", archived.length + " archived")');
    // Everything it draws from the agent's list is set as text.
    const view = APP_HTML.slice(APP_HTML.indexOf("function picker"));
    expect(view.slice(0, view.indexOf("var VIEWS"))).not.toContain("innerHTML");
  });
});
