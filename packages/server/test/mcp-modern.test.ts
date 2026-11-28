import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseFrontmatter, SKILLS } from "../src/mcp/skills.js";
import { SKILL_FILES } from "../src/web/skill.generated.js";
import { BASE, makeTestApp, type TestApp } from "./helpers.js";

/*
 * MCP revision 2026-07-28 on the same /mcp endpoint as the older revisions: server/discover, the
 * per-request _meta, result shapes, and the Skills extension serving the Anywhere skill.
 */

let t: TestApp;
beforeEach(async () => {
  t = await makeTestApp();
});
afterEach(async () => {
  await t.close();
});

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "modern-test", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};
let nextId = 1;
async function rpc(method: string, params: Record<string, unknown> = {}, opts: { meta?: Record<string, unknown> | null; token?: string | null } = {}) {
  const meta = opts.meta === undefined ? META : opts.meta;
  const res = await t.fetch("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      ...(opts.token === null ? {} : { authorization: `Bearer ${opts.token ?? t.token}` }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params: meta ? { ...params, _meta: meta } : params }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed JSON-RPC bodies
  type Loose = any;
  const body = res.status === 202 ? null : ((await res.json()) as { result?: Record<string, Loose>; error?: { code: number; message: string; data?: Loose } });
  return { status: res.status, body, result: body?.result, error: body?.error };
}

describe("MCP 2026-07-28", () => {
  it("answers server/discover with the server's capabilities and the Skills extension", async () => {
    const r = await rpc("server/discover");
    expect(r.status).toBe(200);
    expect(r.result).toMatchObject({ resultType: "complete", supportedVersions: ["2026-07-28"], cacheScope: "private" });
    expect(r.result!.ttlMs).toBeGreaterThan(0);
    expect(r.result!.capabilities.tools).toBeDefined();
    expect(r.result!.capabilities.resources).toBeDefined();
    expect(r.result!.capabilities.extensions["io.modelcontextprotocol/skills"]).toEqual({});
    expect(r.result!._meta["io.modelcontextprotocol/serverInfo"]).toMatchObject({ name: "anywhere" });
    expect(r.result!.instructions).toMatch(/Anywhere/);
  });

  it("needs sign-in like every other request", async () => {
    const r = await rpc("server/discover", {}, { token: null });
    expect(r.status).toBe(401);
  });

  it("refuses an unknown protocol version and a request without client capabilities", async () => {
    const bad = await rpc("tools/list", {}, { meta: { ...META, "io.modelcontextprotocol/protocolVersion": "2099-01-01" } });
    expect(bad.status).toBe(400);
    expect(bad.error).toMatchObject({ code: -32022, message: "Unsupported protocol version", data: { requested: "2099-01-01" } });
    expect(bad.error!.data.supported).toContain("2026-07-28");
    const noCaps: Record<string, unknown> = { ...META };
    delete noCaps["io.modelcontextprotocol/clientCapabilities"];
    const missing = await rpc("tools/list", {}, { meta: noCaps });
    expect(missing.status).toBe(400);
    expect(missing.error!.code).toBe(-32602);
  });

  it("lists the Anywhere skill with every file's size and SHA-256, and serves each file to match", async () => {
    const list = await rpc("skills/list");
    expect(list.result).toMatchObject({ resultType: "complete", cacheScope: "private" });
    const skills = list.result!.skills as { uri: string; frontmatter: Record<string, string>; resources: { uri: string; digest: string; size: number }[] }[];
    expect(skills.map((s) => s.uri)).toEqual(["skill://anywhere/SKILL.md"]);
    const skill = skills[0]!;
    expect(skill.frontmatter.name).toBe("anywhere");
    expect(skill.frontmatter.description).toMatch(/^Shared project context/);
    expect(skill.resources[0]!.uri).toBe("skill://anywhere/SKILL.md");
    expect(skill.resources.map((f) => f.uri).sort()).toEqual(SKILL_FILES.map((f) => `skill://${f.path}`).sort());

    for (const f of skill.resources) {
      const read = await rpc("resources/read", { uri: f.uri });
      expect(read.result).toMatchObject({ resultType: "complete", cacheScope: "private" });
      const content = read.result!.contents[0] as { uri: string; mimeType: string; text: string };
      expect(content.uri).toBe(f.uri);
      const bytes = Buffer.from(content.text, "utf8");
      // What a client checks before it uses the file.
      expect(bytes.length).toBe(f.size);
      expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(f.digest);
      if (f.uri.endsWith("SKILL.md")) {
        expect(content.mimeType).toBe("text/markdown");
        expect(parseFrontmatter(content.text)).toEqual(skill.frontmatter);
      }
    }
  });

  it("gets one skill, and refuses an unknown skill or file", async () => {
    const got = await rpc("skills/get", { uri: "skill://anywhere/SKILL.md" });
    expect(got.result!.skill.uri).toBe("skill://anywhere/SKILL.md");
    expect(got.result!.skill.resources).toEqual(SKILLS[0]!.files.map((f) => ({ uri: f.uri, digest: f.digest, size: f.size })));
    expect((await rpc("skills/get", { uri: "skill://nope/SKILL.md" })).error!.code).toBe(-32602);
    expect((await rpc("resources/read", { uri: "skill://anywhere/../../etc/passwd" })).error!.code).toBe(-32602);
  });

  it("lists and calls tools through the same server, with results in the new shape", async () => {
    const tools = await rpc("tools/list");
    expect(tools.result).toMatchObject({ resultType: "complete", cacheScope: "private" });
    expect((tools.result!.tools as { name: string }[]).map((x) => x.name)).toContain("create_project");

    const made = await rpc("tools/call", { name: "create_project", arguments: { name: "Modern client" } });
    expect(made.result!.resultType).toBe("complete");
    expect(made.result!.isError).toBeFalsy();
    expect(made.result!.ttlMs).toBeUndefined();
    const listed = await rpc("tools/call", { name: "list_projects", arguments: {} });
    expect(JSON.stringify(listed.result!.content)).toContain("modern-client");

    const panel = await rpc("resources/read", { uri: "ui://anywhere/app.html" });
    expect(panel.result!.contents[0].text).toContain("<!doctype html>");
  });

  it("acknowledges a notification with no body", async () => {
    const res = await t.fetch("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${t.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1, _meta: META } }),
    });
    expect(res.status).toBe(202);
  });

  it("leaves older clients exactly as they were: initialize works, and no skills are offered", async () => {
    const c = new Client({ name: "old-client", version: "1.0.0" });
    await c.connect(
      new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
        fetch: (url, init) => t.fetch(String(url), init),
        requestInit: { headers: { authorization: `Bearer ${t.token}` } },
      }),
    );
    expect(c.getServerCapabilities()?.tools).toBeDefined();
    expect(JSON.stringify(c.getServerCapabilities())).not.toContain("io.modelcontextprotocol/skills");
    const { tools } = await c.listTools();
    expect(tools.length).toBeGreaterThan(5);
    await c.close();
  });
});
