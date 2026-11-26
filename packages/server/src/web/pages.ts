import type { Context, Hono } from "hono";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { Deps } from "../deps.js";
import { exportResponse } from "../export/zip.js";
import { AppError } from "../service/errors.js";
import type { PageMeta, Project } from "../service/projects.js";
import { STANDARD_PAGES } from "../service/validate.js";
import {
  actorName,
  ago,
  bytes,
  flash,
  icon,
  lineDiff,
  mark,
  renderDiff,
  renderMarkdown,
  snippet,
  verb,
  who,
  type Flash,
  type Html,
} from "./render.js";
import { csrfOk, type WebEnv } from "./session.js";

type C = Context<WebEnv>;
type Status = 200 | 400 | 403 | 404 | 409 | 422 | 429;
type Kind = "app" | "flush" | "auth" | "status";

export interface ViewHelpers {
  view: (c: C, title: string, body: Html, status?: Status, kind?: Kind) => Response | Promise<Response>;
  csrfField: (c: C) => Html;
  requireUser: (c: C) => Response | null;
}

type PageRow = PageMeta & { lastActor: string | null };

/** What the browser writes as: the person themself. */
const WEB = "web";

const DESCRIPTIONS: Record<string, string> = {
  "overview.md": "What the project is, who it is for and where it stands.",
  "plan.md": "Where the work stands: the goal, the phases, what is happening now and what comes next.",
  "where.md": "Where the code lives, where it runs, the services it uses and how the parts connect.",
  "rules.md": "How to work on it: conventions, what never to do and who approves what.",
  "decisions.md": "What was decided, when and why. Newest first.",
  "open-questions.md": "What is still undecided.",
  "ideas.md": "Brainstorms nobody has committed to.",
  "log.md": "Short dated notes from each session.",
};

