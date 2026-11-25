import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { section } from "../src/mcp/briefing.js";
import { renderMarkdown } from "../src/web/render.js";
import { BASE, csrfFrom, makeTestApp, signIn, type TestApp } from "./helpers.js";

let t: TestApp;
beforeEach(async () => {
  t = await makeTestApp();
});
afterEach(async () => {
  await t.close();
});

function form(body: Record<string, string>, cookie?: string, origin = BASE): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin, ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(body).toString(),
    redirect: "manual",
  };
}

describe("accounts", () => {
  it("signs up, lands on the project list, and signs out", async () => {
    const res = await t.fetch("/signup", form({ email: "new@example.com", password: "a long password" }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/welcome");
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/anywr_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Secure/i);
    const cookie = setCookie.split(";")[0]!;
    const page = await t.fetch("/projects", { headers: { cookie } });
    const text = await page.text();
    expect(text).toContain("shared memory starts here");

    const account = await (await t.fetch("/account", { headers: { cookie } })).text();
    const out = await t.fetch("/signout", form({ _csrf: csrfFrom(account) }, cookie));
    expect(out.status).toBe(302);
    const after = await t.fetch("/projects", { headers: { cookie }, redirect: "manual" });
    expect(after.status).toBe(302);
    expect(after.headers.get("location")).toBe("/signin?next=%2Fprojects");
  });

  it("refuses duplicate emails, short passwords and wrong passwords with a message", async () => {
    const dup = await t.fetch("/signup", form({ email: "me@example.com", password: "a long password" }));
    expect(dup.status).toBe(409);
    expect(await dup.text()).toContain("already exists");
    const short = await t.fetch("/signup", form({ email: "x@example.com", password: "short" }));
    expect(short.status).toBe(422);
    const wrong = await t.fetch("/signin", form({ email: "me@example.com", password: "nope nope nope" }));
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain("do not match");
  });

  it("refuses cross-site sign-in posts", async () => {
    const res = await t.fetch("/signin", form({ email: "me@example.com", password: "long enough pw" }, undefined, "https://evil.example"));
    expect(res.status).toBe(403);
  });

  it("only follows same-site next destinations after sign-in", async () => {
    const ok = await t.fetch("/signin", form({ email: "me@example.com", password: "long enough pw", next: "/tokens" }));
    expect(ok.headers.get("location")).toBe("/tokens");
    for (const next of ["https://evil.example", "//evil.example", "/\\evil.example", "/\t/evil.example", "/\n/evil.example"]) {
      const res = await t.fetch("/signin", form({ email: "me@example.com", password: "long enough pw", next }));
      expect(res.headers.get("location")).toBe("/projects");
    }
  });

  it("closes sign-ups when ANYWHERE_DISABLE_SIGNUPS is set", async () => {
    const closed = await makeTestApp({ ANYWHERE_DISABLE_SIGNUPS: "1" });
    try {
      expect((await closed.fetch("/signup")).status).toBe(403);
      const res = await closed.fetch("/signup", form({ email: "new@example.com", password: "a long password" }));
      expect(res.status).toBe(403);
      expect((await closed.fetch("/signin")).status).toBe(200);
      expect(await (await closed.fetch("/signin")).text()).not.toContain("Create an account");
    } finally {
      await closed.close();
    }
  });

  it("does not believe X-Forwarded-For unless told to trust the proxy", async () => {
    const limited = await makeTestApp({ ANYWHERE_AUTH_RATE_LIMIT: "2" });
    try {
      for (let i = 0; i < 2; i++) {
        await limited.fetch("/signin", { ...form({ email: "me@example.com", password: "wrong wrong" }), headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE, "x-forwarded-for": `10.0.0.${i}` } });
      }
      const res = await limited.fetch("/signin", { ...form({ email: "me@example.com", password: "long enough pw" }), headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE, "x-forwarded-for": "10.0.0.99" } });
      expect(res.status).toBe(429);
    } finally {
      await limited.close();
    }
    const trusting = await makeTestApp({ ANYWHERE_AUTH_RATE_LIMIT: "2", ANYWHERE_TRUST_PROXY: "1" });
    try {
      for (let i = 0; i < 2; i++) {
        await trusting.fetch("/signin", { ...form({ email: "me@example.com", password: "wrong wrong" }), headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE, "x-forwarded-for": "10.0.0.1" } });
      }
      const other = await trusting.fetch("/signin", { ...form({ email: "me@example.com", password: "long enough pw" }), headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE, "x-forwarded-for": "10.0.0.2" } });
      expect(other.status).toBe(302);
    } finally {
      await trusting.close();
    }
  });

  it("limits sign-in attempts per address", async () => {
    const limited = await makeTestApp({ ANYWHERE_AUTH_RATE_LIMIT: "2" });
    try {
      for (let i = 0; i < 2; i++) await limited.fetch("/signin", form({ email: "me@example.com", password: "wrong wrong" }));
      const res = await limited.fetch("/signin", form({ email: "me@example.com", password: "long enough pw" }));
      expect(res.status).toBe(429);
    } finally {
      await limited.close();
    }
  });
});

