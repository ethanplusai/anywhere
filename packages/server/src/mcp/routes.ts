import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Context } from "hono";
import { guardBearer } from "../auth/guard.js";
import { mcpUrl, resourceMetadataUrl, type Deps } from "../deps.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { buildMcpServer } from "./server.js";
import { handleModern, modernRequest } from "./modern.js";

const MAX_MCP_BODY = 2 * 1024 * 1024;

/** Handles every method on /mcp. Stateless: a fresh server and transport per request, JSON responses. */
export function mcpHandler(deps: Deps) {
  const { config, service, layout } = deps;
  const resources = [mcpUrl(config)];
  return async (c: Context): Promise<Response> => {
    const g = await guardBearer(deps, c, resources);
    if (!g.ok && g.status === 401) {
      return c.json(
        { error: "invalid_token", error_description: "Sign in to Anywhere: a valid Bearer token is required." },
        401,
        { "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl(config)}"` },
      );
    }
    if (!g.ok) {
      return c.json({ error: "rate_limited", error_description: g.message }, 429, { "Retry-After": String(g.retryAfter ?? 1) });
    }
    try {
      const res = await handle(c, g.principal.userId, g.principal.actor);
      const headers = new Headers(res.headers);
      headers.set("Cache-Control", "private, no-store"); // audit D9
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    } finally {
      g.release();
    }
  };

  async function handle(c: Context, userId: string, actor: string): Promise<Response> {
    if (Number(c.req.header("content-length") ?? 0) > MAX_MCP_BODY) {
      return c.json({ error: "too_large", error_description: "Request body too large." }, 413);
    }

    let request = c.req.raw;
    if (c.req.method === "POST") {
      // A JSON-RPC batch would run many tool calls for one rate-limit count (audit D1). The MCP
      // protocol versions this server speaks (2025-06-18 and later) have no batching, so refuse arrays.
      const body = await c.req.text();
      if (/^\s*\[/.test(body)) {
        return c.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Batched JSON-RPC requests are not supported. Send one message per request." } }, 400);
      }
      // A 2026-07-28 client: answered by the layer for that revision, which runs anything it does
      // not handle itself through the same SDK server as below.
      const modern = modernRequest(body);
      if (modern) {
        return handleModern(modern, (message) => {
          const headers = new Headers(c.req.raw.headers);
          headers.set("content-type", "application/json");
          headers.set("accept", "application/json, text/event-stream");
          headers.set("mcp-protocol-version", LATEST_PROTOCOL_VERSION);
          headers.delete("mcp-session-id");
          return run(new Request(c.req.raw.url, { method: "POST", headers, body: JSON.stringify(message) }));
        });
      }
      request = new Request(c.req.raw.url, { method: "POST", headers: c.req.raw.headers, body });
    }
    return run(request);

    async function run(req: Request): Promise<Response> {
      const server = buildMcpServer(service, layout, userId, actor, { baseUrl: config.baseUrl });
      // No sessionIdGenerator: stateless mode.
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await server.connect(transport);
      return transport.handleRequest(req);
    }
  }
}