export function pageTitle(path: string): string {
  const base = path.replace(/^topics\//, "").replace(/\.md$/, "").replace(/-/g, " ");
  return base.charAt(0).toUpperCase() + base.slice(1);
}

const FLASHES: Record<string, Flash> = {
  saved: { kind: "ok", text: "Saved. Every connected agent sees the new version." },
  created: { kind: "ok", text: "Page created." },
  restored: { kind: "ok", text: "Restored. The old content is now the newest version." },
  "page-deleted": { kind: "ok", text: "Page deleted." },
  "project-created": { kind: "ok", text: "Project created with its standard pages. Ask an agent to fill them in, or edit them here." },
};

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** The page path after a route prefix such as /projects/:slug/edit/. */
function tail(c: C, segment: string): string {
  const m = new RegExp(`^/projects/[^/]+/${segment}/(.+)$`).exec(c.req.path);
  return m?.[1] ? decodeURIComponent(m[1]) : "";
}

function pageHref(slug: string, path: string, view: "pages" | "edit" | "history" | "delete-page" = "pages"): string {
  return `/projects/${slug}/${view}/${path}`;
}

function sortPages(pages: PageRow[]): { standard: PageRow[]; topics: PageRow[] } {
  const order = new Map<string, number>(STANDARD_PAGES.map((p, i) => [p, i]));
  const standard = pages.filter((p) => order.has(p.path)).sort((a, b) => order.get(a.path)! - order.get(b.path)!);
  const topics = pages.filter((p) => !order.has(p.path)).sort((a, b) => a.path.localeCompare(b.path));
  return { standard, topics };
}

/** The project shell: page list on the left, the current view on the right. */
function shell(project: Project, pages: PageRow[], current: string | null, content: Html, wide = false): Html {
  const { standard, topics } = sortPages(pages);
  const link = (p: PageRow) =>
    html`<li><a href="${pageHref(project.slug, p.path)}"${p.path === current ? raw(' aria-current="page"') : ""}>${icon(p.path.startsWith("topics/") ? "topic" : "page")}<span>${pageTitle(p.path)}</span></a></li>`;
  return html`<div class="shell">
    <aside class="side" aria-label="${project.name}">
      <div class="side-head">
        <a class="back" href="/projects">${icon("back")} Projects</a>
        <h1>${project.name}</h1>
        ${project.description ? html`<p>${project.description}</p>` : ""}
      </div>
      <nav aria-label="Pages">
        <h2>Pages</h2>
        <ul>${standard.map(link)}</ul>
        <h2>Topics</h2>
        <ul>
          ${topics.map(link)}
          <li><a href="/projects/${project.slug}/new-page"${current === "new" ? raw(' aria-current="page"') : ""}>${icon("plus")}<span>New topic</span></a></li>
        </ul>
      </nav>
      <div class="side-actions">
        <a href="/projects/${project.slug}/export.zip">${icon("download")} Download as zip</a>
        <a class="danger-link" href="/projects/${project.slug}/delete">${icon("trash")} Delete project</a>
      </div>
    </aside>
    <section class="doc${wide ? " doc-wide" : ""}">${content}</section>
  </div>`;
}

export function registerPageRoutes(app: Hono<WebEnv>, deps: Deps, h: ViewHelpers): void {
  const { service, limiter, config } = deps;
  const writeRule = { limit: config.webRateLimit, windowS: 60 };

  async function projectAndPages(c: C, slug: string) {
    return service.getProjectPages(c.get("user")!.id, slug);
  }

  // ---------- projects index ----------

  app.get("/projects", async (c) => {
    const gate = h.requireUser(c);
    if (gate) return gate;
    const userId = c.get("user")!.id;
    const [projects, activity] = await Promise.all([service.listProjectSummaries(userId), service.recentActivity(userId, 12)]);
    const done = FLASHES[c.req.query("done") ?? ""];
    if (!projects.length) {
      return h.view(
        c,
        "Projects",
        html`${flash(done)}<div class="empty">
          ${mark(48)}
          <h2>Your agents' shared memory starts here</h2>
          <p>A project is seven markdown pages that every agent you connect can read and write. Connect an agent, then ask it to start one.</p>
          <ol class="steps">
            <li><strong>Connect an agent</strong>Claude, ChatGPT, Claude Code or Codex. It takes a minute.</li>
            <li><strong>Start a project</strong>Say “start a project called Acme rebrand in Anywhere”.</li>
            <li><strong>Keep talking</strong>Say “add this to Anywhere” whenever something is worth keeping.</li>
          </ol>
          <div class="actions">
            <a class="btn" href="/welcome">Get started</a>
            <a class="btn btn-quiet" href="/projects/new">Create a project here</a>
          </div>
        </div>`,
      );
    }
    const tiles = projects.map(
      (p) => html`<li>
        <a class="tile" href="/projects/${p.slug}">
          <h2>${p.name}</h2>
          <p>${p.description || html`<span class="mono">${p.slug}</span>`}</p>
          <div class="meta"><span>${p.pages} pages</span><span>Updated ${ago(p.updatedAt)}</span></div>
        </a>
      </li>`,
    );
    const feed = activity.length
      ? html`<ol class="feed">
          ${activity.map(
            (a) => html`<li>
              <div class="item-main">
                <div>${who(a.actor)} <span class="muted">${verb(a.via, a.deleted, a.version)}</span>
                  ${a.live && !a.deleted ? html`<a href="${pageHref(a.project, a.path)}">${pageTitle(a.path)}</a>` : html`<span>${pageTitle(a.path)}</span>`}</div>
                <div class="item-sub">${a.projectName} · ${ago(a.createdAt)}</div>
              </div>
            </li>`,
          )}
        </ol>`
      : html`<p class="muted small">Changes from you and your agents show up here.</p>`;
    return h.view(
      c,
      "Projects",
      html`${flash(done)}
        <div class="head">
          <div><h1>Projects</h1><p>Every agent you connect reads and writes these.</p></div>
          <div class="actions"><a class="btn btn-quiet" href="/projects/new">${icon("plus")} New project</a></div>
        </div>
        <div class="projects">
          <ul class="grid">${tiles}</ul>
          <aside aria-labelledby="recent">
            <div class="aside-title"><h2 id="recent">Recent changes</h2></div>
            ${feed}
          </aside>
        </div>`,
    );
  });

  // ---------- new project ----------

  function newProjectPage(c: C, opts: { error?: string; name?: string; description?: string } = {}, status: Status = 200) {
    return h.view(
      c,
      "New project",
      html`<div class="settings-body">
        <div class="crumbs"><a href="/projects">Projects</a> /</div>
        <div class="head"><div><h1>New project</h1><p>It starts with the standard pages. Agents usually create projects themselves when you ask them to.</p></div></div>
        ${flash(opts.error ? { kind: "error", text: opts.error } : null)}
        <form method="post" action="/projects" class="card">
          ${h.csrfField(c)}
          <div class="field">
            <label for="name">Name</label>
            <input id="name" type="text" name="name" maxlength="100" required autofocus value="${opts.name ?? ""}" placeholder="Acme rebrand" />
          </div>
          <div class="field">
            <label for="description">Description <span class="muted">(optional)</span></label>
            <input id="description" type="text" name="description" maxlength="500" value="${opts.description ?? ""}" placeholder="New identity and site for Acme, launching in March" />
            <p class="hint">One line that tells an agent what this project is.</p>
          </div>
          <div class="form-actions"><button type="submit">Create project</button><a class="btn btn-ghost" href="/projects">Cancel</a></div>
        </form>
      </div>`,
      status,
    );
  }

  app.get("/projects/new", (c) => h.requireUser(c) ?? newProjectPage(c));

  app.post("/projects", async (c) => {
    const gate = h.requireUser(c);
    if (gate) return gate;
    const form = await c.req.parseBody();
    const name = str(form.name);
    const description = str(form.description).trim();
    if (!csrfOk(c, form._csrf)) return newProjectPage(c, { error: "This form expired. Try again.", name, description }, 403);
    try {
      const { project } = await service.createProject(c.get("user")!.id, { name, description }, WEB);
      return c.redirect(`/projects/${project.slug}?done=project-created`, 302);
    } catch (err) {
      if (err instanceof AppError && err.status !== 404) return newProjectPage(c, { error: err.message, name, description }, err.status === 409 ? 409 : 422);
      throw err;
    }
  });

  // ---------- reading a page ----------

  async function readPage(c: C, slug: string, path: string) {
    const userId = c.get("user")!.id;
    const [{ project, pages }, page] = await Promise.all([projectAndPages(c, slug), service.getPage(userId, slug, path)]);
    const meta = pages.find((p) => p.path === path);
    const done = FLASHES[c.req.query("done") ?? ""];
    const empty = !page.content.trim() || page.content.trim().split("\n").every((l) => /^#|^\s*$|^<!--/.test(l));
    const body = html`${flash(done)}
      <header class="doc-head">
        <div>
          <div class="path">${path}</div>
          <div class="meta">
            ${meta?.lastActor ? html`<span>${who(meta.lastActor)}</span>` : ""}
            <span>${ago(page.updatedAt)}</span>
            <span>Version ${page.version}</span>
          </div>
        </div>
        <div class="actions">
          <a class="btn btn-sm btn-quiet" href="${pageHref(slug, path, "history")}">${icon("history")} History</a>
          <a class="btn btn-sm" href="${pageHref(slug, path, "edit")}">${icon("edit")} Edit</a>
        </div>
      </header>
      ${DESCRIPTIONS[path] && empty ? html`<p class="muted" style="margin-block-end:1rem">${DESCRIPTIONS[path]}</p>` : ""}
      <article class="prose">${raw(renderMarkdown(page.content))}</article>
      ${empty ? html`<div class="prose-empty" style="margin-block-start:1.5rem">Nothing here yet. Tell an agent “add this to Anywhere”, or <a href="${pageHref(slug, path, "edit")}">write it yourself</a>.</div>` : ""}`;
    return h.view(c, `${pageTitle(path)} · ${project.name}`, shell(project, pages, path, body), 200, "flush");
  }

  app.get("/projects/:slug", async (c) => {
    const gate = h.requireUser(c);
    if (gate) return gate;
    return readPage(c, c.req.param("slug"), "overview.md");
  });

  app.get("/projects/:slug/pages/*", async (c) => {
    const gate = h.requireUser(c);
    if (gate) return gate;
    return readPage(c, c.req.param("slug"), tail(c, "pages"));
  });

  app.get("/projects/:slug/export.zip", async (c) => {
    const gate = h.requireUser(c);
    if (gate) return gate;
    return exportResponse(c, service, c.get("user")!.id, c.req.param("slug"), config.limits.maxExportBytes);
  });

  // ---------- editing ----------

  async function editPage(
    c: C,
    slug: string,
    path: string,
    opts: { content?: string; base?: number; conflict?: { by: string | null; version: number }; error?: string } = {},
    status: Status = 200,
  ) {
    const userId = c.get("user")!.id;
    const [{ project, pages }, page] = await Promise.all([projectAndPages(c, slug), service.getPage(userId, slug, path)]);
    const meta = pages.find((p) => p.path === path);
    const notice: Flash | null = opts.conflict
      ? {
          kind: "error",
          text: html`${actorName(opts.conflict.by)} changed this page while you were editing (now version ${opts.conflict.version}). Your text is below. <a href="${pageHref(slug, path)}" target="_blank" rel="noopener">Open their version</a>, merge what you need, then save again.`,
        }
      : opts.error
        ? { kind: "error", text: opts.error }
        : null;
    const body = html`<header class="doc-head">
        <div>
          <div class="path">${path}</div>
          <h2>Editing ${pageTitle(path)}</h2>
        </div>
        ${!STANDARD_PAGES.includes(path as (typeof STANDARD_PAGES)[number])
          ? html`<a class="btn btn-sm btn-danger" href="${pageHref(slug, path, "delete-page")}">${icon("trash")} Delete page</a>`
          : ""}
      </header>
      ${flash(notice)}
      <form class="editor" method="post" action="${pageHref(slug, path, "edit")}" data-save>
        ${h.csrfField(c)}
        <input type="hidden" name="baseVersion" value="${opts.base ?? page.version}" />
        <label class="sr" for="content">Markdown</label>
        <textarea id="content" name="content" spellcheck="true" autofocus>${opts.content ?? page.content}</textarea>
        <div class="editor-bar">
          <span class="muted">Markdown. Saving makes version ${(opts.base ?? page.version) + 1}${meta?.lastActor && meta.lastActor !== WEB ? html`; the current one is by ${actorName(meta.lastActor)}` : ""}. <kbd>⌘</kbd> <kbd>S</kbd> saves.</span>
          <div class="actions">
            <a class="btn btn-ghost" href="${pageHref(slug, path)}">Cancel</a>
            <button type="submit">Save</button>
          </div>
        </div>
      </form>`;
    return h.view(c, `Edit ${pageTitle(path)} · ${project.name}`, shell(project, pages, path, body, true), status, "flush");
  }

  app.get("/projects/:slug/edit/*", async (c) => {
    const gate = h.requireUser(c);
    if (gate) return gate;
    return editPage(c, c.req.param("slug"), tail(c, "edit"));
  });

  app.post("/projects/:slug/edit/*", async (c) => {
    const gate = h.requireUser(c);
    if (gate) return gate;
    const slug = c.req.param("slug");
    const path = tail(c, "edit");
    const form = await c.req.parseBody();
    const content = str(form.content).replace(/\r\n/g, "\n");
    const base = Number(str(form.baseVersion));
    if (!csrfOk(c, form._csrf)) return editPage(c, slug, path, { content, base, error: "This form expired. Your text is below; save again." }, 403);
    if ((await limiter.hit(`webwrite:${c.get("user")!.id}`, writeRule)) !== null) {
      return editPage(c, slug, path, { content, base, error: "Too many saves in a minute. Wait a moment and save again." }, 429);
    }
    try {
      await service.putPage(c.get("user")!.id, slug, path, content, base, WEB);
      return c.redirect(`${pageHref(slug, path)}?done=saved`, 302);
    } catch (err) {
      if (err instanceof AppError && err.code === "version_conflict") {
        const { pages } = await projectAndPages(c, slug);
        const now = pages.find((p) => p.path === path);
        if (!now) throw err;
        return editPage(c, slug, path, { content, base: now.version, conflict: { by: now.lastActor, version: now.version } }, 409);
      }
      if (err instanceof AppError && err.status === 422) return editPage(c, slug, path, { content, base, error: err.message }, 422);
      throw err;
    }
  });

  // ---------- new topic page ----------

  async function newTopicPage(c: C, slug: string, opts: { name?: string; content?: string; error?: string } = {}, status: Status = 200) {
    const { project, pages } = await projectAndPages(c, slug);
    const body = html`<header class="doc-head"><div><div class="path">topics/</div><h2>New topic page</h2></div></header>
      <p class="muted" style="max-width:40rem;margin-block-end:1.5rem">For one subject that has outgrown the standard pages, such as pricing, the brand or a client.</p>
      ${flash(opts.error ? { kind: "error", text: opts.error } : null)}
      <form class="editor" method="post" action="/projects/${slug}/new-page" data-save>
        ${h.csrfField(c)}
        <div class="field">
          <label for="name">Page name</label>
          <div class="prefixed"><span>topics/</span><input id="name" type="text" name="name" required maxlength="60" pattern="[a-z0-9][a-z0-9-]*" placeholder="pricing" value="${opts.name ?? ""}" autofocus /></div>
          <p class="hint">Lowercase letters, digits and hyphens.</p>
        </div>
        <label class="sr" for="content">Markdown</label>
        <textarea id="content" name="content" style="min-height:40vh">${opts.content ?? ""}</textarea>
        <div class="editor-bar"><span class="muted">Markdown.</span><div class="actions"><a class="btn btn-ghost" href="/projects/${slug}">Cancel</a><button type="submit">Create page</button></div></div>
      </form>`;
    return h.view(c, `New topic · ${project.name}`, shell(project, pages, "new", body, true), status, "flush");
  }

  app.get("/projects/:slug/new-page", async (c) => h.requireUser(c) ?? newTopicPage(c, c.req.param("slug")));

  app.post("/projects/:slug/new-page", async (c) => {
    const gate = h.requireUser(c);
    if (gate) return gate;
    const slug = c.req.param("slug");
    const form = await c.req.parseBody();
    const name = str(form.name).trim().toLowerCase().replace(/\.md$/, "");
    const content = str(form.content).replace(/\r\n/g, "\n") || `# ${pageTitle(`${name}.md`)}\n`;
    if (!csrfOk(c, form._csrf)) return newTopicPage(c, slug, { name, content, error: "This form expired. Try again." }, 403);
    const path = `topics/${name}.md`;
    try {
      await service.putPage(c.get("user")!.id, slug, path, content, 0, WEB);
      return c.redirect(`${pageHref(slug, path)}?done=created`, 302);
    } catch (err) {
      if (err instanceof AppError && err.code === "version_conflict") return newTopicPage(c, slug, { name, content, error: `topics/${name}.md already exists. Pick another name.` }, 409);
      if (err instanceof AppError && err.status === 422) return newTopicPage(c, slug, { name, content, error: err.message }, 422);
      throw err;
    }
  });

  // ---------- delete a topic page ----------

  app.get("/projects/:slug/delete-page/*", async (c) => {
    const gate = h.requireUser(c);
    if (gate) return gate;
    const slug = c.req.param("slug");
    const path = tail(c, "delete-page");
    const [{ project, pages }, page] = await Promise.all([projectAndPages(c, slug), service.getPage(c.get("user")!.id, slug, path)]);
    const body = html`<div class="card" style="max-width:32rem">
        <h2>Delete ${pageTitle(path)}?</h2>
        <p class="muted"><span class="mono">${path}</span> and its history are removed for you and every connected agent. This cannot be undone.</p>
        <form method="post" action="${pageHref(slug, path, "delete-page")}" class="form-actions">
          ${h.csrfField(c)}<input type="hidden" name="baseVersion" value="${page.version}" />
          <button type="submit" class="btn-solid-danger">Delete page</button>
          <a class="btn btn-ghost" href="${pageHref(slug, path)}">Cancel</a>
        </form>
      </div>`;
    return h.view(c, `Delete ${pageTitle(path)}`, shell(project, pages, path, body), 200, "flush");
  });

  app.post("/projects/:slug/delete-page/*", async (c) => {
    const gate = h.requireUser(c);
    if (gate) return gate;
    const slug = c.req.param("slug");
    const path = tail(c, "delete-page");
    const form = await c.req.parseBody();
    if (!csrfOk(c, form._csrf)) return c.redirect(pageHref(slug, path, "delete-page"), 302);
    try {
      await service.deletePage(c.get("user")!.id, slug, path, Number(str(form.baseVersion)), WEB);
    } catch (err) {
      if (err instanceof AppError && err.code === "version_conflict") return c.redirect(pageHref(slug, path, "delete-page"), 302);
      throw err;
    }
    return c.redirect(`/projects/${slug}?done=page-deleted`, 302);
  });

  // ---------- history ----------

  app.get("/projects/:slug/history/*", async (c) => {
    const gate = h.requireUser(c);
    if (gate) return gate;
    const slug = c.req.param("slug");
    const path = tail(c, "history");
    const userId = c.get("user")!.id;
    const [{ project, pages }, revisions] = await Promise.all([projectAndPages(c, slug), service.listRevisions(userId, slug, path)]);
    const current = pages.find((p) => p.path === path)?.version ?? null;
    const v = Number(c.req.query("v"));
    let detail: Html | HtmlEscapedString | "" = "";
    if (Number.isSafeInteger(v) && v > 0) {
      const { revision, previous } = await service.getRevision(userId, slug, path, v);
      const tab = c.req.query("show") === "content" ? "content" : "changes";
      const ops = previous !== null ? lineDiff(previous, revision.content) : null;
      const changes =
        previous === null
          ? html`<p class="muted">${revision.version === 1 ? "This is the first version: everything in it is new." : "The version before this one is no longer kept, so there is nothing to compare with."}</p>`
          : ops === null
            ? html`<p class="muted">This page is too long to compare line by line. Look at the content instead.</p>`
            : ops.every((o) => o.s === " ")
              ? html`<p class="muted">No changes to the text.</p>`
              : renderDiff(ops);
      detail = html`<div class="card" style="max-width:60rem;margin-block-end:2rem">
          <div class="row-card">
            <div>
              <h2>Version ${revision.version}</h2>
              <div class="meta" style="margin-block-start:0.35rem">${who(revision.actor)}<span>${verb(revision.via, revision.deleted, revision.version)} this page</span><span>${ago(revision.createdAt)}</span></div>
            </div>
            <div class="actions">
              ${current !== null && revision.version !== current && !revision.deleted
                ? html`<form method="post" action="/projects/${slug}/restore/${revision.version}/${path}" data-confirm="Make version ${revision.version} the newest version of this page?">
                    ${h.csrfField(c)}<input type="hidden" name="baseVersion" value="${current}" />
                    <button type="submit" class="btn-sm secondary">${icon("restore")} Restore this version</button>
                  </form>`
                : ""}
            </div>
          </div>
          ${revision.deleted
            ? html`<p class="muted">The page was deleted in this version.</p>`
            : html`<nav class="tabs-inline" aria-label="Show">
                  <a href="?v=${revision.version}"${tab === "changes" ? raw(' aria-current="page"') : ""}>Changes</a>
                  <a href="?v=${revision.version}&show=content"${tab === "content" ? raw(' aria-current="page"') : ""}>Content</a>
                </nav>
                ${tab === "changes" ? changes : html`<article class="prose">${raw(renderMarkdown(revision.content))}</article>`}`}
        </div>`;
    }
    const body = html`<header class="doc-head">
        <div><div class="path">${path}</div><h2>History of ${pageTitle(path)}</h2></div>
        <a class="btn btn-sm btn-quiet" href="${pageHref(slug, path)}">${icon("back")} Back to page</a>
      </header>
      ${detail}
      <ol class="list timeline" style="max-width:60rem">
        ${revisions.map(
          (r) => html`<li${r.version === current ? raw(' class="current"') : ""}>
            <a class="item" href="?v=${r.version}"${r.version === v ? raw(' aria-current="true"') : ""}>
              <span class="vnum">v${r.version}</span>
              <div class="item-main"><div>${who(r.actor)} <span class="muted">${verb(r.via, r.deleted, r.version)} this page</span></div></div>
              <div class="item-end">${r.version === current ? html`<span class="tag">Current</span> ` : ""}${bytes(r.size)} · ${ago(r.createdAt)}</div>
            </a>
          </li>`,
        )}
      </ol>
      <p class="muted small" style="margin-block-start:1rem">The last ${config.limits.revisionsKept} versions of each page are kept.</p>`;
    return h.view(c, `History · ${pageTitle(path)}`, shell(project, pages, path, body, true), 200, "flush");
  });

  app.post("/projects/:slug/restore/:version/*", async (c) => {
    const gate = h.requireUser(c);
    if (gate) return gate;
    const slug = c.req.param("slug");
    const version = Number(c.req.param("version"));
    const path = /^\/projects\/[^/]+\/restore\/\d+\/(.+)$/.exec(c.req.path)?.[1] ?? "";
    const form = await c.req.parseBody();
    if (!csrfOk(c, form._csrf)) return c.redirect(`${pageHref(slug, path, "history")}?v=${version}`, 302);
    const userId = c.get("user")!.id;
    const { revision } = await service.getRevision(userId, slug, path, version);
    try {
      await service.putPage(userId, slug, path, revision.content, Number(str(form.baseVersion)), WEB);
    } catch (err) {
      if (err instanceof AppError && err.code === "version_conflict") return c.redirect(`${pageHref(slug, path, "history")}?v=${version}`, 302);
      throw err;
    }
    return c.redirect(`${pageHref(slug, path)}?done=restored`, 302);
  });

  // ---------- search ----------

  app.get("/search", async (c) => {
    const gate = h.requireUser(c);
    if (gate) return gate;
    const q = (c.req.query("q") ?? "").slice(0, config.limits.maxSearchQuery);
    const results = q.trim() ? await service.search(c.get("user")!.id, q) : [];
    const list = !q.trim()
      ? html`<p class="muted">Search every page in every project. Words match their other forms, so “decide” finds “decided”. Put a phrase in quotes to match it exactly.</p>`
      : results.length
        ? html`<ol class="list results">
            ${results.map(
              (r) => html`<li><a class="item" href="${pageHref(r.project, r.path)}">
                ${icon(r.path.startsWith("topics/") ? "topic" : "page")}
                <div class="item-main">
                  <div class="item-title">${pageTitle(r.path)} <span class="muted small mono">${r.project}</span></div>
                  <p class="snippet">${snippet(r.snippet)}</p>
                </div>
              </a></li>`,
            )}
          </ol>`
        : html`<div class="empty"><h2>No pages match “${q}”</h2><p>Try fewer or different words.</p></div>`;
    return h.view(
      c,
      q ? `Search: ${q}` : "Search",
      html`<div class="head"><div><h1>Search</h1></div></div>
        <form class="search-big" role="search" action="/search" method="get">
          <label class="sr" for="q">Search all projects</label>
          <input id="q" type="search" name="q" value="${q}" placeholder="Search pages" autofocus />
          <button type="submit">Search</button>
        </form>
        ${q.trim() && results.length ? html`<p class="muted small" style="margin-block-end:0.75rem">${results.length === 20 ? "Top 20 matches" : `${results.length} match${results.length === 1 ? "" : "es"}`}</p>` : ""}
        ${list}`,
    );
  });
}