describe("project pages", () => {
  let cookie: string;
  beforeEach(async () => {
    cookie = await signIn(t);
    await t.api("POST", "/projects", { name: "Acme <Rebrand>", description: "Rebrand & more" });
  });

  it("lists projects with escaped names", async () => {
    const text = await (await t.fetch("/projects", { headers: { cookie } })).text();
    expect(text).toContain("Acme &lt;Rebrand&gt;");
    expect(text).toContain("Rebrand &amp; more");
    expect(text).not.toContain("<Rebrand>");
  });

  it("shows a project's pages and renders a page's markdown safely", async () => {
    const overview = await t.fetch("/projects/acme-rebrand", { headers: { cookie } });
    const text = await overview.text();
    expect(text).toContain("/projects/acme-rebrand/pages/overview.md");
    expect(overview.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(overview.headers.get("x-frame-options")).toBe("DENY");

    const hostile = [
      "# Title",
      "",
      "<script>alert(1)</script>",
      "[click](javascript:alert(2))",
      '<img src="x" onerror="alert(3)">',
      '<a href="https://ok.example" onclick="alert(4)">ok</a>',
      "<iframe src='https://evil.example'></iframe>",
      "- [x] done",
    ].join("\n");
    await t.api("PUT", "/projects/acme-rebrand/pages/topics/hostile.md", { content: hostile, baseVersion: 0 });
    const page = await (await t.fetch("/projects/acme-rebrand/pages/topics/hostile.md", { headers: { cookie } })).text();
    expect(page).toContain("<h1>Title</h1>");
    expect(page).not.toMatch(/<script>alert/);
    expect(page).not.toContain("javascript:");
    expect(page).not.toContain("onerror");
    expect(page).not.toContain("onclick");
    expect(page).not.toContain("<iframe");
    expect(page).toContain('href="https://ok.example"');
  });

  it("404s other people's projects and missing pages", async () => {
    expect((await t.fetch("/projects/nope", { headers: { cookie } })).status).toBe(404);
    expect((await t.fetch("/projects/acme-rebrand/pages/topics/none.md", { headers: { cookie } })).status).toBe(404);
  });

  it("downloads the zip export", async () => {
    const res = await t.fetch("/projects/acme-rebrand/export.zip", { headers: { cookie } });
    expect(res.headers.get("content-type")).toBe("application/zip");
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(files)).toContain("acme-rebrand/overview.md");
  });
});

