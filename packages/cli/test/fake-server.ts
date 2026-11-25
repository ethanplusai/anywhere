// A small in-process server implementing docs/api.md, used only by the tests.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const PAGE_PATH = /^[a-z0-9][a-z0-9-]{0,62}(\/[a-z0-9][a-z0-9-]{0,62})?\.md$/;
const STANDARD: Record<string, string> = {
  "overview.md": "Overview",
  "decisions.md": "Decisions",
  "open-questions.md": "Open questions",
  "ideas.md": "Ideas",
  "log.md": "Log",
};
const sha = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

type Stored = { content: string; version: number; updatedAt: string; deleted: boolean };
type ProjectRec = { slug: string; name: string; description: string; updatedAt: string; pages: Map<string, Stored> };

export type LoggedRequest = { method: string; path: string; body: unknown };

export class FakeServer {
  token = "anywr_testtoken";
  email = "tester@example.com";
  projects = new Map<string, ProjectRec>();
  log: LoggedRequest[] = [];
  /** Answer the next N requests with 429. */
  rateLimit = 0;
  retryAfter = "0";
  private server: Server | null = null;
  url = "";

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        res.statusCode = 500;
        res.end(String(e));
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    const s = this.server;
    if (!s) return;
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
    this.server = null;
  }

  // ---- helpers the tests use to act as "the other side" (chat, another agent) ----
  addProject(slug: string, name = slug): ProjectRec {
    const p: ProjectRec = { slug, name, description: "", updatedAt: now(), pages: new Map() };
    for (const [path, title] of Object.entries(STANDARD)) {
      p.pages.set(path, { content: `# ${title}\n\n_guidance_\n`, version: 1, updatedAt: now(), deleted: false });
    }
    this.projects.set(slug, p);
    return p;
  }
  /** Create or change a page as another client would. Returns the new version. */
  setPage(slug: string, path: string, content: string): number {
    const p = this.projects.get(slug)!;
    const cur = p.pages.get(path);
    if (cur && !cur.deleted) {
      if (cur.content === content) return cur.version;
      cur.content = content;
      cur.version += 1;
      cur.updatedAt = now();
    } else {
      p.pages.set(path, { content, version: (cur?.version ?? 0) + 1, updatedAt: now(), deleted: false });
    }
    return p.pages.get(path)!.version;
  }
  removePage(slug: string, path: string): void {
    const cur = this.projects.get(slug)!.pages.get(path)!;
    cur.deleted = true;
    cur.version += 1; // tombstone keeps counting
    cur.content = "";
  }
  page(slug: string, path: string): Stored | undefined {
    const s = this.projects.get(slug)?.pages.get(path);
    return s && !s.deleted ? s : undefined;
  }

  // ---- http ----
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url ?? "/", "http://x");
    let body: unknown;
    if (raw.length) {
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        body = Symbol.for("bad-json");
      }
    }
    const method = req.method ?? "GET";
    this.log.push({ method, path: url.pathname + url.search, body });

    const send = (status: number, obj: unknown, headers: Record<string, string> = {}) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
      res.end(JSON.stringify(obj));
    };
    const err = (status: number, code: string, message: string, extra: object = {}) =>
      send(status, { error: { code, message }, ...extra });

    if (req.headers.authorization !== `Bearer ${this.token}`) return err(401, "unauthorized", "Bad or missing token.");
    if (this.rateLimit > 0) {
      this.rateLimit -= 1;
      return send(429, { error: { code: "rate_limited", message: "Slow down." } }, { "Retry-After": this.retryAfter });
    }
    if (!url.pathname.startsWith("/api/v1/")) return err(404, "not_found", "No such route.");
    const parts = url.pathname.slice("/api/v1/".length).split("/");

    if (parts[0] === "me" && method === "GET") return send(200, { user: { id: "u1", email: this.email } });
    if (parts[0] === "projects" && parts.length === 1) {
      if (method === "GET") return send(200, { projects: [...this.projects.values()].map(projectOut) });
      if (method === "POST") {
        const b = (body ?? {}) as { name?: unknown; slug?: unknown; description?: unknown };
        if (typeof b.name !== "string" || !b.name.trim()) return err(422, "invalid_body", "name is required");
        const slug =
          typeof b.slug === "string"
            ? b.slug
            : b.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
        if (!/^[a-z0-9-]{1,64}$/.test(slug)) return err(422, "invalid_slug", "bad slug");
        if (this.projects.has(slug)) return err(409, "slug_taken", `The slug ${slug} is taken.`);
        const p = this.addProject(slug, b.name);
        if (typeof b.description === "string") p.description = b.description;
        return send(200, { project: projectOut(p), pages: pagesOut(p) });
      }
    }
    const project = parts[0] === "projects" ? this.projects.get(parts[1] ?? "") : undefined;
    if (parts[0] !== "projects" || !project) return err(404, "not_found", "Unknown project.");
    if (parts.length === 2 && method === "GET") return send(200, { project: projectOut(project), pages: pagesOut(project) });

    if (parts[2] !== "pages") return err(404, "not_found", "No such route.");
    let rest = parts.slice(3).join("/");
    let append = false;
    if (rest.endsWith("/append") && method === "POST") {
      append = true;
      rest = rest.slice(0, -"/append".length);
    }
    if (!PAGE_PATH.test(rest)) return err(422, "invalid_path", "Invalid page path.");
    const cur = project.pages.get(rest);
    const live = cur && !cur.deleted ? cur : undefined;

    const conflict = () =>
      send(409, { error: { code: "version_conflict", message: "The page changed." }, current: live ? full(rest, live) : null });

    if (method === "GET") return live ? send(200, { page: full(rest, live) }) : err(404, "not_found", "No such page.");

    if (append) {
      const b = body as { content?: unknown };
      if (!live) return err(404, "not_found", "No such page.");
      if (typeof b?.content !== "string") return err(422, "invalid_body", "content required");
      live.content = (live.content.endsWith("\n") ? live.content : live.content + "\n") + b.content;
      live.version += 1;
      live.updatedAt = now();
      return send(200, { page: meta(rest, live) });
    }

    if (method === "PUT") {
      const b = body as { content?: unknown; baseVersion?: unknown };
      if (typeof b?.content !== "string" || !Number.isInteger(b.baseVersion))
        return err(422, "invalid_body", "content and baseVersion required");
      if (Buffer.byteLength(b.content, "utf8") > 256 * 1024) return err(422, "too_large", "Page too large.");
      const base = b.baseVersion as number;
      if (base === 0) {
        if (live) return conflict();
        const version = (cur?.version ?? 0) + 1;
        const s: Stored = { content: b.content, version, updatedAt: now(), deleted: false };
        project.pages.set(rest, s);
        project.updatedAt = now();
        return send(200, { page: meta(rest, s) });
      }
      if (!live || live.version !== base) return conflict();
      if (live.content !== b.content) {
        live.content = b.content;
        live.version += 1;
        live.updatedAt = now();
        project.updatedAt = now();
      }
      return send(200, { page: meta(rest, live) });
    }

    if (method === "DELETE") {
      if (rest in STANDARD) return err(422, "standard_page", "Standard pages cannot be deleted.");
      const base = Number(url.searchParams.get("baseVersion"));
      if (!cur) return err(404, "not_found", "No such page.");
      if (!live || live.version !== base) return conflict();
      this.removePage(project.slug, rest);
      return send(200, { deleted: true });
    }
    return err(404, "not_found", "No such route.");
  }
}

const now = () => new Date().toISOString();
const meta = (path: string, s: Stored) => ({
  path,
  version: s.version,
  sha256: sha(s.content),
  size: Buffer.byteLength(s.content, "utf8"),
  updatedAt: s.updatedAt,
});
const full = (path: string, s: Stored) => ({ ...meta(path, s), content: s.content });
const pagesOut = (p: ProjectRec) => [...p.pages].filter(([, s]) => !s.deleted).map(([path, s]) => meta(path, s));
const projectOut = (p: ProjectRec) => ({ slug: p.slug, name: p.name, description: p.description, updatedAt: p.updatedAt });
