// Audit 2026-11-23: A3 (revocation, lifetimes), D5 (deletion pages), A8, A9, A11, A12, D6, D9.
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { renderMarkdown } from "../src/web/render.js";
import { BASE, codeFor, cookiesFrom, csrfFrom, makeTestApp, signIn, type TestApp } from "./helpers.js";
import { grant, mcpStatus, tokenRequest } from "./oauth-flow.js";

function post(body: Record<string, string>, cookie?: string, headers: Record<string, string> = { origin: BASE }): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers, ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(body).toString(),
    redirect: "manual",
  };
}

async function page(t: TestApp, path: string, cookie: string): Promise<string> {
  return (await t.fetch(path, { headers: { cookie } })).text();
}

async function withApp(env: Record<string, string>, fn: (t: TestApp) => Promise<void>) {
  const t = await makeTestApp(env);
  try {
    await fn(t);
  } finally {
    await t.close();
  }
}

describe("A3: connected apps can be revoked and expire", () => {
  it("lists a connected app and disconnecting it ends its access and refresh tokens", () =>
    withApp({}, async (t) => {
      const cookie = await signIn(t);
      const g = await grant(t, cookie, "My Agent");
      expect(await mcpStatus(t, g.access)).toBe(200);
      const account = await page(t, "/account/apps", cookie);
      expect(account).toContain("My Agent");
      const family = /action="\/account\/apps\/([^/]+)\/revoke"/.exec(account)![1]!;
      const res = await t.fetch(`/account/apps/${family}/revoke`, post({ _csrf: csrfFrom(account) }, cookie));
      expect(res.status).toBe(302);
      expect(await mcpStatus(t, g.access)).toBe(401);
      const refreshed = await tokenRequest(t, { grant_type: "refresh_token", refresh_token: g.refresh, client_id: g.clientId });
      expect(refreshed.status).toBe(400);
      expect(await page(t, "/account/apps", cookie)).not.toContain("My Agent");
    }));

  it("refuses to revoke without the CSRF token", () =>
    withApp({}, async (t) => {
      const cookie = await signIn(t);
      const g = await grant(t, cookie);
      const [row] = await t.db.query<{ family_id: string }>("SELECT family_id FROM oauth_grants");
      const res = await t.fetch(`/account/apps/${row!.family_id}/revoke`, post({}, cookie));
      expect(res.status).toBe(403);
      expect(await mcpStatus(t, g.access)).toBe(200);
    }));

  it("supports RFC 7009 revocation at /oauth/revoke, only by the token's own client", () =>
    withApp({}, async (t) => {
      const cookie = await signIn(t);
      const meta = (await (await t.fetch("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
      expect(meta.revocation_endpoint).toBe(`${BASE}/oauth/revoke`);
      const a = await grant(t, cookie, "A");
      const b = await grant(t, cookie, "B");
      // Another client presenting A's token changes nothing, and gets the same 200.
      const wrong = await tokenRequest(t, { token: a.refresh, client_id: b.clientId }, "/oauth/revoke");
      expect(wrong.status).toBe(200);
      expect(await mcpStatus(t, a.access)).toBe(200);
      const res = await tokenRequest(t, { token: a.refresh, token_type_hint: "refresh_token", client_id: a.clientId }, "/oauth/revoke");
      expect(res.status).toBe(200);
      expect(await mcpStatus(t, a.access)).toBe(401);
      expect(await mcpStatus(t, b.access)).toBe(200);
      const unknown = await tokenRequest(t, { token: "awr_nothing", client_id: a.clientId }, "/oauth/revoke");
      expect(unknown.status).toBe(200);
    }));

  it("ends a grant at its absolute lifetime however often it refreshes", () =>
    withApp({}, async (t) => {
      const cookie = await signIn(t);
      const g = await grant(t, cookie);
      // Ten minutes left: refreshed tokens never outlive the grant.
      await t.db.query("UPDATE oauth_grants SET expires_at = now() + interval '10 minutes'");
      const r1 = await tokenRequest(t, { grant_type: "refresh_token", refresh_token: g.refresh, client_id: g.clientId });
      const b1 = (await r1.json()) as { expires_in: number; refresh_token: string };
      expect(r1.status).toBe(200);
      expect(b1.expires_in).toBeLessThanOrEqual(600);
      const [rt] = await t.db.query<{ ok: boolean }>(
        "SELECT bool_and(r.expires_at <= g.expires_at) AS ok FROM oauth_refresh_tokens r JOIN oauth_grants g USING (family_id) WHERE r.used_at IS NULL",
      );
      expect(rt!.ok).toBe(true);
      await t.db.query("UPDATE oauth_grants SET expires_at = now() - interval '1 second'");
      const r2 = await tokenRequest(t, { grant_type: "refresh_token", refresh_token: b1.refresh_token, client_id: g.clientId });
      expect(r2.status).toBe(400);
      expect(((await r2.json()) as { error_description: string }).error_description).toContain("ended");
    }));

  it("records a 90-day grant lifetime by default", () =>
    withApp({}, async (t) => {
      const cookie = await signIn(t);
      await grant(t, cookie);
      const [row] = await t.db.query<{ days: number }>("SELECT round(extract(epoch FROM expires_at - created_at) / 86400)::int AS days FROM oauth_grants");
      expect(row!.days).toBe(90);
    }));

  it("lets personal access tokens expire", () =>
    withApp({}, async (t) => {
      const cookie = await signIn(t);
      const tokens = await page(t, "/tokens", cookie);
      const created = await (await t.fetch("/tokens", post({ _csrf: csrfFrom(tokens), name: "short", expires: "30" }, cookie))).text();
      const token = /(anywr_[A-Za-z0-9_-]+)/.exec(created)![1]!;
      const [row] = await t.db.query<{ days: number }>(
        "SELECT round(extract(epoch FROM expires_at - created_at) / 86400)::int AS days FROM personal_access_tokens WHERE name = 'short'",
      );
      expect(row!.days).toBe(30);
      expect((await t.api("GET", "/me", undefined, token)).status).toBe(200);
      await t.db.query("UPDATE personal_access_tokens SET expires_at = now() - interval '1 second' WHERE name = 'short'");
      expect((await t.api("GET", "/me", undefined, token)).status).toBe(401);
    }));
});

describe("A3: sign-out everywhere and from one browser", () => {
  it("signs out every web session", () =>
    withApp({}, async (t) => {
      const a = await signIn(t);
      const b = await signIn(t);
      const account = await page(t, "/account", a);
      const res = await t.fetch("/account/signout-everywhere", post({ _csrf: csrfFrom(account) }, a));
      expect(res.status).toBe(302);
      for (const cookie of [a, b]) expect((await t.fetch("/projects", { headers: { cookie }, redirect: "manual" })).status).toBe(302);
      expect((await t.api("GET", "/me")).status).toBe(200);
    }));

  it("lists signed-in browsers and signs out one of them", () =>
    withApp({}, async (t) => {
      const here = await signIn(t);
      const other = await signIn(t);
      const security = await page(t, "/account/security", here);
      expect(security).toContain("This browser");
      const id = /action="\/account\/security\/sessions\/([^/]+)\/revoke"/.exec(security)![1]!;
      expect((await t.fetch(`/account/security/sessions/${id}/revoke`, post({ _csrf: csrfFrom(security) }, here))).status).toBe(302);
      expect((await t.fetch("/projects", { headers: { cookie: other }, redirect: "manual" })).status).toBe(302);
      expect((await t.fetch("/projects", { headers: { cookie: here }, redirect: "manual" })).status).toBe(200);
      expect(await page(t, "/account/security", here)).toContain("Signed out a browser");
    }));
});

describe("D5: delete project and delete account pages", () => {
  const stale = (t: TestApp) => t.db.query("UPDATE web_sessions SET reauth_at = now() - interval '11 minutes'");

  it("deletes a project only with CSRF, the typed slug and a recent sign-in", () =>
    withApp({}, async (t) => {
      await t.api("POST", "/projects", { name: "Gone Soon" });
      const cookie = await signIn(t);
      expect(await page(t, "/projects/gone-soon", cookie)).toContain('href="/projects/gone-soon/delete"');
      const form = await page(t, "/projects/gone-soon/delete", cookie);
      const csrf = csrfFrom(form);
      expect((await t.fetch("/projects/gone-soon/delete", post({ confirm: "gone-soon" }, cookie))).status).toBe(403);
      expect((await t.fetch("/projects/gone-soon/delete", post({ _csrf: csrf, confirm: "nope" }, cookie))).status).toBe(422);
      await stale(t);
      const asked = await t.fetch("/projects/gone-soon/delete", post({ _csrf: csrf, confirm: "gone-soon" }, cookie));
      expect(asked.status).toBe(302);
      expect(asked.headers.get("location")).toBe("/account/confirm?next=%2Fprojects%2Fgone-soon%2Fdelete");
      expect((await t.api("GET", "/projects/gone-soon")).status).toBe(200);

      await confirmByEmail(t, cookie, "/projects/gone-soon/delete");
      const res = await t.fetch("/projects/gone-soon/delete", post({ _csrf: csrf, confirm: "gone-soon" }, cookie));
      expect(res.status).toBe(302);
      expect((await t.api("GET", "/projects/gone-soon")).status).toBe(404);
    }));

  it("deletes the account and everything in it, and says so by email", () =>
    withApp({}, async (t) => {
      await t.api("POST", "/projects", { name: "Mine" });
      const cookie = await signIn(t);
      const account = await page(t, "/account", cookie);
      const csrf = csrfFrom(account);
      expect((await t.fetch("/account/delete", post({ _csrf: csrf, email: "other@example.com" }, cookie))).status).toBe(422);
      const res = await t.fetch("/account/delete", post({ _csrf: csrf, email: "ME@example.com" }, cookie));
      expect(res.status).toBe(200);
      expect(await t.db.query("SELECT 1 FROM users")).toHaveLength(0);
      expect(await t.db.query("SELECT 1 FROM projects")).toHaveLength(0);
      expect(await t.db.query("SELECT 1 FROM pages")).toHaveLength(0);
      expect((await t.api("GET", "/me")).status).toBe(401);
      expect(t.mailer.last("me@example.com")!.subject).toBe("Your Anywhere account was deleted");
    }));

  it("confirming by email needs the code sent to the account, in this browser", () =>
    withApp({}, async (t) => {
      const cookie = await signIn(t);
      await stale(t);
      const confirm = await page(t, "/account/confirm?next=/account", cookie);
      expect(confirm).toContain("Email me a code");
      const sent = await t.fetch("/account/confirm/send", post({ _csrf: csrfFrom(confirm), next: "/account" }, cookie));
      expect(sent.status).toBe(200);
      const mail = t.mailer.last("me@example.com")!;
      expect(mail.subject).toMatch(/confirmation code/);
      const code = /\b(\d{6})\b/.exec(mail.text)![1]!;
      const wrong = await t.fetch("/account/confirm/code", post({ _csrf: csrfFrom(confirm), next: "/account", code: code === "000000" ? "111111" : "000000" }, cookie));
      expect(wrong.status).toBe(400);
      const ok = await t.fetch("/account/confirm/code", post({ _csrf: csrfFrom(confirm), next: "/account", code }, cookie));
      expect(ok.status).toBe(302);
      expect(ok.headers.get("location")).toBe("/account");
    }));
});

/** Proves it is the owner again, by an emailed code, in the browser holding `cookie`. */
async function confirmByEmail(t: TestApp, cookie: string, next: string) {
  const confirm = await page(t, `/account/confirm?next=${encodeURIComponent(next)}`, cookie);
  await t.fetch("/account/confirm/send", post({ _csrf: csrfFrom(confirm), next }, cookie));
  const code = /\b(\d{6})\b/.exec(t.mailer.last("me@example.com")!.text)![1]!;
  const res = await t.fetch("/account/confirm/code", post({ _csrf: csrfFrom(confirm), next, code }, cookie));
  if (res.status !== 302) throw new Error(`confirmation failed: ${res.status}`);
}

describe("A12: sessions", () => {
  it("ends the session already in the browser when someone signs in", () =>
    withApp({}, async (t) => {
      const first = await signIn(t);
      const sent = await t.fetch("/signin", post({ email: "b@example.com" }, first));
      const jar = cookiesFrom(sent, first);
      const res = await t.fetch("/signin/code", post({ code: codeFor(t, "b@example.com") }, jar));
      expect(res.status).toBe(302);
      expect((await t.fetch("/projects", { headers: { cookie: first }, redirect: "manual" })).status).toBe(302);
    }));

  it("ends a session after the idle timeout", () =>
    withApp({}, async (t) => {
      const cookie = await signIn(t);
      expect((await t.fetch("/projects", { headers: { cookie }, redirect: "manual" })).status).toBe(200);
      await t.db.query("UPDATE web_sessions SET last_seen_at = now() - interval '15 days'");
      expect((await t.fetch("/projects", { headers: { cookie }, redirect: "manual" })).status).toBe(302);
    }));

  it("uses the __Host- cookie prefix on https, for the session and the browser id", () =>
    withApp({}, async (t) => {
      const sent = await t.fetch("/signin", post({ email: "me@example.com" }));
      const browser = sent.headers.getSetCookie().find((c) => c.startsWith("__Host-anywr_browser="))!;
      expect(browser).toMatch(/HttpOnly/i);
      const res = await t.fetch("/signin/code", post({ code: codeFor(t, "me@example.com") }, cookiesFrom(sent)));
      const set = res.headers.getSetCookie().find((c) => c.includes("anywr_session="))!;
      expect(set).toMatch(/^__Host-anywr_session=/);
      expect(set).toMatch(/Secure/);
      expect(set).toMatch(/Path=\//);
      expect(set).not.toMatch(/Domain=/i);
    }));
});

describe("A11: login CSRF", () => {
  it("refuses sign-in with neither Origin nor Sec-Fetch-Site: same-origin", () =>
    withApp({}, async (t) => {
      const body = { email: "me@example.com" };
      expect((await t.fetch("/signin", post(body, undefined, {}))).status).toBe(403);
      expect((await t.fetch("/signin", post(body, undefined, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
      expect((await t.fetch("/signin", post(body, undefined, { origin: "https://evil.example" }))).status).toBe(403);
      expect((await t.fetch("/passkeys/signin/options", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" })).status).toBe(403);
      expect(t.mailer.sent).toHaveLength(0);
      expect((await t.fetch("/signin", post(body, undefined, { "sec-fetch-site": "same-origin" }))).status).toBe(303);
    }));
});

describe("A9: transport security", () => {
  it("sends HSTS on an https BASE_URL", () =>
    withApp({}, async (t) => {
      expect((await t.fetch("/signin")).headers.get("strict-transport-security")).toBe("max-age=63072000; includeSubDomains");
    }));

  it("refuses to start in production without an https BASE_URL, except on loopback", () => {
    const mail = { RESEND_API_KEY: "re_test", ANYWHERE_MAIL_FROM: "Anywhere <hello@mail.anywr.example>" };
    expect(() => loadConfig({ NODE_ENV: "production", BASE_URL: "http://anywr.example", ...mail })).toThrow(/https/);
    expect(() => loadConfig({ NODE_ENV: "production", ...mail })).not.toThrow(); // http://localhost:3000
    expect(() => loadConfig({ NODE_ENV: "production", BASE_URL: "https://anywr.example", ...mail })).not.toThrow();
  });
});

describe("D6: no remote images", () => {
  it("renders markdown images as links and forbids remote images in the CSP", () =>
    withApp({}, async (t) => {
      const out = renderMarkdown("![secret](https://evil.example/leak?d=abc) and ![x](javascript:alert(1))");
      expect(out).not.toContain("<img");
      expect(out).toContain('href="https://evil.example/leak?d=abc"');
      expect(out).toContain("Image: secret");
      expect(out).not.toContain("javascript:");
      await t.api("POST", "/projects", { name: "Pics" });
      const cookie = await signIn(t);
      const res = await t.fetch("/projects/pics/pages/overview.md", { headers: { cookie } });
      expect(res.headers.get("content-security-policy")).toContain("img-src 'self' data:");
    }));
});

describe("D9: no caching of authenticated responses", () => {
  it("sends Cache-Control: private, no-store on API, MCP, export and signed-in pages", () =>
    withApp({}, async (t) => {
      await t.api("POST", "/projects", { name: "Cached" });
      expect((await t.api("GET", "/projects")).headers.get("cache-control")).toBe("private, no-store");
      expect((await t.api("GET", "/projects/cached/export")).headers.get("cache-control")).toBe("private, no-store");
      const cookie = await signIn(t);
      for (const path of ["/projects", "/projects/cached", "/projects/cached/pages/overview.md", "/projects/cached/export.zip"]) {
        expect((await t.fetch(path, { headers: { cookie } })).headers.get("cache-control"), path).toBe("private, no-store");
      }
      const mcp = await t.fetch("/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${t.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      expect(mcp.headers.get("cache-control")).toBe("private, no-store");
    }));
});

describe("D10: deployment defaults", () => {
  it("refuses the embedded database in production unless allowed", async () => {
    const { embeddedDbRefusal } = await import("../src/config.js");
    const prod = { NODE_ENV: "production", BASE_URL: "https://anywr.example", RESEND_API_KEY: "re_test", ANYWHERE_MAIL_FROM: "hello@mail.anywr.example" };
    expect(embeddedDbRefusal(loadConfig(prod), prod)).toMatch(/DATABASE_URL/);
    expect(embeddedDbRefusal(loadConfig({ ...prod, DATABASE_URL: "postgres://x" }), prod)).toBeNull();
    const allowed = { ...prod, ANYWHERE_ALLOW_EMBEDDED_DB: "1" };
    expect(embeddedDbRefusal(loadConfig(allowed), allowed)).toBeNull();
    expect(embeddedDbRefusal(loadConfig({}), {})).toBeNull();
  });

  it("compose needs a database password, publishes on loopback and pins images", async () => {
    const { readFileSync } = await import("node:fs");
    const compose = readFileSync(new URL("../../../docker-compose.yml", import.meta.url), "utf8");
    const dockerfile = readFileSync(new URL("../../../Dockerfile", import.meta.url), "utf8");
    expect(compose).not.toContain("POSTGRES_PASSWORD:-");
    expect(compose).toContain('"127.0.0.1:${PORT:-3000}:3000"');
    expect(compose).toMatch(/image: postgres:17@sha256:[0-9a-f]{64}/);
    for (const from of dockerfile.match(/^FROM .*/gm)!) expect(from).toMatch(/@sha256:[0-9a-f]{64}/);
  });
});

describe("A10: token audience", () => {
  it("accepts an OAuth token on /mcp only when it was issued for the MCP resource", () =>
    withApp({}, async (t) => {
      const cookie = await signIn(t);
      const g = await grant(t, cookie);
      expect(await mcpStatus(t, g.access)).toBe(200);
      await t.db.query("UPDATE oauth_access_tokens SET resource = 'https://other.example/mcp'");
      expect(await mcpStatus(t, g.access)).toBe(401);
      expect((await t.api("GET", "/me", undefined, g.access)).status).toBe(401);
      // docs/api.md: /api/v1 takes personal access tokens only, so even a valid MCP token is refused there.
      await t.db.query("UPDATE oauth_access_tokens SET resource = $1", [`${BASE}/mcp`]);
      expect(await mcpStatus(t, g.access)).toBe(200);
      expect((await t.api("GET", "/me", undefined, g.access)).status).toBe(401);
    }));
});

describe("A12: purging expired rows", () => {
  it("deletes expired sessions, codes, tokens and grants, and old rate-limit windows", () =>
    withApp({}, async (t) => {
      const cookie = await signIn(t);
      await grant(t, cookie);
      await signIn(t);
      await t.db.query("UPDATE web_sessions SET expires_at = now() - interval '1 minute'");
      await t.db.query("UPDATE oauth_codes SET expires_at = now() - interval '2 days'");
      await t.db.query("UPDATE oauth_grants SET expires_at = now() - interval '2 days'");
      await t.db.query("UPDATE oauth_access_tokens SET expires_at = now() - interval '2 days'");
      await t.db.query("INSERT INTO rate_limits (key, window_start, count) VALUES ('old', 0, 1)");
      const { purgeExpired } = await import("../src/index.js");
      // Requests start a purge now and then, which may run alongside: check the outcome, not counts.
      const counts = await purgeExpired(t.db);
      expect(Object.keys(counts)).toContain("rate_limits");
      expect(await t.db.query("SELECT 1 FROM rate_limits WHERE key = 'old'")).toHaveLength(0);
      for (const table of ["web_sessions", "oauth_codes", "oauth_grants", "oauth_access_tokens", "oauth_refresh_tokens"]) {
        expect(await t.db.query(`SELECT 1 FROM ${table}`), table).toHaveLength(0);
      }
    }));
});
