import { Hono, type Context } from "hono";
import { guardBearer } from "../auth/guard.js";
import { mcpUrl, type Deps, type Env } from "../deps.js";
import { exportResponse } from "../export/zip.js";
import { errorResponse, readJsonObject } from "../http.js";
import { AppError } from "../service/errors.js";

/** The page path after `/projects/:slug/pages/`, exactly as sent (no decoding, per docs/api.md). */
function pagePath(c: Context, suffix = ""): string {
  const m = /\/projects\/[^/]+\/pages\/(.*)$/.exec(c.req.path);
  let path = m?.[1] ?? "";
  if (suffix && path.endsWith(suffix)) path = path.slice(0, -suffix.length);
  return path;
}

export function apiRoutes(deps: Deps): Hono<Env> {
  const { db, config, service } = deps;
  // docs/api.md: /api/v1 accepts personal access tokens only. OAuth access tokens are issued for the
  // MCP resource and are refused here (audit A10).
  const resources = [mcpUrl(config)];
  const api = new Hono<Env>();

  api.onError((err, c) => {
    if (err instanceof AppError) return errorResponse(c, err);
    console.error(err);
    return c.json({ error: { code: "internal", message: "Something went wrong on the server." } }, 500);
  });
  api.notFound((c) => errorResponse(c, new AppError(404, "not_found", "No such endpoint.")));

  api.use("*", async (c, next) => {
    const g = await guardBearer(deps, c, resources, { patOnly: true });
    if (!g.ok) {
      if (g.status === 401) throw new AppError(401, "unauthorized", g.message);
      throw new AppError(429, "rate_limited", g.message, { retryAfter: g.retryAfter });
    }
    try {
      c.set("userId", g.principal.userId);
      c.set("actor", g.principal.actor);
      await next();
      c.header("Cache-Control", "private, no-store"); // audit D9
    } finally {
      g.release();
    }
  });

  api.get("/me", async (c) => {
    const rows = await db.query<{ id: string; email: string }>("SELECT id, email FROM users WHERE id = $1", [
      c.get("userId"),
    ]);
    return c.json({ user: rows[0] });
  });

  api.get("/projects", async (c) => c.json({ projects: await service.listProjects(c.get("userId")) }));

  api.post("/projects", async (c) => {
    const body = await readJsonObject(c);
    const input: { name: unknown; slug?: unknown; description?: unknown } = { name: body.name };
    if (body.slug !== undefined) input.slug = body.slug;
    if (body.description !== undefined) input.description = body.description;
    return c.json(await service.createProject(c.get("userId"), input, c.get("actor")));
  });

  // Proposed contract addition (audit D5): deleting a whole project needs ?confirm=<slug>, so a
  // misrouted request cannot do it.
  api.delete("/projects/:slug", async (c) => {
    const slug = c.req.param("slug");
    if (c.req.query("confirm") !== slug) {
      throw new AppError(422, "invalid_body", `To delete the project, repeat its slug: ?confirm=${slug}.`);
    }
    await service.deleteProject(c.get("userId"), slug);
    return c.json({ deleted: true });
  });

  api.get("/projects/:slug", async (c) => c.json(await service.getProject(c.get("userId"), c.req.param("slug"))));

  api.get("/projects/:slug/export", async (c) => {
    return exportResponse(c, service, c.get("userId"), c.req.param("slug"), config.limits.maxExportBytes);
  });

  api.get("/projects/:slug/pages/*", async (c) => {
    return c.json({ page: await service.getPage(c.get("userId"), c.req.param("slug"), pagePath(c)) });
  });

  api.put("/projects/:slug/pages/*", async (c) => {
    const body = await readJsonObject(c);
    if (typeof body.content !== "string") throw new AppError(422, "invalid_body", "content must be a string.");
    if (body.baseVersion === undefined) throw new AppError(422, "invalid_body", "baseVersion is required (0 to create).");
    const page = await service.putPage(c.get("userId"), c.req.param("slug"), pagePath(c), body.content, body.baseVersion, c.get("actor"));
    return c.json({ page });
  });

  api.post("/projects/:slug/pages/*", async (c) => {
    if (!c.req.path.endsWith("/append")) throw new AppError(404, "not_found", "No such endpoint.");
    const body = await readJsonObject(c);
    if (typeof body.content !== "string") throw new AppError(422, "invalid_body", "content must be a string.");
    const page = await service.appendPage(c.get("userId"), c.req.param("slug"), pagePath(c, "/append"), body.content, c.get("actor"));
    return c.json({ page });
  });

  api.delete("/projects/:slug/pages/*", async (c) => {
    const raw = c.req.query("baseVersion");
    if (raw === undefined || !/^\d+$/.test(raw)) {
      throw new AppError(422, "invalid_body", "baseVersion is required as a query parameter, e.g. ?baseVersion=3.");
    }
    await service.deletePage(c.get("userId"), c.req.param("slug"), pagePath(c), Number(raw), c.get("actor"));
    return c.json({ deleted: true });
  });

  return api;
}
