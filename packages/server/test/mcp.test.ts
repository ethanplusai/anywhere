import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BASE, makeTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
let client: Client;
let lastTransport: StreamableHTTPClientTransport;

async function connect(token: string): Promise<Client> {
  const c = new Client({ name: "test-client", version: "1.0.0" });
  const transport = (lastTransport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    fetch: (url, init) => t.fetch(String(url), init),
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  await c.connect(transport);
  return c;
}

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };
async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult & { text: string }> {
  const res = (await client.callTool({ name, arguments: args })) as ToolResult;
  return { ...res, text: res.content.map((c) => c.text).join("\n") };
}

beforeEach(async () => {
  t = await makeTestApp();
  client = await connect(t.token);
});
afterEach(async () => {
  await client.close();
  await t.close();
});

describe("MCP endpoint", () => {
  it("negotiates the 2025-11-25 protocol and gives self-contained instructions", async () => {
    expect(lastTransport.protocolVersion).toBe("2025-11-25");
    const instructions = client.getInstructions() ?? "";
    const head = instructions.slice(0, 512);
    expect(head).toContain("get_project");
    expect(head).toContain("overview.md");
    expect(head).toContain("base_version");
    expect(head).toContain("log.md");
    // The first 512 characters end on a sentence, not mid-word.
    expect(instructions.length <= 512 || /[.)]\s/.test(instructions.slice(480, 515))).toBe(true);
    expect(client.getServerVersion()?.name).toBe("anywhere");
  });

  it("lists the fourteen tools with read-only hints on the read tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((x) => x.name).sort()).toEqual(
      ["append_to_page", "choose_projects", "create_project", "delete_page", "get_project", "guide", "list_projects", "read_page", "resume", "search", "show_page", "show_project", "show_projects", "write_page"],
    );
    const byName = Object.fromEntries(tools.map((x) => [x.name, x]));
    for (const name of ["guide", "list_projects", "get_project", "read_page", "resume", "search", "show_project", "show_projects", "show_page", "choose_projects"]) {
      expect(byName[name]!.annotations?.readOnlyHint).toBe(true);
    }
    for (const name of ["create_project", "write_page", "append_to_page", "delete_page"]) {
      expect(byName[name]!.annotations?.readOnlyHint).toBe(false);
    }
    expect(byName.delete_page!.annotations?.destructiveHint).toBe(true);
    expect(byName.guide!.description).toMatch(/once/i);
    expect(byName.write_page!.description).toContain("base_version");
    expect(byName.write_page!.description).toMatch(/merge/i);
    expect(byName.get_project!.description).toContain("overview.md");
  });

  it("guide returns the layout and rules from docs/layout.md", async () => {
    const res = await call("guide");
    expect(res.text).toContain("## Rules");
    expect(res.text).toContain("topics/<slug>.md");
  });

  it("runs the whole project and page lifecycle", async () => {
    const created = await call("create_project", { name: "Acme Rebrand", description: "The rebrand." });
    expect(created.isError).toBeFalsy();
    expect(created.text).toContain("acme-rebrand");

    const taken = await call("create_project", { name: "Acme Rebrand" });
    expect(taken.isError).toBe(true);
    expect(taken.text).toContain("slug_taken");

    const list = await call("list_projects");
    expect(list.text).toContain("acme-rebrand");
    expect(list.text).toContain("The rebrand.");

    const project = await call("get_project", { project: "acme-rebrand" });
    expect(project.text).toContain("decisions.md");
    expect(project.text).toContain("# Decisions"); // first line
    expect(project.text).toContain("_What the project is"); // overview.md in full

    const read = await call("read_page", { project: "acme-rebrand", path: "decisions.md" });
    expect(read.text).toContain("version 1");

    const written = await call("write_page", {
      project: "acme-rebrand",
      path: "decisions.md",
      content: "# Decisions\n\n- 2026-11-22: Two-tier price. Simpler to sell.\n",
      base_version: 1,
    });
    expect(written.isError).toBeFalsy();
    expect(written.text).toContain("version 2");

    const created2 = await call("write_page", { project: "acme-rebrand", path: "topics/pricing.md", content: "# Pricing\n" });
    expect(created2.isError).toBeFalsy();

    const appended = await call("append_to_page", { project: "acme-rebrand", path: "log.md", content: "2026-11-22: set prices." });
    expect(appended.isError).toBeFalsy();

    const found = await call("search", { query: "two-tier" });
    expect(found.text).toContain("acme-rebrand");
    expect(found.text).toContain("decisions.md");
    const scoped = await call("search", { query: "two-tier", project: "acme-rebrand" });
    expect(scoped.text).toContain("decisions.md");

    const del = await call("delete_page", { project: "acme-rebrand", path: "topics/pricing.md", base_version: 1 });
    expect(del.isError).toBeFalsy();
    const delStd = await call("delete_page", { project: "acme-rebrand", path: "log.md", base_version: 2 });
    expect(delStd.isError).toBe(true);
    expect(delStd.text).toMatch(/standard page/);
  });

  it("returns a conflict with the current version and full content, never overwriting", async () => {
    await call("create_project", { name: "P" });
    await call("write_page", { project: "p", path: "ideas.md", content: "Theirs: idea A\n", base_version: 1 });

    const stale = await call("write_page", { project: "p", path: "ideas.md", content: "Mine", base_version: 1 });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain("version 2");
    expect(stale.text).toContain("Theirs: idea A");
    expect(stale.text).toMatch(/merge/i);
    expect(stale.text).toContain("base_version");

    const noBase = await call("write_page", { project: "p", path: "ideas.md", content: "Mine" });
    expect(noBase.isError).toBe(true);
    expect(noBase.text).toContain("Theirs: idea A");

    expect((await call("read_page", { project: "p", path: "ideas.md" })).text).toContain("Theirs: idea A");
  });

  it("reports validation and missing-project errors as tool errors", async () => {
    const bad = await call("read_page", { project: "nope", path: "overview.md" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("list_projects");
    await call("create_project", { name: "P" });
    const badPath = await call("write_page", { project: "p", path: "Topics/X.md", content: "x" });
    expect(badPath.isError).toBe(true);
    expect(badPath.text).toContain("invalid_path");
    const missing = await call("append_to_page", { project: "p", path: "topics/none.md", content: "x" });
    expect(missing.isError).toBe(true);
  });
});