describe("tokens page", () => {
  it("creates a token shown once, lists only its name, and revokes it", async () => {
    const cookie = await signIn(t);
    const page = await (await t.fetch("/tokens", { headers: { cookie } })).text();
    const created = await t.fetch("/tokens", form({ _csrf: csrfFrom(page), name: "work-laptop" }, cookie));
    expect(created.headers.get("cache-control")).toContain("no-store");
    const createdText = await created.text();
    const token = /(anywr_[A-Za-z0-9_-]+)/.exec(createdText)![1]!;
    expect((await t.api("GET", "/me", undefined, token)).status).toBe(200);

    const list = await (await t.fetch("/tokens", { headers: { cookie } })).text();
    expect(list).toContain("work-laptop");
    expect(list).not.toContain(token);

    const id = /action="\/tokens\/([^/]+)\/revoke"/.exec(list.split("work-laptop")[1]!)![1]!;
    const revoke = await t.fetch(`/tokens/${id}/revoke`, form({ _csrf: csrfFrom(list) }, cookie));
    expect(revoke.status).toBe(302);
    expect((await t.api("GET", "/me", undefined, token)).status).toBe(401);
  });

  it("refuses token creation without the CSRF token", async () => {
    const cookie = await signIn(t);
    const res = await t.fetch("/tokens", form({ name: "x" }, cookie));
    expect(res.status).toBe(403);
    const bad = await t.fetch("/tokens", form({ name: "x", _csrf: "0".repeat(64) }, cookie));
    expect(bad.status).toBe(403);
  });
});

describe("connect page", () => {
  it("shows the MCP URL and steps for Claude, Claude Code and ChatGPT", async () => {
    const cookie = await signIn(t);
    const text = await (await t.fetch("/connect", { headers: { cookie } })).text();
    expect(text).toContain(`${BASE}/mcp`);
    expect(text).toContain(`claude mcp add --transport http anywhere ${BASE}/mcp`);
    expect(text).toContain("ChatGPT");
    expect(text).toContain("Add custom connector");
  });

  it("serves a health check", async () => {
    expect(await (await t.fetch("/healthz")).json()).toEqual({ ok: true });
  });
});

describe("renderMarkdown", () => {
  it("drops raw HTML handlers and unsafe schemes", () => {
    const out = renderMarkdown('[a](javascript:x) <b onclick="x">b</b> ![i](http://insecure.example/i.png) [m](mailto:a@b.c)');
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("http://insecure.example");
    expect(out).toContain('href="mailto:a@b.c"');
    expect(out).toContain('rel="nofollow noopener noreferrer"');
  });

  it("gives up on a page that would hold the server, shows it as written, and remembers", () => {
    const slow = "_a_".repeat(20_000) + "<script>x</script>";
    let t = Date.now();
    const out = renderMarkdown(slow);
    expect(Date.now() - t).toBeLessThan(3000);
    expect(out).toContain("shown as written");
    expect(out).toContain("&lt;script&gt;");
    expect(out).not.toContain("<script>");
    t = Date.now();
    expect(renderMarkdown(slow)).toBe(out);
    expect(Date.now() - t).toBeLessThan(200);
  });

  it("shows a page nested too deeply for the parser as written instead of failing", () => {
    expect(renderMarkdown(">".repeat(50_000) + " x")).toContain("shown as written");
  });

  it("still formats a full-size ordinary page", () => {
    const unit = "## Heading\n\nSome *text* with `code` and a [link](https://example.com).\n\n- one\n- two\n\n";
    const out = renderMarkdown(unit.repeat(Math.floor((256 * 1024) / unit.length)));
    expect(out).not.toContain("shown as written");
    expect(out).toContain("<h2>Heading</h2>");
  });
});

describe("section", () => {
  it("finds a heading whatever the spaces after it, in time that does not blow up on a long line", () => {
    expect(section("# Plan\n\n## Now   \n- a\n## Next\n- b", "now")).toBe("- a");
    const t = Date.now();
    expect(section(`# x${" ".repeat(250_000)}y\n## Now\n- a`, "now")).toBe("- a");
    expect(Date.now() - t).toBeLessThan(500);
  });
});
