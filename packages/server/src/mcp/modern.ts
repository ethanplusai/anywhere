import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { findSkill, findSkillFile, SKILLS, SKILLS_EXTENSION, skillEntry } from "./skills.js";
import { INSTRUCTIONS, SERVER_VERSION } from "./server.js";

/*
 * MCP revision 2026-07-28, beside the older revisions the SDK speaks.
 *
 * A 2026-07-28 client sends no `initialize`: every request carries its protocol version in
 * `params._meta`, and it may start with `server/discover`. This layer answers what is new in that
 * revision itself (server/discover and the Skills extension's skills/list, skills/get and reads of
 * skill:// files) and hands every other request to the same SDK server older clients use, then
 * shapes the result the way 2026-07-28 expects (`resultType`, and `ttlMs`/`cacheScope` on results a
 * client may cache). A request without that `_meta` is an older client's and never comes here.
 */

export const MODERN_VERSION = "2026-07-28";
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CAPS = "io.modelcontextprotocol/clientCapabilities";

/** Results a 2026-07-28 client may cache, and for how long. Everything here depends on the account. */
const CACHEABLE: Record<string, number> = {
  "server/discover": 300_000,
  "tools/list": 300_000,
  "resources/list": 300_000,
  "resources/templates/list": 300_000,
  "prompts/list": 300_000,
  "resources/read": 60_000,
  "skills/list": 60_000,
  "skills/get": 60_000,
};

type Json = Record<string, unknown>;
interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Json;
}

/** The parsed message when it is a 2026-07-28 request, else null. */
export function modernRequest(body: string): RpcRequest | null {
  let m: unknown;
  try {
    m = JSON.parse(body);
  } catch {
    return null;
  }
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  const r = m as RpcRequest;
  if (typeof r.method !== "string") return null;
  const meta = r.params && typeof r.params._meta === "object" ? (r.params._meta as Json) : null;
  if (r.method === "server/discover" || (meta && META_VERSION in meta)) return r;
  return null;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const rpcError = (id: RpcRequest["id"], status: number, code: number, message: string, data?: unknown) =>
  json(status, { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } });

function shape(method: string, result: Json): Json {
  const ttl = CACHEABLE[method];
  return { resultType: "complete", ...result, ...(ttl ? { ttlMs: ttl, cacheScope: "private" } : {}) };
}
const ok = (r: RpcRequest, result: Json) => json(200, { jsonrpc: "2.0", id: r.id ?? null, result: shape(r.method, result) });

/**
 * Answers a 2026-07-28 request. `legacy` runs a request through the SDK server (as an older
 * client's request would be) and returns its response.
 */
export async function handleModern(r: RpcRequest, legacy: (body: Json) => Promise<Response>): Promise<Response> {
  const meta = (r.params?._meta ?? {}) as Json;
  const version = meta[META_VERSION];
  if (r.method !== "server/discover" || version !== undefined) {
    if (version !== MODERN_VERSION) {
      return rpcError(r.id, 400, -32022, "Unsupported protocol version", { supported: [MODERN_VERSION, LATEST_PROTOCOL_VERSION], requested: version ?? null });
    }
    if (r.id !== undefined && (meta[META_CAPS] === undefined || typeof meta[META_CAPS] !== "object")) {
      return rpcError(r.id, 400, -32602, `params._meta["${META_CAPS}"] is required.`);
    }
  }

  switch (r.method) {
    case "server/discover": {
      // The capabilities are the SDK server's own, read from an initialize it answers, plus the
      // Skills extension.
      const init = await legacy({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "anywhere-discover", version: SERVER_VERSION } },
      });
      const body = (await init.json()) as { result?: { capabilities?: Json } };
      const capabilities = { ...(body.result?.capabilities ?? {}), resources: { ...((body.result?.capabilities?.resources as Json) ?? {}) } } as Json;
      capabilities.extensions = { ...((capabilities.extensions as Json) ?? {}), [SKILLS_EXTENSION]: {} };
      return ok(r, {
        supportedVersions: [MODERN_VERSION],
        capabilities,
        instructions: INSTRUCTIONS,
        _meta: { "io.modelcontextprotocol/serverInfo": { name: "anywhere", version: SERVER_VERSION } },
      });
    }
    case "skills/list":
      return ok(r, { skills: SKILLS.map(skillEntry) });
    case "skills/get": {
      const uri = r.params?.uri;
      const skill = typeof uri === "string" ? findSkill(uri) : undefined;
      if (!skill) return rpcError(r.id, 200, -32602, "No skill with that URI.");
      return ok(r, { skill: skillEntry(skill) });
    }
    case "resources/read": {
      const uri = r.params?.uri;
      if (typeof uri === "string" && uri.startsWith("skill://")) {
        const file = findSkillFile(uri);
        if (!file) return rpcError(r.id, 200, -32602, "No resource with that URI.");
        return ok(r, { contents: [{ uri: file.uri, mimeType: file.mimeType, text: file.text }] });
      }
      break;
    }
  }

  // Everything else is the same as for an older client: run it through the SDK server.
  const res = await legacy(r as unknown as Json);
  if (r.id === undefined) return new Response(null, { status: 202 });
  const text = await res.text();
  let body: { result?: Json; error?: { code: number; message: string; data?: unknown } };
  try {
    body = JSON.parse(text);
  } catch {
    return new Response(text, { status: res.status, headers: res.headers });
  }
  if (body.error) {
    // 2026-07-28 uses invalid params for a missing resource.
    const code = body.error.code === -32002 ? -32602 : body.error.code;
    return json(res.status, { jsonrpc: "2.0", id: r.id, error: { ...body.error, code } });
  }
  return ok(r, body.result ?? {});
}