describe("MCP auth", () => {
  it("401s without a token with the protected-resource WWW-Authenticate header", async () => {
    const res = await t.fetch("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it("401s with a revoked or unknown token", async () => {
    const res = await t.fetch("/mcp", {
      method: "POST",
      headers: { authorization: "Bearer nope", "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
  });
});

describe("resume", () => {
  it("briefs an agent from the plan, decisions, questions and log, with who changed what", async () => {
    await call("create_project", { name: "Acme rebrand" });
    const plan = [
      "# Plan",
      "",
      "## Goal",
      "Launch the new site on 3 March.",
      "",
      "## Phases",
      "- [x] Phase 1: identity",
      "- [ ] Phase 2: site build",
      "",
      "## Now",
      "- Building the repair page on branch site/repair.",
      "",
      "## Next",
      "1. Wire the repair counter to the CMS field `repairs_total`.",
      "",
      "## Blocked",
      "- Nothing.",
      "",
    ].join("\n");
    await call("write_page", { project: "acme-rebrand", path: "plan.md", content: plan, base_version: 1 });
    await call("write_page", { project: "acme-rebrand", path: "decisions.md", content: "# Decisions\n\n- 2026-11-21: Repair page gets its own page.\n", base_version: 1 });
    await call("append_to_page", { project: "acme-rebrand", path: "log.md", content: "- 2026-11-22: Drafted the repair page." });
    const r = await call("resume", { project: "acme-rebrand" });
    const out = r.text;
    expect(out).toContain("BEGIN PAGE CONTENT");
    expect(out).toContain("Goal: Launch the new site on 3 March.");
    expect(out).toContain("Phases: 1 of 2 done; next: Phase 2: site build");
    expect(out).toContain("repairs_total");
    expect(out).toContain("Repair page gets its own page");
    expect(out).toContain("Drafted the repair page");
    expect(out).toContain("plan.md version 2");
    expect(out).toContain("start from Next in plan.md");
  });

  it("says when the plan has not been filled in", async () => {
    await call("create_project", { name: "Empty" });
    const out = (await call("resume", { project: "empty" })).text;
    expect(out).toContain("(not filled in yet)");
    expect(out).toContain("plan.md is still empty");
  });
});

describe("panels a chat app can draw", () => {
  type Structured = { structuredContent?: Record<string, unknown> };

  it("names one page for every panel tool, and serves it as one self-contained document", async () => {
    const { tools } = await client.listTools();
    for (const name of ["show_projects", "show_project", "show_page", "choose_projects"]) {
      const meta = tools.find((x) => x.name === name)!._meta as { ui: { resourceUri: string }; "ui/resourceUri": string };
      expect(meta.ui.resourceUri).toBe("ui://anywhere/app.html");
      expect(meta["ui/resourceUri"]).toBe(meta.ui.resourceUri);
    }
    const { contents } = await client.readResource({ uri: "ui://anywhere/app.html" });
    const doc = contents[0] as { mimeType: string; text: string };
    expect(doc.mimeType).toBe("text/html;profile=mcp-app");
    expect(doc.text.startsWith("<!doctype html>")).toBe(true);
    // The default sandbox allows no outside requests, so the page makes none.
    expect(doc.text).not.toMatch(/https?:\/\//);
    expect(doc.text).not.toMatch(/<(?:link|img|iframe)\b|\bsrc=|url\(/);
    // Markup is set in exactly one place, for a page body the server has already sanitised.
    expect(doc.text.match(/innerHTML/g)).toHaveLength(1);
    expect(doc.text).toContain("prose.innerHTML = d.html");
    expect(doc.text).not.toMatch(/insertAdjacentHTML|document\.write|\beval\(|new Function/);
    expect(doc.text).toContain("ui/initialize");
    expect(doc.text).toContain("ui/notifications/initialized");
  });

  it("show_projects lists every project with its latest changes, and says so when there are none", async () => {
    const empty = (await client.callTool({ name: "show_projects", arguments: {} })) as ToolResult & Structured;
    expect(empty.content[0]!.text).toContain("No projects yet");
    expect(empty.structuredContent).toMatchObject({ kind: "board", projects: [] });
    await call("create_project", { name: "Acme rebrand", description: "New identity" });
    await call("append_to_page", { project: "acme-rebrand", path: "log.md", content: "- 2026-11-24 Started." });
    const res = (await client.callTool({ name: "show_projects", arguments: {} })) as ToolResult & Structured;
    expect(res.content[0]!.text).toContain("acme-rebrand: Acme rebrand (New identity)");
    const d = res.structuredContent as { url: string; projects: { slug: string; pages: number }[]; recent: { path: string; action: string }[] };
    expect(d.url).toBe(`${BASE}/projects`);
    expect(d.projects[0]).toMatchObject({ slug: "acme-rebrand", name: "Acme rebrand", description: "New identity" });
    expect(d.projects[0]!.pages).toBeGreaterThan(0);
    expect(d.recent[0]).toMatchObject({ path: "log.md", action: "added to" });
  });

  it("show_page hands the panel sanitised markup and the agent the page as text", async () => {
    await call("create_project", { name: "Acme rebrand" });
    await call("write_page", {
      project: "acme-rebrand",
      path: "ideas.md",
      base_version: 1,
      content: '# Ideas\n\n- A [link](https://example.com) and <script>alert(1)</script> <b onclick="x()">bold</b> [bad](javascript:x)\n',
    });
    const res = (await client.callTool({ name: "show_page", arguments: { project: "acme-rebrand", path: "ideas.md" } })) as ToolResult & Structured;
    expect(res.content[0]!.text).toContain("BEGIN PAGE CONTENT");
    const d = res.structuredContent as { kind: string; html: string; url: string; version: number; project: { name: string } };
    expect(d).toMatchObject({ kind: "page", version: 2, url: `${BASE}/projects/acme-rebrand/pages/ideas.md`, project: { name: "Acme rebrand" } });
    expect(d.html).toContain('href="https://example.com"');
    expect(d.html).not.toMatch(/<script|onclick|javascript:/);
    expect((await call("show_page", { project: "acme-rebrand", path: "topics/none.md" })).isError).toBe(true);
  });

  it("show_project gives the card its data and the agent the same briefing as text", async () => {
    await call("create_project", { name: "Acme rebrand" });
    await call("write_page", {
      project: "acme-rebrand",
      path: "plan.md",
      base_version: 1,
      content: "# Plan\n\n## Goal\nShip the new brand.\n\n## Phases\n- [x] Research\n- [ ] Design\n\n## Now\n- Logo options <b>bold</b>\n\n## Next\n- Type scale\n\n## Blocked\nWaiting on legal.\n",
    });
    await call("append_to_page", { project: "acme-rebrand", path: "decisions.md", content: "- 2026-11-20 Cobalt is the brand colour, for contrast." });
    const res = (await client.callTool({ name: "show_project", arguments: { project: "acme-rebrand" } })) as ToolResult & Structured;
    const text = res.content.map((c) => c.text).join("\n");
    expect(text).toContain("BEGIN PAGE CONTENT");
    expect(text).toContain("Logo options");
    const d = res.structuredContent as {
      kind: string;
      project: { name: string; slug: string; url: string };
      plan: { filled: boolean; goal: string; done: number; total: number; now: string[]; next: string[]; blocked: string[] };
      decisions: string[];
      changes: { path: string; who: string }[];
      pages: { path: string }[];
    };
    expect(d.kind).toBe("project");
    expect(d.project).toMatchObject({ name: "Acme rebrand", slug: "acme-rebrand", url: `${BASE}/projects/acme-rebrand` });
    expect(d.plan).toMatchObject({ filled: true, goal: "Ship the new brand.", done: 1, total: 2, next: ["Type scale"], blocked: ["Waiting on legal."] });
    // Page text is passed through as text; the page sets it as text, so markup in it is inert.
    expect(d.plan.now).toEqual(["Logo options <b>bold</b>"]);
    expect(d.decisions[0]).toContain("Cobalt");
    expect(d.changes.length).toBeGreaterThan(0);
    expect(d.pages.map((x) => x.path)).toContain("plan.md");
    expect((await call("show_project", { project: "nope" })).isError).toBe(true);
  });

  it("show_project says so when the plan has not been written", async () => {
    await call("create_project", { name: "Empty one" });
    const res = (await client.callTool({ name: "show_project", arguments: { project: "empty-one" } })) as Structured;
    expect((res.structuredContent as { plan: { filled: boolean; now: string[] } }).plan).toMatchObject({ filled: false, now: [] });
  });

  it("choose_projects passes the list through, marks what is already there, and tells the agent to wait", async () => {
    await call("create_project", { name: "Acme rebrand" });
    const candidates = [
      { name: "Acme rebrand", path: "~/Projects/acme", last_active: "2026-11-20", group: "Acme" },
      { name: "Side project", note: "README, CLAUDE.md" },
    ];
    const res = (await client.callTool({ name: "choose_projects", arguments: { candidates } })) as ToolResult & Structured;
    const text = res.content.map((c) => c.text).join("\n");
    expect(text).toContain("wait for their reply");
    expect(text).toContain("- Side project");
    expect(text).toContain("acme-rebrand");
    expect(res.structuredContent).toMatchObject({ kind: "picker", candidates, existing: [{ slug: "acme-rebrand", name: "Acme rebrand" }] });
    // An empty or oversized list is refused before anything is shown.
    expect(((await client.callTool({ name: "choose_projects", arguments: { candidates: [] } })) as ToolResult).isError).toBe(true);
  });
});
