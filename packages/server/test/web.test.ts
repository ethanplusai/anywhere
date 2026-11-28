import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { section } from "../src/mcp/briefing.js";
import { renderMarkdown } from "../src/web/render.js";
import { BASE, codeFor, cookiesFrom, csrfFrom, makeTestApp, signIn, type TestApp } from "./helpers.js";

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
  const xff = (body: Record<string, string>, ip: string, cookie?: string): RequestInit => ({
    ...form(body, cookie),
    headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE, "x-forwarded-for": ip, ...(cookie ? { cookie } : {}) },
  });

  it("signs up with an emailed code, lands on the welcome page, and signs out", async () => {
    const sent = await t.fetch("/signin", form({ email: "new@example.com" }));
    expect(sent.status).toBe(303);
    expect(sent.headers.get("location")).toBe("/signin/code");
    let jar = cookiesFrom(sent);
    const mail = t.mailer.last("new@example.com")!;
    expect(mail.subject).toMatch(/^Your Anywhere code: \d{6}$/);
    expect(mail.html).not.toMatch(/supabase|vercel/i);
    const page = await (await t.fetch("/signin/code", { headers: { cookie: jar } })).text();
    expect(page).toContain("new@example.com");

    const res = await t.fetch("/signin/code", form({ code: codeFor(t, "new@example.com") }, jar));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/welcome");
    const setCookie = res.headers.getSetCookie().find((c) => c.includes("anywr_session="))!;
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Secure/i);
    jar = cookiesFrom(res, jar);
    const [row] = await t.db.query<{ email_verified_at: Date | null }>("SELECT email_verified_at FROM users WHERE email = 'new@example.com'");
    expect(row!.email_verified_at).not.toBeNull();
    expect(await (await t.fetch("/projects", { headers: { cookie: jar } })).text()).toContain("shared memory starts here");

    const account = await (await t.fetch("/account", { headers: { cookie: jar } })).text();
    expect(account).not.toContain('type="password"');
    const out = await t.fetch("/signout", form({ _csrf: csrfFrom(account) }, jar));
    expect(out.status).toBe(302);
    const after = await t.fetch("/projects", { headers: { cookie: jar }, redirect: "manual" });
    expect(after.headers.get("location")).toBe("/signin?next=%2Fprojects");
  });

  it("answers the same whether or not an address has an account", async () => {
    const gated = await makeTestApp({ ANYWHERE_SIGNUPS: "approved", ANYWHERE_EARLY_ACCESS_URL: "https://anywr.ai/early-access" });
    try {
      const results = [];
      for (const email of ["me@example.com", "stranger@example.com"]) {
        const res = await gated.fetch("/signin", form({ email }));
        results.push([res.status, res.headers.get("location")]);
      }
      expect(results[0]).toEqual(results[1]);
      expect(gated.mailer.last("me@example.com")!.subject).toContain("sign-in code");
      const stranger = gated.mailer.last("stranger@example.com")!;
      expect(stranger.subject).toBe("About signing in to Anywhere");
      expect(stranger.text).toContain("https://anywr.ai/early-access");
      expect(stranger.text).not.toMatch(/\b\d{6}\b/);
    } finally {
      await gated.close();
    }
  });

  it("refuses a wrong code with the tries left, and ends after five", async () => {
    const sent = await t.fetch("/signin", form({ email: "me@example.com" }));
    const jar = cookiesFrom(sent);
    const code = codeFor(t, "me@example.com");
    const wrong = code === "000000" ? "111111" : "000000";
    const first = await t.fetch("/signin/code", form({ code: wrong }, jar));
    expect(first.status).toBe(400);
    expect(await first.text()).toContain("4 tries left");
    for (let i = 0; i < 4; i++) await t.fetch("/signin/code", form({ code: wrong }, jar));
    const late = await t.fetch("/signin/code", form({ code }, jar));
    expect(late.status).not.toBe(302);
  });

  it("a code only works in the browser that asked for it", async () => {
    await t.fetch("/signin", form({ email: "me@example.com" }));
    const elsewhere = await t.fetch("/signin/code", form({ code: codeFor(t, "me@example.com") }));
    expect(elsewhere.status).toBe(303);
    expect(elsewhere.headers.get("location")).toBe("/signin?m=expired");
  });

  it("the emailed link shows a button first, then signs in once on any device", async () => {
    await t.fetch("/signin", form({ email: "me@example.com", next: "/tokens" }));
    const link = /https:\/\/anywr\.test(\/signin\/link\?t=[A-Za-z0-9_-]+)/.exec(t.mailer.last("me@example.com")!.text)![1]!;
    const opened = await t.fetch(link);
    expect(opened.status).toBe(200);
    expect(opened.headers.getSetCookie().some((c) => c.includes("anywr_session="))).toBe(false);
    const token = new URL(link, BASE).searchParams.get("t")!;
    const used = await t.fetch("/signin/link", form({ t: token }));
    expect(used.status).toBe(302);
    expect(used.headers.get("location")).toBe("/tokens");
    expect((await t.fetch("/signin/link", form({ t: token }))).status).toBe(400);
  });

  it("refuses cross-site sign-in posts", async () => {
    for (const path of ["/signin", "/signin/code", "/signin/link"]) {
      expect((await t.fetch(path, form({ email: "me@example.com", code: "123456", t: "x" }, undefined, "https://evil.example"))).status, path).toBe(403);
    }
    expect(t.mailer.sent).toHaveLength(0);
  });

  it("only follows same-site next destinations after sign-in", async () => {
    for (const [next, expected] of [["/tokens", "/tokens"], ["https://evil.example", "/projects"], ["//evil.example", "/projects"], ["/\\evil.example", "/projects"], ["/\t/evil.example", "/projects"]] as const) {
      const sent = await t.fetch("/signin", xff({ email: "me@example.com", next }, "10.1.1.1"));
      const res = await t.fetch("/signin/code", form({ code: codeFor(t, "me@example.com") }, cookiesFrom(sent)));
      expect(res.headers.get("location"), next).toBe(expected);
    }
  });

  it("closes sign-ups when ANYWHERE_DISABLE_SIGNUPS is set", async () => {
    const closed = await makeTestApp({ ANYWHERE_DISABLE_SIGNUPS: "1" });
    try {
      expect((await closed.fetch("/signup")).status).toBe(403);
      const res = await closed.fetch("/signin", form({ email: "new@example.com" }));
      expect(res.status).toBe(303);
      expect(closed.mailer.sent).toHaveLength(0);
      expect(await (await closed.fetch("/signin")).text()).not.toContain("Create an account");
      expect(closed.mailer.sent).toHaveLength(0);
    } finally {
      await closed.close();
    }
  });

  it("sends at most five codes an hour to one address", async () => {
    for (let i = 0; i < 5; i++) expect((await t.fetch("/signin", xff({ email: "me@example.com" }, `10.2.0.${i}`))).status).toBe(303);
    const sixth = await t.fetch("/signin", xff({ email: "ME@example.com" }, "10.2.0.9"));
    expect(sixth.status).toBe(429);
    expect(t.mailer.sent).toHaveLength(5);
  });

  it("does not believe X-Forwarded-For unless told to trust the proxy", async () => {
    const limited = await makeTestApp({ ANYWHERE_AUTH_RATE_LIMIT: "2" });
    try {
      for (let i = 0; i < 2; i++) await limited.fetch("/signin", xff({ email: `a${i}@example.com` }, `10.0.0.${i}`));
      expect((await limited.fetch("/signin", xff({ email: "b@example.com" }, "10.0.0.99"))).status).toBe(429);
    } finally {
      await limited.close();
    }
    const trusting = await makeTestApp({ ANYWHERE_AUTH_RATE_LIMIT: "2", ANYWHERE_TRUST_PROXY: "1" });
    try {
      for (let i = 0; i < 2; i++) await trusting.fetch("/signin", xff({ email: `a${i}@example.com` }, "10.0.0.1"));
      expect((await trusting.fetch("/signin", xff({ email: "b@example.com" }, "10.0.0.2"))).status).toBe(303);
    } finally {
      await trusting.close();
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
