import { describe, expect, it } from "vitest";
import { approveEmail } from "../src/auth/early-access.js";
import { loadConfig } from "../src/config.js";
import { BASE, codeFor, cookiesFrom, makeTestApp, type TestApp } from "./helpers.js";

async function withApp(env: Record<string, string>, fn: (t: TestApp) => Promise<void>) {
  const t = await makeTestApp(env);
  try {
    await fn(t);
  } finally {
    await t.close();
  }
}

function signup(email: string): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE },
    body: new URLSearchParams({ email }).toString(),
    redirect: "manual",
  };
}

describe("sign-up modes", () => {
  it("reads ANYWHERE_SIGNUPS, keeps ANYWHERE_DISABLE_SIGNUPS working, and refuses nonsense", () => {
    expect(loadConfig({}).signups).toBe("open");
    expect(loadConfig({ ANYWHERE_SIGNUPS: "approved" }).signups).toBe("approved");
    expect(loadConfig({ ANYWHERE_DISABLE_SIGNUPS: "1" }).signups).toBe("closed");
    expect(() => loadConfig({ ANYWHERE_SIGNUPS: "maybe" })).toThrow(/open, approved or closed/);
  });

  it("only lets approved emails create an account, whatever their case", () =>
    withApp({ ANYWHERE_SIGNUPS: "approved", ANYWHERE_EARLY_ACCESS_URL: "https://anywr.ai/early-access" }, async (t) => {
      const page = await (await t.fetch("/signup?email=New%40example.com")).text();
      expect(page).toContain("https://anywr.ai/early-access");
      expect(page).toContain('value="New@example.com"');

      // Not approved: the person is told by email, and no code that could create an account is sent.
      const refused = await t.fetch("/signin", signup("new@example.com"));
      expect(refused.status).toBe(303);
      expect(t.mailer.last("new@example.com")!.text).toContain("not have an account");
      const guess = await t.fetch("/signin/code", { ...signup(""), body: new URLSearchParams({ code: "123456" }).toString(), headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE, cookie: cookiesFrom(refused) } });
      expect(guess.headers.getSetCookie().some((c) => c.includes("anywr_session="))).toBe(false);
      expect((await t.db.query("SELECT 1 FROM users WHERE email = 'new@example.com'")).length).toBe(0);

      await approveEmail(t.db, "  NEW@example.com ");
      const sent = await t.fetch("/signin", signup("New@Example.com"));
      const ok = await t.fetch("/signin/code", { ...signup(""), body: new URLSearchParams({ code: codeFor(t, "New@Example.com") }).toString(), headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE, cookie: cookiesFrom(sent) } });
      expect(ok.status).toBe(302);
      expect(ok.headers.get("location")).toBe("/welcome");
    }));

  it("points sign-in at early access instead of open sign-up", () =>
    withApp({ ANYWHERE_SIGNUPS: "approved", ANYWHERE_EARLY_ACCESS_URL: "https://anywr.ai/early-access" }, async (t) => {
      const page = await (await t.fetch("/signin")).text();
      expect(page).toContain("Request early access");
      expect(page).toContain("Approved already?");
    }));
});

describe("a host of its own for the MCP endpoint", () => {
  const env = { ANYWHERE_MCP_ORIGIN: "https://mcp.anywr.test" };

  it("advertises the MCP host as the resource, with the app as the authorization server", () =>
    withApp(env, async (t) => {
      const meta = (await (await t.fetch("https://mcp.anywr.test/.well-known/oauth-protected-resource/mcp")).json()) as {
        resource: string;
        authorization_servers: string[];
      };
      expect(meta.resource).toBe("https://mcp.anywr.test/mcp");
      expect(meta.authorization_servers).toEqual([BASE]);
      const res = await t.fetch("https://mcp.anywr.test/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("https://mcp.anywr.test/.well-known/oauth-protected-resource/mcp");
    }));

  it("serves MCP only on its host, and sends web pages on that host to the app", () =>
    withApp(env, async (t) => {
      const onApp = await t.fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(onApp.status).toBe(404);
      expect(await onApp.text()).toContain("https://mcp.anywr.test/mcp");
      const page = await t.fetch("https://mcp.anywr.test/projects", { redirect: "manual" });
      expect(page.status).toBe(302);
      expect(page.headers.get("location")).toBe(`${BASE}/projects`);
    }));

  it("accepts a personal access token on the MCP host", () =>
    withApp(env, async (t) => {
      const res = await t.fetch("https://mcp.anywr.test/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${t.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(res.status).toBe(200);
    }));
});
