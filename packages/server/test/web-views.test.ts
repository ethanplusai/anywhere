import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lineDiff } from "../src/web/render.js";
import { BASE, csrfFrom, makeTestApp, signIn, type TestApp } from "./helpers.js";

let t: TestApp;
let cookie: string;
beforeEach(async () => {
  t = await makeTestApp();
  cookie = await signIn(t);
});
afterEach(async () => {
  await t.close();
});

function post(body: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE, cookie },
    body: new URLSearchParams(body).toString(),
    redirect: "manual",
  };
}
const page = async (path: string) => (await t.fetch(path, { headers: { cookie } })).text();

describe("projects in the browser", () => {
  it("creates a project from the web, recorded as the person", async () => {
    const form = await page("/projects/new");
    const res = await t.fetch("/projects", post({ _csrf: csrfFrom(form), name: "Acme rebrand", description: "Identity work" }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/projects/acme-rebrand?done=project-created");
    const view = await page("/projects/acme-rebrand");
    expect(view).toContain("Acme rebrand");
    expect(view).toContain("overview.md");
    const history = await page("/projects/acme-rebrand/history/decisions.md");
    expect(history).toContain("You");
  });

  it("edits a page, keeps history with a diff, and says which agent wrote what", async () => {
    await t.api("POST", "/projects", { name: "Acme rebrand" });
    await t.api("PUT", "/projects/acme-rebrand/pages/decisions.md", { content: "# Decisions\n\n- one\n", baseVersion: 1 });
    const edit = await page("/projects/acme-rebrand/edit/decisions.md");
    expect(edit).toContain('name="baseVersion" value="2"');
    const res = await t.fetch("/projects/acme-rebrand/edit/decisions.md", post({ _csrf: csrfFrom(edit), baseVersion: "2", content: "# Decisions\n\n- one\n- two\n" }));
    expect(res.status).toBe(302);
    const history = await page("/projects/acme-rebrand/history/decisions.md?v=3");
    expect(history).toContain('Token “test”');
    expect(history).toContain('class="add" data-s="+">- two');
  });

  it("saves a page at the size limit from the editor, though form encoding makes the request far larger", async () => {
    await t.api("POST", "/projects", { name: "Acme rebrand" });
    const edit = await page("/projects/acme-rebrand/edit/ideas.md");
    const content = "# Ideas\n\n" + "é".repeat(120_000) + "\n"; // about 240 KiB as a page, about 720 KiB as a form
    const res = await t.fetch("/projects/acme-rebrand/edit/ideas.md", post({ _csrf: csrfFrom(edit), baseVersion: "1", content }));
    expect(res.status).toBe(302);
    // Other forms keep the small limit.
    const big = await t.fetch("/account/password", post({ _csrf: csrfFrom(edit), junk: "x".repeat(100_000) }));
    expect(big.status).toBe(413);
  });

  it("keeps the person's text when an agent changed the page meanwhile", async () => {
    await t.api("POST", "/projects", { name: "Acme rebrand" });
    const edit = await page("/projects/acme-rebrand/edit/ideas.md");
    await t.api("PUT", "/projects/acme-rebrand/pages/ideas.md", { content: "# Ideas\n\n- agent idea\n", baseVersion: 1 });
    const res = await t.fetch("/projects/acme-rebrand/edit/ideas.md", post({ _csrf: csrfFrom(edit), baseVersion: "1", content: "my unsaved text" }));
    expect(res.status).toBe(409);
    const body = await res.text();
    expect(body).toContain("my unsaved text");
    expect(body).toContain("changed this page while you were editing");
    expect(body).toContain('name="baseVersion" value="2"');
  });

  it("restores an old version as a new one", async () => {
    await t.api("POST", "/projects", { name: "Acme rebrand" });
    await t.api("PUT", "/projects/acme-rebrand/pages/ideas.md", { content: "# Ideas\n\n- newer\n", baseVersion: 1 });
    const hist = await page("/projects/acme-rebrand/history/ideas.md?v=1");
    const res = await t.fetch("/projects/acme-rebrand/restore/1/ideas.md", post({ _csrf: csrfFrom(hist), baseVersion: "2" }));
    expect(res.status).toBe(302);
    const r = await t.api("GET", "/projects/acme-rebrand/pages/ideas.md");
    const { page: p } = (await r.json()) as { page: { version: number; content: string } };
    expect(p.version).toBe(3);
    expect(p.content).not.toContain("newer");
  });

  it("creates and deletes a topic page", async () => {
    await t.api("POST", "/projects", { name: "Acme rebrand" });
    const form = await page("/projects/acme-rebrand/new-page");
    const res = await t.fetch("/projects/acme-rebrand/new-page", post({ _csrf: csrfFrom(form), name: "pricing", content: "# Pricing\n" }));
    expect(res.headers.get("location")).toBe("/projects/acme-rebrand/pages/topics/pricing.md?done=created");
    const confirm = await page("/projects/acme-rebrand/delete-page/topics/pricing.md");
    const del = await t.fetch("/projects/acme-rebrand/delete-page/topics/pricing.md", post({ _csrf: csrfFrom(confirm), baseVersion: "1" }));
    expect(del.status).toBe(302);
    expect((await t.api("GET", "/projects/acme-rebrand/pages/topics/pricing.md")).status).toBe(404);
  });

  it("searches across projects and escapes snippets", async () => {
    await t.api("POST", "/projects", { name: "Acme rebrand" });
    await t.api("PUT", "/projects/acme-rebrand/pages/ideas.md", { content: "# Ideas\n\n- the <b>typeface</b> question\n", baseVersion: 1 });
    const html = await page("/search?q=typeface");
    expect(html).toContain("<mark>typeface</mark>");
    expect(html).not.toContain("<b>typeface");
  });

  it("shows recent changes on the projects page", async () => {
    await t.api("POST", "/projects", { name: "Acme rebrand" });
    const html = await page("/projects");
    expect(html).toContain("Recent changes");
    expect(html).toContain("Acme rebrand");
  });
});

describe("assets", () => {
  it("serves the script and fonts, and pages allow only this server's script", async () => {
    const js = await t.fetch("/assets/app.js");
    expect(js.headers.get("content-type")).toContain("javascript");
    expect((await t.fetch("/assets/geist.woff2")).headers.get("content-type")).toBe("font/woff2");
    expect((await t.fetch("/assets/other.js")).status).toBe(404);
    const res = await t.fetch("/projects", { headers: { cookie } });
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
  });
});

describe("lineDiff", () => {
  it("marks added and removed lines", () => {
    const ops = lineDiff("a\nb\nc", "a\nc\nd")!;
    expect(ops.map((o) => o.s + o.line)).toEqual([" a", "-b", " c", "+d"]);
  });
});

describe("onboarding", () => {
  it("walks a new account through the four steps, ticking off what is done", async () => {
    let html = await page("/welcome");
    expect(html).toContain("Connect Claude Code");
    expect(html).toContain("claude mcp add --scope user --transport http anywhere");
    expect(html).toContain("/skill/anywhere.tar.gz | tar -xz -C ~/.claude/skills");
    expect(html).toContain("Set up Anywhere.");
    expect(html).toContain('class="iso-scene scene-connect"');
    expect(html.match(/ob-badge ob-todo/g)).toHaveLength(2);
    await t.api("POST", "/projects", { name: "Acme rebrand" });
    html = await page("/welcome");
    expect(html).toContain("1 project");
    expect(html).toContain("Pick up where we left off on Acme rebrand in Anywhere.");
  });

  it("serves the skill as a tarball of the files in skill/anywhere", async () => {
    const res = await t.fetch("/skill/anywhere.tar.gz");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/gzip");
    const { gunzipSync, strFromU8 } = await import("fflate");
    const tar = strFromU8(gunzipSync(new Uint8Array(await res.arrayBuffer())), true);
    expect(tar).toContain("anywhere/SKILL.md");
    expect(tar).toContain("anywhere/scripts/find-projects.mjs");
    expect(tar).toContain("name: anywhere");
  });
});
