import { Hono } from "hono";
import { apiRoutes } from "./api/routes.js";
import { ConcurrencyGate, RateLimiter } from "./auth/ratelimit.js";
import type { Config } from "./config.js";
import { loadLayout, type Layout } from "./content/layout.js";
import type { Db } from "./db/db.js";
import type { Deps } from "./deps.js";
import { mcpHandler } from "./mcp/routes.js";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { MAX_BODY_BYTES, MAX_PAGE_BYTES } from "./service/validate.js";
import { oauthRoutes } from "./oauth/routes.js";
import { webRoutes } from "./web/routes.js";
import { createService } from "./service/projects.js";
import { purgeExpired } from "./db/maintenance.js";
import { localGuard, type LocalSetup } from "./local.js";
import { localConnector, type LocalConnector } from "./local-connect.js";
import { GEIST_MONO_WOFF2, GEIST_WOFF2 } from "./web/fonts.generated.js";
import { MARK_PNG, MARK_SVG } from "./web/brand.generated.js";
import { APP_JS } from "./web/render.js";
import { SKILL_FILES } from "./web/skill.generated.js";
import { tarGz } from "./web/tar.js";
import { createMailer, type Mailer } from "./mail/mailer.js";

const SKILL_TGZ = tarGz(
  SKILL_FILES.map((f) => ({ ...f, mode: f.path.endsWith(".mjs") ? 0o755 : 0o644 })),
  Math.floor(Date.now() / 1000),
);

/** Files served under /assets/, all from memory and none private. */
const ASSETS: Record<string, { type: string; body: Buffer; maxAge: number }> = {
  "/assets/geist.woff2": { type: "font/woff2", body: Buffer.from(GEIST_WOFF2, "base64"), maxAge: 31536000 },
  "/assets/geist-mono.woff2": { type: "font/woff2", body: Buffer.from(GEIST_MONO_WOFF2, "base64"), maxAge: 31536000 },
  // The icon in browser tabs, and the mark at the top of every email (which loads it from here).
  "/assets/mark.svg": { type: "image/svg+xml", body: Buffer.from(MARK_SVG, "utf8"), maxAge: 86400 },
  "/assets/mark.png": { type: "image/png", body: Buffer.from(MARK_PNG, "base64"), maxAge: 86400 },
};

export interface AppOptions {
  db: Db;
  config: Config;
  layout?: Layout;
  fetch?: typeof fetch;
  /** Required in local mode: what prepareLocal set up. */
  local?: LocalSetup;
  /** Local mode only: how agents on this computer get connected. Tests replace it. */
  connector?: LocalConnector;
  /** How email is sent. Tests pass a MemoryMailer; otherwise built from config.mail. */
  mailer?: Mailer;
}

