import { describe, expect, it } from "vitest";
import { approveEmail } from "../src/auth/early-access.js";
import { loadConfig } from "../src/config.js";
import { BASE, makeTestApp, type TestApp } from "./helpers.js";

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
    body: new URLSearchParams({ email, password: "a long password" }).toString(),
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

      const refused = await t.fetch("/signup", signup("new@example.com"));
      expect(refused.status).toBe(403);
      expect(await refused.text()).toContain("not approved yet");
      expect((await t.db.query("SELECT 1 FROM users WHERE email = 'new@example.com'")).length).toBe(0);

      await approveEmail(t.db, "  NEW@example.com ");
      const ok = await t.fetch("/signup", signup("New@Example.com"));
      expect(ok.status).toBe(302);
    }));

  it("points sign-in at early access instead of open sign-up", () =>
    withApp({ ANYWHERE_SIGNUPS: "approved", ANYWHERE_EARLY_ACCESS_URL: "https://anywr.ai/early-access" }, async (t) => {
      const page = await (await t.fetch("/signin")).text();
      expect(page).toContain("Request early access");
      expect(page).toContain("Create your account");
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
