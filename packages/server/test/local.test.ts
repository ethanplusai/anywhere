import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import { prepareLocal, type LocalSetup } from "../src/local.js";
import { localConnector } from "../src/local-connect.js";
import type { Db } from "../src/db/db.js";
import { freshDb } from "./helpers.js";

const PORT = "3999";
const ORIGIN = `http://127.0.0.1:${PORT}`;
let home: string;
let db: Db;
let config: Config;
let local: LocalSetup;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "anywhere-local-"));
  rmSync(home, { recursive: true });
  db = await freshDb();
  config = loadConfig({ ANYWHERE_LOCAL: "1", ANYWHERE_HOME: home, PORT });
  local = await prepareLocal(db, config);
  // The connector looks in a home of its own, never the real one of whoever runs the tests.
  app = createApp({ db, config, local, connector: localConnector(config, local, { home: join(home, "user"), env: {} }) });
});
afterEach(async () => {
  await db.close();
  rmSync(home, { recursive: true, force: true });
});

function req(path: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
  return app.fetch(new Request(`${ORIGIN}${path}`, { redirect: "manual", ...init, headers: { host: `127.0.0.1:${PORT}`, ...init.headers } }));
}

describe("local mode settings", () => {
  it("listens on loopback only, has no sign-ups and keeps data in its home", () => {
    expect(config.host).toBe("127.0.0.1");
    expect(config.signups).toBe("closed");
    expect(config.baseUrl).toBe(ORIGIN);
    expect(config.pgliteDir).toBe(join(home, "data"));
    // Nobody to share it with, so the quotas of a public server are lifted; history is kept the same.
    expect(config.limits.maxProjectsPerUser).toBe(Number.MAX_SAFE_INTEGER);
    expect(config.limits.maxPagesPerProject).toBe(Number.MAX_SAFE_INTEGER);
    expect(config.limits.maxBytesPerUser).toBe(Number.MAX_SAFE_INTEGER);
    expect(config.limits.maxExportBytes).toBe(Number.MAX_SAFE_INTEGER);
    expect(config.limits.revisionsKept).toBe(20);
    // A limit someone asks for is still honoured, and a server with accounts keeps its quotas.
    expect(loadConfig({ ANYWHERE_LOCAL: "1", ANYWHERE_MAX_PROJECTS: "5" }).limits.maxProjectsPerUser).toBe(5);
    expect(loadConfig({ BASE_URL: "http://localhost:3000" }).limits.maxProjectsPerUser).toBe(50);
    expect(() => loadConfig({ ANYWHERE_LOCAL: "1", ANYWHERE_HOST: "0.0.0.0" })).toThrow(/this computer only/);
    expect(() => loadConfig({ ANYWHERE_LOCAL: "1", BASE_URL: "https://example.com" })).toThrow(/loopback/);
  });

  it("writes owner-only token files once and reuses them", async () => {
    expect(statSync(home).mode & 0o777).toBe(0o700);
    for (const f of [local.agentTokenPath, local.browserTokenPath]) expect(statSync(f).mode & 0o777).toBe(0o600);
    const again = await prepareLocal(db, config);
    expect(again.browserToken).toBe(local.browserToken);
    expect(again.ownerId).toBe(local.ownerId);
  });

  it("refuses a token file others can read, or a link", async () => {
    chmodSync(local.browserTokenPath, 0o644);
    await expect(prepareLocal(db, config)).rejects.toThrow(/can be read by other users/);
    rmSync(local.browserTokenPath);
    writeFileSync(join(home, "elsewhere"), "x".repeat(40), { mode: 0o600 });
    symlinkSync(join(home, "elsewhere"), local.browserTokenPath);
    await expect(prepareLocal(db, config)).rejects.toThrow(/not a plain file/);
  });
});