export function createApp(options: AppOptions) {
  const layout = options.layout ?? loadLayout(options.config.layoutPath);
  const deps: Deps = {
    db: options.db,
    config: options.config,
    layout,
    service: createService(options.db, layout, options.config.limits),
    limiter: new RateLimiter(options.db),
    userGate: new ConcurrencyGate(options.config.maxConcurrentPerUser),
    fetch: options.fetch,
    local: options.local,
    connector: options.connector ?? (options.local ? localConnector(options.config, options.local) : undefined),
    mailer: options.mailer ?? createMailer(options.config.mail),
    brand: {
      productName: options.config.productName,
      appUrl: options.config.baseUrl,
      siteUrl: options.config.siteUrl,
      supportEmail: options.config.mail.supportEmail,
    },
    rp: { id: new URL(options.config.baseUrl).hostname, name: options.config.productName, origin: new URL(options.config.baseUrl).origin },
  };
  if (options.config.local && !options.local) throw new Error("Local mode needs prepareLocal() before createApp().");

  const app = new Hono();
  if (options.config.local) app.use("*", localGuard(options.config));
  app.get("/healthz", (c) => c.json({ ok: true }));
  // The Anywhere skill for Claude Code and Codex, so people can install it without this repository:
  //   curl -fsSL <app>/skill/anywhere.tar.gz | tar -xz -C ~/.claude/skills
  app.get("/skill/anywhere.tar.gz", (c) => {
    c.header("Content-Type", "application/gzip");
    c.header("Content-Disposition", 'attachment; filename="anywhere-skill.tar.gz"');
    c.header("Cache-Control", "public, max-age=300");
    c.header("X-Content-Type-Options", "nosniff");
    return c.body(new Uint8Array(SKILL_TGZ));
  });
  // The web pages' script, fonts (Geist, SIL Open Font License) and icon, served before the per-page
  // rate limit.
  app.get("/assets/:file", (c) => {
    if (c.req.path === "/assets/app.js") {
      c.header("Content-Type", "text/javascript; charset=utf-8");
      c.header("Cache-Control", "public, max-age=300");
      c.header("X-Content-Type-Options", "nosniff");
      return c.body(APP_JS);
    }
    const asset = ASSETS[c.req.path];
    if (!asset) return c.text("Not found", 404);
    c.header("Content-Type", asset.type);
    c.header("Cache-Control", `public, max-age=${asset.maxAge}${asset.maxAge >= 31536000 ? ", immutable" : ""}`);
    c.header("X-Content-Type-Options", "nosniff");
    if (asset.type === "image/svg+xml") c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
    return c.body(new Uint8Array(asset.body));
  });
  // When agents have a host of their own (ANYWHERE_MCP_ORIGIN), that host serves only the MCP endpoint
  // and the discovery documents; everything else is on the app's host. The MCP endpoint is not served
  // on the app host, so the one address people paste into their agents is the only one that works.
  const appHost = new URL(options.config.baseUrl).host;
  const mcpHost = new URL(options.config.mcpOrigin).host;
  if (mcpHost !== appHost) {
    app.use("*", async (c, next) => {
      const host = new URL(c.req.url).host;
      const path = c.req.path;
      if (host === mcpHost) {
        if (path === "/mcp" || path.startsWith("/.well-known/")) return next();
        return c.redirect(`${options.config.baseUrl}${path}`, 302);
      }
      if (path === "/mcp") {
        return c.json({ error: "not_found", error_description: `The MCP endpoint is ${options.config.mcpOrigin}/mcp` }, 404);
      }
      return next();
    });
  }

  // Now and then a request also clears expired rows; a scheduled purgeExpired call is the main path.
  app.use("*", async (_c, next) => {
    if (Math.random() < 0.001) {
      purgeExpired(options.db).catch((err: unknown) => console.error("purge failed:", (err as Error).message));
    }
    await next();
  });

  // Body caps, enforced while streaming (chunked bodies included), before anything buffers a body.
  // /api/v1 follows docs/api.md (1 MiB, 422 too_large). /mcp allows JSON escaping of a 256 KiB page.
  // OAuth and web forms are small, and most of them need no sign-in.
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) =>
        c.json({ error: { code: "too_large", message: `Request bodies are limited to ${MAX_BODY_BYTES} bytes.` } }, 422),
    }),
  );
  app.use("/mcp", bodyLimit({ maxSize: 2 * MAX_BODY_BYTES, onError: (c) => c.json({ error: "too_large" }, 413) }));
  app.use("*", async (c, next) => {
    if (c.req.path === "/mcp" || c.req.path.startsWith("/api/")) return next();
    // The editor posts a whole page as a form, and form encoding can triple its size, so the two
    // routes that save one take up to a full page; every other form stays small.
    const savesPage = c.req.method === "POST" && /^\/projects\/[^/]+\/(?:edit\/|new-page$)/.test(c.req.path);
    const maxSize = savesPage ? 3 * MAX_PAGE_BYTES + 16 * 1024 : 64 * 1024;
    return bodyLimit({ maxSize, onError: (cc) => cc.text("Request too large", 413) })(c, next);
  });

  app.use(
    "/mcp",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type", "Accept", "Mcp-Session-Id", "MCP-Protocol-Version", "Last-Event-ID"],
      exposeHeaders: ["WWW-Authenticate", "Mcp-Session-Id", "MCP-Protocol-Version"],
      maxAge: 86400,
    }),
  );
  app.route("/api/v1", apiRoutes(deps));
  app.all("/mcp", mcpHandler(deps));
  // Local mode has one owner and a token in a file: there is nothing for another app to be granted,
  // so the sign-in-with-approval routes do not exist there.
  if (!options.config.local) app.route("/", oauthRoutes(deps));
  app.route("/", webRoutes(deps));
  app.notFound((c) =>
    c.req.path.startsWith("/api/")
      ? c.json({ error: { code: "not_found", message: "No such endpoint." } }, 404)
      : c.text("Not found", 404),
  );
  return app;
}