describe("who can reach it", () => {
  it("answers only to its own host names", async () => {
    expect((await req("/healthz")).status).toBe(200);
    expect((await req("/healthz", { headers: { host: `localhost:${PORT}` } })).status).toBe(200);
    // A website that points its own name at 127.0.0.1 (DNS rebinding) is refused.
    expect((await req("/healthz", { headers: { host: `evil.example:${PORT}` } })).status).toBe(421);
    expect((await req("/healthz", { headers: { host: "127.0.0.1:80" } })).status).toBe(421);
  });

  it("refuses requests a browser sends on another website's behalf", async () => {
    const evil = await req("/local/unlock", {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" },
      body: `token=${local.browserToken}`,
    });
    expect(evil.status).toBe(403);
    expect((await req("/projects", { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await req("/projects", { headers: { "sec-fetch-site": "same-site" } })).status).toBe(403);
    expect((await req("/local/unlock", { headers: { "sec-fetch-site": "none" } })).status).toBe(200);
  });
});

describe("no accounts", () => {
  it("unlocks the browser only with the token, then lands on the walkthrough", async () => {
    expect((await req("/signup")).headers.get("location")).toBe("/local/unlock");
    expect((await req("/signin?next=%2Fprojects")).headers.get("location")).toBe("/local/unlock?next=%2Fprojects");
    const form = (token: string) => ({
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, next: "/projects" }).toString(),
    });
    expect((await req("/local/unlock", form("wrong-token-wrong-token-wrong"))).status).toBe(400);
    const ok = await req("/local/unlock", form(local.browserToken));
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBe("/welcome");
    const cookie = ok.headers.get("set-cookie")!.split(";")[0]!;
    const page = await (await req("/welcome", { headers: { cookie } })).text();
    expect(page).toContain("anywhere-local");
    expect(page).toContain(local.agentTokenPath);
    expect(page).not.toContain("Authenticate");
    const account = await (await req("/account", { headers: { cookie } })).text();
    expect(account).not.toContain("Change password");
    expect(account).toContain("Runs on this computer only");
    expect(account).toContain("Nothing is limited on your own computer");
    expect(account).not.toContain("These limits keep it that way");
  });

  it("replaces the unlock token once it has been used, so a link opens a browser once", async () => {
    const { readFileSync } = await import("node:fs");
    const form = (token: string) => ({
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
    const first = local.browserToken;
    expect((await req("/local/unlock", form(first))).status).toBe(302);
    expect(local.browserToken).not.toBe(first);
    expect(readFileSync(local.browserTokenPath, "utf8").trim()).toBe(local.browserToken);
    expect(statSync(local.browserTokenPath).mode & 0o777).toBe(0o600);
    expect((await req("/local/unlock", form(first))).status).toBe(400);
    expect((await req("/local/unlock", form(local.browserToken))).status).toBe(302);
  });

  it("has no app-approval routes: there is nobody else to approve", async () => {
    expect((await req("/.well-known/oauth-authorization-server")).status).toBe(404);
    const register = await req("/oauth/register", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:9999/cb"] }),
    });
    expect(register.status).toBe(404);
  });

  it("deletes a project without asking for a password nobody has", async () => {
    const { readFileSync } = await import("node:fs");
    const token = readFileSync(local.agentTokenPath, "utf8").trim();
    const made = await req("/api/v1/projects", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Scratch" }),
    });
    expect(made.status).toBe(200);
    const unlock = await req("/local/unlock", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: local.browserToken }).toString(),
    });
    const cookie = unlock.headers.get("set-cookie")!.split(";")[0]!;
    const page = await (await req("/projects/scratch/delete", { headers: { cookie } })).text();
    expect(page).not.toContain('name="password"');
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page)![1]!;
    const gone = await req("/projects/scratch/delete", {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: csrf, confirm: "scratch" }).toString(),
    });
    expect(gone.status).toBe(302);
    expect((await req("/projects/scratch", { headers: { cookie } })).status).toBe(404);
  });

  it("lets an agent in with the agent token as a header", async () => {
    const { readFileSync } = await import("node:fs");
    const token = readFileSync(local.agentTokenPath, "utf8").trim();
    const res = await req("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(200);
    expect((await req("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    expect(existsSync(join(home, "agent-token"))).toBe(true);
  });
});
