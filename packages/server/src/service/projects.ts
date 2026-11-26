import type { Db } from "../db/db.js";
import { newId, sha256Hex } from "../auth/crypto.js";
import type { Layout } from "../content/layout.js";
import { DEFAULT_LIMITS, type Limits } from "../config.js";
import { AppError } from "./errors.js";
import { describeSecrets, findSecrets } from "./secrets.js";
import {
  MAX_PAGE_BYTES,
  STANDARD_PAGES,
  assertPath,
  assertSlug,
  deriveSlug,
  isStandardPage,
  MAX_GROUP,
  MAX_REPOS,
  normalizeRepo,
  PROJECT_STATUSES,
  type ProjectStatus,
  type StandardPath,
} from "./validate.js";

// Shapes from docs/api.md.
export interface Project {
  slug: string;
  name: string;
  description: string;
  /** The business or group it belongs to, such as a company or "Personal"; empty when none. */
  group: string;
  status: ProjectStatus;
  /** Code repositories that make up the project, each as "host/owner/name". */
  repos: string[];
  updatedAt: string;
}

/** What can be set on a project after it is made, and on create besides name and slug. */
export interface ProjectDetails {
  name?: unknown;
  description?: unknown;
  group?: unknown;
  status?: unknown;
  repos?: unknown;
}
export interface PageMeta {
  path: string;
  version: number;
  sha256: string;
  size: number;
  updatedAt: string;
}
export interface Page extends PageMeta {
  content: string;
}
export interface PageSummary extends PageMeta {
  firstLine: string;
}
export interface ProjectSummary extends Project {
  pages: number;
  lastActor: string | null;
}
export interface Revision {
  version: number;
  size: number;
  via: string;
  actor: string | null;
  deleted: boolean;
  createdAt: string;
}
export interface Briefing {
  project: Project;
  pages: Partial<Record<StandardPath, Page>>;
  recent: { path: string; version: number; via: string; actor: string | null; deleted: boolean; createdAt: string }[];
  stale: { path: string; updatedAt: string }[];
}
export interface Activity {
  project: string;
  projectName: string;
  path: string;
  version: number;
  via: string;
  actor: string | null;
  deleted: boolean;
  live: boolean;
  createdAt: string;
}
export interface SearchResult {
  project: string;
  path: string;
  version: number;
  snippet: string;
}

interface ProjectRow {
  id: string;
  user_id: string;
  slug: string;
  name: string;
  description: string;
  group_name: string;
  status: string;
  repos: unknown;
  updated_at: Date;
}
interface PageRow {
  id: string;
  path: string;
  content: Buffer;
  version: number;
  sha256: string;
  size: number;
  updated_at: Date;
  deleted_at: Date | null;
}

const toProject = (r: ProjectRow): Project => ({
  slug: r.slug,
  name: r.name,
  description: r.description,
  group: r.group_name ?? "",
  status: (PROJECT_STATUSES as readonly string[]).includes(r.status) ? (r.status as ProjectStatus) : "active",
  repos: repoList(r.repos),
  updatedAt: new Date(r.updated_at).toISOString(),
});

/** jsonb arrives parsed from pg and PGlite alike; anything else is treated as no repos. */
function repoList(v: unknown): string[] {
  const arr = typeof v === "string" ? (JSON.parse(v) as unknown) : v;
  return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
}
const toMeta = (r: PageRow): PageMeta => ({
  path: r.path,
  version: r.version,
  sha256: r.sha256,
  size: r.size,
  updatedAt: new Date(r.updated_at).toISOString(),
});
const toPage = (r: PageRow): Page => ({ ...toMeta(r), content: r.content.toString("utf8") });

const PAGE_META_COLS = "id, path, version, sha256, size, updated_at, deleted_at";
const PAGE_COLS = `${PAGE_META_COLS}, content`;
const MAX_NAME = 200;
const MAX_DESCRIPTION = 1000;
const PROJECT_COLS = "id, user_id, slug, name, description, group_name, status, repos, updated_at";
/** Bytes of each page read for get_project's first lines (audit D3). */
const HEAD_BYTES = 1024;
/** Characters of a page ts_headline looks at for a snippet (audit D4). */
const SNIPPET_SOURCE_CHARS = 20_000;
/** Pages fetched per round trip while streaming an export. */
export const EXPORT_BATCH = 16;

export interface Usage {
  bytes: number;
  projects: number;
  limits: Limits;
}

type Via = "write" | "append";

function mb(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

/** NUL and other C0 controls (except tab) have no place in a name or description (audit D8). */
function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) return true;
  }
  return false;
}

type CheckedDetails = { name?: string; description?: string; group_name?: string; status?: ProjectStatus; repos?: string[] };

/**
 * Checks the optional details of a project and returns the database values for those given.
 * Repos are normalised and de-duplicated, so any spelling of a remote finds the project.
 */
/**
 * Anywhere never stores a key, token or password: pages are shared with every agent a person
 * connects. The error names what was found and where, never the value.
 */
function refuseSecrets(text: string, where: string): void {
  const found = findSecrets(text);
  if (!found.length) return;
  throw new AppError(
    422,
    "contains_secret",
    `${where} looks like it contains a secret: ${describeSecrets(found)}. Anywhere does not store keys, tokens or passwords. ` +
      `Remove it, or say where it is kept instead (for example "in Vercel environment variables as STRIPE_SECRET_KEY"), and write again.`,
    { secrets: found },
  );
}

function checkDetails(d: ProjectDetails): CheckedDetails {
  const out: CheckedDetails = {};
  if (d.name !== undefined) {
    if (typeof d.name !== "string" || !d.name.trim() || d.name.length > MAX_NAME || hasControl(d.name)) {
      throw new AppError(422, "invalid_body", `name must be a non-empty string of at most ${MAX_NAME} characters.`);
    }
    refuseSecrets(d.name, "The name");
    out.name = d.name.trim();
  }
  if (d.description !== undefined) {
    if (typeof d.description !== "string" || d.description.length > MAX_DESCRIPTION || hasControl(d.description)) {
      throw new AppError(422, "invalid_body", `description must be a string of at most ${MAX_DESCRIPTION} characters.`);
    }
    refuseSecrets(d.description, "The description");
    out.description = d.description;
  }
  if (d.group !== undefined) {
    if (typeof d.group !== "string" || d.group.length > MAX_GROUP || hasControl(d.group)) {
      throw new AppError(422, "invalid_body", `group must be a string of at most ${MAX_GROUP} characters.`);
    }
    refuseSecrets(d.group, "The group");
    out.group_name = d.group.trim();
  }
  if (d.status !== undefined) {
    if (typeof d.status !== "string" || !(PROJECT_STATUSES as readonly string[]).includes(d.status)) {
      throw new AppError(422, "invalid_body", `status must be one of ${PROJECT_STATUSES.join(", ")}.`);
    }
    out.status = d.status as ProjectStatus;
  }
  if (d.repos !== undefined) {
    if (!Array.isArray(d.repos) || d.repos.length > MAX_REPOS) {
      throw new AppError(422, "invalid_body", `repos must be a list of at most ${MAX_REPOS} repository addresses.`);
    }
    const repos: string[] = [];
    for (const r of d.repos) {
      const n = normalizeRepo(r);
      if (!n) {
        throw new AppError(
          422,
          "invalid_body",
          `"${String(r).slice(0, 120)}" is not a repository address. Use its git remote, such as github.com/owner/name.`,
        );
      }
      if (!repos.includes(n)) repos.push(n);
    }
    out.repos = repos;
  }
  return out;
}

function firstNonEmptyLine(content: string): string {
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (t) return t.slice(0, 200);
  }
  return "";
}

function notFoundProject(slug: string): AppError {
  return new AppError(404, "not_found", `No project "${slug}". Use list_projects to see the slugs you have.`);
}
function notFoundPage(slug: string, path: string): AppError {
  return new AppError(404, "not_found", `No page "${path}" in project "${slug}".`);
}
function conflict(path: string, current: Page | null): AppError {
  const message = current
    ? `"${path}" has changed: it is now at version ${current.version}. Merge your change into the current content and write again with that version.`
    : `"${path}" does not exist on the server (it was deleted or never created). Create it with baseVersion 0 if it should exist.`;
  return new AppError(409, "version_conflict", message, { current });
}

function checkContent(content: unknown): Buffer {
  if (typeof content !== "string") throw new AppError(422, "invalid_body", "content must be a string.");
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length > MAX_PAGE_BYTES) {
    throw new AppError(422, "too_large", `Pages are limited to ${MAX_PAGE_BYTES} bytes; this one would be ${bytes.length}.`);
  }
  refuseSecrets(content, "This page");
  return bytes;
}

function checkVersion(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    throw new AppError(422, "invalid_body", "baseVersion must be a non-negative integer.");
  }
  return v;
}

export function createService(db: Db, layout: Layout, limits: Limits = DEFAULT_LIMITS) {
  const quotaError = () =>
    new AppError(
      422,
      "quota_exceeded",
      `This account has reached its storage limit of ${mb(limits.maxBytesPerUser)} (pages plus their recent history). Delete pages or projects you no longer need, or make the page shorter.`,
    );

  async function findProject(q: Db, userId: string, slug: string, lock = false): Promise<ProjectRow> {
    // A slug that cannot exist is not looked up (audit D8); it is still a 404, as docs/api.md says.
    if (typeof slug !== "string" || !/^[a-z0-9-]{1,64}$/.test(slug)) throw notFoundProject(String(slug).slice(0, 80));
    const rows = await q.query<ProjectRow>(
      `SELECT ${PROJECT_COLS} FROM projects WHERE user_id = $1 AND slug = $2${lock ? " FOR UPDATE" : ""}`,
      [userId, slug],
    );
    if (!rows[0]) throw notFoundProject(slug);
    return rows[0];
  }

  async function findPageRow(q: Db, projectId: string, path: string): Promise<PageRow | undefined> {
    const rows = await q.query<PageRow>(`SELECT ${PAGE_COLS} FROM pages WHERE project_id = $1 AND path = $2`, [
      projectId,
      path,
    ]);
    return rows[0];
  }

  /** Adds `delta` bytes to the user's storage, refusing to go over the quota. Runs inside the write transaction. */
  async function charge(tx: Db, userId: string, delta: number): Promise<void> {
    if (delta === 0) return;
    const rows = await tx.query(
      `UPDATE users SET storage_bytes = GREATEST(0, storage_bytes + $2)
        WHERE id = $1 AND ($2 <= 0 OR storage_bytes + $2 <= $3) RETURNING storage_bytes`,
      [userId, delta, limits.maxBytesPerUser],
    );
    if (!rows[0]) throw quotaError();
  }

  /**
   * Writes a new version (insert or update), records the revision, trims old revisions, charges the
   * quota and touches the project. The project row is locked by the caller, so the page-count check
   * cannot race (audit D2).
   */
  async function writeVersion(
    tx: Db,
    project: ProjectRow,
    existing: PageRow | undefined,
    path: string,
    bytes: Buffer,
    via: Via = "write",
    actor: string | null = null,
  ): Promise<PageMeta> {
    if (!live(existing)) {
      const [counts] = await tx.query<{ live: string; total: string }>(
        "SELECT count(*) FILTER (WHERE deleted_at IS NULL) AS live, count(*) AS total FROM pages WHERE project_id = $1",
        [project.id],
      );
      if (Number(counts?.live ?? 0) >= limits.maxPagesPerProject) {
        throw new AppError(422, "quota_exceeded", `A project can have at most ${limits.maxPagesPerProject} pages. Merge or delete pages first.`);
      }
      // Deleted pages keep a small tombstone row; bound those too so create-and-delete cannot grow forever.
      if (!existing && Number(counts?.total ?? 0) >= limits.maxPagesPerProject * 4) {
        throw new AppError(422, "quota_exceeded", "This project has had too many pages created and deleted. Reuse an existing page path.");
      }
    }
    const version = existing ? existing.version + 1 : 1;
    const searchText = bytes.toString("utf8").replaceAll("\0", " "); // Postgres text cannot hold NUL
    const params = [bytes, searchText, version, sha256Hex(bytes), bytes.length];
    let rows: PageRow[];
    let freed = 0;
    if (existing) {
      if (via === "append" && limits.appendCoalesceSeconds > 0) {
        // A run of appends keeps one revision: the previous one is a prefix of the new content.
        const [gone] = await tx.query<{ size: string | null }>(
          `WITH d AS (DELETE FROM revisions WHERE page_id = $1 AND version = $2 AND via = 'append'
                        AND created_at > now() - make_interval(secs => $3) RETURNING size)
           SELECT COALESCE(sum(size), 0) AS size FROM d`,
          [existing.id, existing.version, limits.appendCoalesceSeconds],
        );
        freed += Number(gone?.size ?? 0);
      }
      rows = await tx.query<PageRow>(
        `UPDATE pages SET content = $1, search_text = $2, search = to_tsvector('english', $2), version = $3,
                sha256 = $4, size = $5, updated_at = now(), deleted_at = NULL
          WHERE id = $6 RETURNING ${PAGE_META_COLS}`,
        [...params, existing.id],
      );
    } else {
      rows = await tx.query<PageRow>(
        `INSERT INTO pages (id, project_id, path, content, search_text, search, version, sha256, size)
         VALUES ($6, $7, $8, $1, $2, to_tsvector('english', $2), $3, $4, $5) RETURNING ${PAGE_META_COLS}`,
        [...params, newId(), project.id, path],
      );
    }
    const row = rows[0]!;
    await tx.query("INSERT INTO revisions (page_id, version, content, sha256, size, via, actor) VALUES ($1, $2, $3, $4, $5, $6, $7)", [
      row.id,
      version,
      bytes,
      row.sha256,
      row.size,
      via,
      actor,
    ]);
    // Keep the last N revisions of the page (the current version is one of them).
    const [trimmed] = await tx.query<{ size: string | null }>(
      `WITH d AS (DELETE FROM revisions WHERE page_id = $1 AND version <= $2 RETURNING size)
       SELECT COALESCE(sum(size), 0) AS size FROM d`,
      [row.id, version - limits.revisionsKept],
    );
    freed += Number(trimmed?.size ?? 0);
    // New page content replaces the old, and the new revision is a second copy.
    await charge(tx, project.user_id, bytes.length - (existing?.size ?? 0) + bytes.length - freed);
    await tx.query("UPDATE projects SET updated_at = now() WHERE id = $1", [project.id]);
    return toMeta(row);
  }

  function live(row: PageRow | undefined): row is PageRow {
    return !!row && row.deleted_at === null;
  }

  /**
   * Projects made before a standard page existed (plan.md arrived after the first release) get it
   * the first time they are opened. A page someone deleted on purpose is not a standard page, so it
   * cannot be in that state; a missing row is the only case. Failures (a full quota) are ignored.
   */
  async function fillStandardPages(project: ProjectRow): Promise<void> {
    const rows = await db.query<{ path: string }>(
      "SELECT path FROM pages WHERE project_id = $1 AND path = ANY($2::text[])",
      [project.id, [...STANDARD_PAGES]],
    );
    const have = new Set(rows.map((r) => r.path));
    const missing = STANDARD_PAGES.filter((p) => !have.has(p));
    if (!missing.length) return;
    try {
      await db.transaction(async (tx) => {
        const locked = await findProject(tx, project.user_id, project.slug, true);
        for (const path of missing) {
          if (await findPageRow(tx, locked.id, path)) continue;
          await writeVersion(tx, locked, undefined, path, Buffer.from(layout.templates[path], "utf8"), "write", "anywhere");
        }
      });
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
    }
  }

  return {
    /** Every project, or with `repo` only those made up of that repository (any spelling of its remote). */
    async listProjects(userId: string, options: { repo?: unknown } = {}): Promise<Project[]> {
      if (options.repo !== undefined) {
        const repo = normalizeRepo(options.repo);
        if (!repo) {
          throw new AppError(422, "invalid_body", "repo must be a repository address, such as github.com/owner/name or a git remote URL.");
        }
        const rows = await db.query<ProjectRow>(
          `SELECT ${PROJECT_COLS} FROM projects WHERE user_id = $1 AND repos @> $2::jsonb ORDER BY updated_at DESC, slug`,
          [userId, JSON.stringify([repo])],
        );
        return rows.map(toProject);
      }
      const rows = await db.query<ProjectRow>(
        `SELECT ${PROJECT_COLS} FROM projects WHERE user_id = $1 ORDER BY updated_at DESC, slug`,
        [userId],
      );
      return rows.map(toProject);
    },

    /** Changes a project's name, description, group, status or repos; its pages are untouched. */
    async updateProject(userId: string, slug: string, details: ProjectDetails): Promise<Project> {
      const set = checkDetails(details);
      const cols = Object.keys(set) as (keyof CheckedDetails)[];
      if (!cols.length) {
        throw new AppError(422, "invalid_body", "Give at least one of name, description, group, status or repos.");
      }
      return db.transaction(async (tx) => {
        const row = await findProject(tx, userId, slug, true);
        const values = cols.map((c) => (c === "repos" ? JSON.stringify(set[c]) : set[c]));
        const assignments = cols.map((c, i) => `${c} = $${i + 2}${c === "repos" ? "::jsonb" : ""}`).join(", ");
        const [fresh] = await tx.query<ProjectRow>(
          `UPDATE projects SET ${assignments}, updated_at = now() WHERE id = $1 RETURNING ${PROJECT_COLS}`,
          [row.id, ...values],
        );
        return toProject(fresh!);
      });
    },

    async createProject(
      userId: string,
      input: { name: unknown; slug?: unknown } & Omit<ProjectDetails, "name">,
      actor: string | null = null,
    ): Promise<{ project: Project; pages: PageMeta[] }> {
      const { name, slug: rawSlug, description = "" } = input;
      const extra = checkDetails({ group: input.group, status: input.status, repos: input.repos });
      if (typeof name !== "string" || !name.trim() || name.length > MAX_NAME) {
        throw new AppError(422, "invalid_body", `name must be a non-empty string of at most ${MAX_NAME} characters.`);
      }
      if (typeof description !== "string" || description.length > MAX_DESCRIPTION) {
        throw new AppError(422, "invalid_body", `description must be a string of at most ${MAX_DESCRIPTION} characters.`);
      }
      refuseSecrets(name, "The name");
      refuseSecrets(description, "The description");
      if (rawSlug !== undefined && typeof rawSlug !== "string") {
        throw new AppError(422, "invalid_slug", "slug must be a string.");
      }
      if (hasControl(name) || hasControl(description)) {
        throw new AppError(422, "invalid_body", "name and description cannot contain control characters.");
      }
      const slug = rawSlug ?? deriveSlug(name);
      assertSlug(slug);
      return db.transaction(async (tx) => {
        // Locking the user row serialises project creation per user, so the count cannot race.
        const [count] = await tx.query<{ n: string }>(
          "SELECT (SELECT count(*) FROM projects WHERE user_id = $1) AS n FROM users WHERE id = $1 FOR UPDATE",
          [userId],
        );
        if (Number(count?.n ?? 0) >= limits.maxProjectsPerUser) {
          throw new AppError(422, "quota_exceeded", `An account can have at most ${limits.maxProjectsPerUser} projects. Delete one you no longer need first.`);
        }
        const rows = await tx.query<ProjectRow>(
          `INSERT INTO projects (id, user_id, slug, name, description, group_name, status, repos)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
           ON CONFLICT (user_id, slug) DO NOTHING RETURNING ${PROJECT_COLS}`,
          [newId(), userId, slug, name.trim(), description, extra.group_name ?? "", extra.status ?? "active", JSON.stringify(extra.repos ?? [])],
        );
        const row = rows[0];
        if (!row) throw new AppError(409, "slug_taken", `You already have a project with the slug "${slug}".`);
        const pages: PageMeta[] = [];
        for (const path of STANDARD_PAGES) {
          pages.push(await writeVersion(tx, row, undefined, path, Buffer.from(layout.templates[path], "utf8"), "write", actor));
        }
        const [fresh] = await tx.query<ProjectRow>(`SELECT ${PROJECT_COLS} FROM projects WHERE id = $1`, [row.id]);
        return { project: toProject(fresh!), pages };
      });
    },

    async getProject(userId: string, slug: string): Promise<{ project: Project; pages: PageMeta[] }> {
      const project = await findProject(db, userId, slug);
      const rows = await db.query<PageRow>(
        `SELECT ${PAGE_META_COLS} FROM pages WHERE project_id = $1 AND deleted_at IS NULL ORDER BY path`,
        [project.id],
      );
      return { project: toProject(project), pages: rows.map(toMeta) };
    },

    /**
     * For the get_project tool: each page's first non-empty line plus overview.md in full. Only the
     * first kilobyte of each page is read, so memory stays bounded however big the project is (audit D3).
     */
    async getProjectWithOverview(
      userId: string,
      slug: string,
    ): Promise<{ project: Project; pages: PageSummary[]; overview: Page | null }> {
      const project = await findProject(db, userId, slug);
      await fillStandardPages(project);
      const rows = await db.query<PageRow & { head: Buffer }>(
        `SELECT ${PAGE_META_COLS}, substring(content from 1 for ${HEAD_BYTES}) AS head
           FROM pages WHERE project_id = $1 AND deleted_at IS NULL ORDER BY path`,
        [project.id],
      );
      const overviewRow = await findPageRow(db, project.id, "overview.md");
      return {
        project: toProject(project),
        // A cut multi-byte character decodes as U+FFFD; first lines are at most 200 characters anyway.
        pages: rows.map((r) => ({ ...toMeta(r), firstLine: firstNonEmptyLine(r.head.toString("utf8").replace(/\uFFFD+$/, "")) })),
        overview: live(overviewRow) ? toPage(overviewRow) : null,
      };
    },

    async getPage(userId: string, slug: string, path: string): Promise<Page> {
      assertPath(path);
      const project = await findProject(db, userId, slug);
      const row = await findPageRow(db, project.id, path);
      if (!live(row)) throw notFoundPage(slug, path);
      return toPage(row);
    },

    /** Count and total size of a project's live pages, checked before an export starts. */
    async exportSize(userId: string, slug: string): Promise<{ project: Project; pages: number; bytes: number }> {
      const project = await findProject(db, userId, slug);
      const [row] = await db.query<{ n: string; bytes: string }>(
        "SELECT count(*) AS n, COALESCE(sum(size), 0) AS bytes FROM pages WHERE project_id = $1 AND deleted_at IS NULL",
        [project.id],
      );
      return { project: toProject(project), pages: Number(row?.n ?? 0), bytes: Number(row?.bytes ?? 0) };
    },

    /**
     * Live pages in path order, fetched a batch at a time by keyset, so an export holds at most
     * one batch of pages in memory (audit D3). Not a snapshot: a write during a long export may
     * land on either side of it.
     */
    async *iteratePages(userId: string, slug: string, batch = EXPORT_BATCH): AsyncGenerator<Page> {
      const project = await findProject(db, userId, slug);
      let after = "";
      for (;;) {
        const rows = await db.query<PageRow>(
          `SELECT ${PAGE_COLS} FROM pages WHERE project_id = $1 AND deleted_at IS NULL AND path > $2 ORDER BY path LIMIT $3`,
          [project.id, after, batch],
        );
        for (const r of rows) yield toPage(r);
        if (rows.length < batch) return;
        after = rows[rows.length - 1]!.path;
      }
    },

    async putPage(userId: string, slug: string, path: string, content: unknown, baseVersion: unknown, actor: string | null = null): Promise<PageMeta> {
      assertPath(path);
      const bytes = checkContent(content);
      const base = checkVersion(baseVersion);
      return db.transaction(async (tx) => {
        const project = await findProject(tx, userId, slug, true);
        const row = await findPageRow(tx, project.id, path);
        if (base === 0) {
          if (live(row)) throw conflict(path, toPage(row));
          return writeVersion(tx, project, row, path, bytes, "write", actor);
        }
        // Deleted or never created: the client's version cannot match, so it is a conflict with current null.
        if (!live(row)) throw conflict(path, null);
        if (row.version !== base) throw conflict(path, toPage(row));
        if (row.content.equals(bytes)) return toMeta(row);
        return writeVersion(tx, project, row, path, bytes, "write", actor);
      });
    },

    async appendPage(userId: string, slug: string, path: string, content: unknown, actor: string | null = null): Promise<PageMeta> {
      assertPath(path);
      checkContent(content);
      return db.transaction(async (tx) => {
        const project = await findProject(tx, userId, slug, true);
        const row = await findPageRow(tx, project.id, path);
        if (!live(row)) throw notFoundPage(slug, path);
        const sep = row.content.length === 0 || row.content[row.content.length - 1] === 0x0a ? "" : "\n";
        const bytes = Buffer.concat([row.content, Buffer.from(sep + (content as string), "utf8")]);
        if (bytes.length > MAX_PAGE_BYTES) {
          throw new AppError(422, "too_large", `Pages are limited to ${MAX_PAGE_BYTES} bytes; this append would make it ${bytes.length}.`);
        }
        return writeVersion(tx, project, row, path, bytes, "append", actor);
      });
    },

    async deletePage(userId: string, slug: string, path: string, baseVersion: unknown, actor: string | null = null): Promise<void> {
      assertPath(path);
      const base = checkVersion(baseVersion);
      await db.transaction(async (tx) => {
        const project = await findProject(tx, userId, slug, true);
        // After the project lookup, so someone else's slug is a 404 whatever the path.
        if (isStandardPage(path)) {
          throw new AppError(422, "standard_page", `"${path}" is a standard page and cannot be deleted. It can be emptied.`);
        }
        const row = await findPageRow(tx, project.id, path);
        if (!row) throw notFoundPage(slug, path);
        if (!live(row)) throw conflict(path, null);
        if (row.version !== base) throw conflict(path, toPage(row));
        const version = row.version + 1;
        await tx.query(
          `UPDATE pages SET content = '\\x'::bytea, search_text = '', search = ''::tsvector, version = $1,
                  sha256 = $2, size = 0, updated_at = now(), deleted_at = now() WHERE id = $3`,
          [version, sha256Hex(""), row.id],
        );
        // A deleted page's earlier versions go with it (audit D5); the tombstone revision stays.
        const [purged] = await tx.query<{ size: string | null }>(
          "WITH d AS (DELETE FROM revisions WHERE page_id = $1 RETURNING size) SELECT COALESCE(sum(size), 0) AS size FROM d",
          [row.id],
        );
        await tx.query("INSERT INTO revisions (page_id, version, deleted, via, actor) VALUES ($1, $2, true, 'delete', $3)", [row.id, version, actor]);
        await charge(tx, project.user_id, -(row.size + Number(purged?.size ?? 0)));
        await tx.query("UPDATE projects SET updated_at = now() WHERE id = $1", [project.id]);
      });
    },

    /** Deletes a project with all its pages and history (audit D5). Callers re-authenticate first. */
    async deleteProject(userId: string, slug: string): Promise<void> {
      await db.transaction(async (tx) => {
        const project = await findProject(tx, userId, slug, true);
        const [sizes] = await tx.query<{ bytes: string }>(
          `SELECT COALESCE((SELECT sum(size) FROM pages WHERE project_id = $1), 0)
                + COALESCE((SELECT sum(r.size) FROM revisions r JOIN pages p ON p.id = r.page_id WHERE p.project_id = $1), 0) AS bytes`,
          [project.id],
        );
        await tx.query("DELETE FROM projects WHERE id = $1", [project.id]);
        await charge(tx, userId, -Number(sizes?.bytes ?? 0));
      });
    },

    /** Projects for the web list: page counts and who changed each one last. */
    async listProjectSummaries(userId: string): Promise<ProjectSummary[]> {
      const rows = await db.query<ProjectRow & { pages: string; last_actor: string | null }>(
        `SELECT ${PROJECT_COLS},
                (SELECT count(*) FROM pages p WHERE p.project_id = projects.id AND p.deleted_at IS NULL) AS pages,
                (SELECT r.actor FROM revisions r JOIN pages p ON p.id = r.page_id
                  WHERE p.project_id = projects.id ORDER BY r.created_at DESC, r.version DESC LIMIT 1) AS last_actor
           FROM projects WHERE user_id = $1 ORDER BY updated_at DESC, slug`,
        [userId],
      );
      return rows.map((r) => ({ ...toProject(r), pages: Number(r.pages), lastActor: r.last_actor }));
    },

    /** Live pages of a project with who changed each one last, for the web sidebar and index. */
    async getProjectPages(userId: string, slug: string): Promise<{ project: Project; pages: (PageMeta & { lastActor: string | null })[] }> {
      const project = await findProject(db, userId, slug);
      await fillStandardPages(project);
      const rows = await db.query<PageRow & { last_actor: string | null }>(
        `SELECT ${PAGE_META_COLS},
                (SELECT r.actor FROM revisions r WHERE r.page_id = pages.id ORDER BY r.version DESC LIMIT 1) AS last_actor
           FROM pages WHERE project_id = $1 AND deleted_at IS NULL ORDER BY path`,
        [project.id],
      );
      return { project: toProject(project), pages: rows.map((r) => ({ ...toMeta(r), lastActor: r.last_actor })) };
    },

    /** The kept versions of one page, newest first. */
    async listRevisions(userId: string, slug: string, path: string): Promise<Revision[]> {
      assertPath(path);
      const project = await findProject(db, userId, slug);
      const row = await findPageRow(db, project.id, path);
      if (!row) throw notFoundPage(slug, path);
      const rows = await db.query<{ version: number; size: number | null; via: string; actor: string | null; deleted: boolean; created_at: Date }>(
        "SELECT version, size, via, actor, deleted, created_at FROM revisions WHERE page_id = $1 ORDER BY version DESC",
        [row.id],
      );
      return rows.map((r) => ({
        version: r.version,
        size: r.size ?? 0,
        via: r.via,
        actor: r.actor,
        deleted: r.deleted,
        createdAt: new Date(r.created_at).toISOString(),
      }));
    },

    /** One kept version's content, and the kept version before it (for a diff), if any. */
    async getRevision(
      userId: string,
      slug: string,
      path: string,
      version: number,
    ): Promise<{ revision: Revision & { content: string }; previous: string | null; current: number | null }> {
      assertPath(path);
      const project = await findProject(db, userId, slug);
      const row = await findPageRow(db, project.id, path);
      if (!row || !Number.isSafeInteger(version)) throw notFoundPage(slug, path);
      const rows = await db.query<{ version: number; content: Buffer | null; size: number | null; via: string; actor: string | null; deleted: boolean; created_at: Date }>(
        `SELECT version, content, size, via, actor, deleted, created_at FROM revisions
          WHERE page_id = $1 AND version <= $2 ORDER BY version DESC LIMIT 2`,
        [row.id, version],
      );
      const r = rows[0];
      if (!r || r.version !== version) throw new AppError(404, "not_found", `Version ${version} of "${path}" is not kept any more.`);
      const prev = rows[1];
      return {
        revision: {
          version: r.version,
          size: r.size ?? 0,
          via: r.via,
          actor: r.actor,
          deleted: r.deleted,
          createdAt: new Date(r.created_at).toISOString(),
          content: r.content ? r.content.toString("utf8") : "",
        },
        previous: prev && prev.version === version - 1 && prev.content ? prev.content.toString("utf8") : null,
        current: live(row) ? row.version : null,
      };
    },

    /**
     * What an agent needs to carry on with a project, in one read: the project, its standard pages in
     * full (they are kept short), the latest changes with who made them, and pages nobody has touched
     * in a long time. Formatting it into a short briefing is the caller's job.
     */
    async resume(userId: string, slug: string, staleDays = 90): Promise<Briefing> {
      const project = await findProject(db, userId, slug);
      await fillStandardPages(project);
      const rows = await db.query<PageRow>(
        `SELECT ${PAGE_COLS} FROM pages WHERE project_id = $1 AND deleted_at IS NULL AND path = ANY($2::text[])`,
        [project.id, [...STANDARD_PAGES]],
      );
      const pages: Partial<Record<StandardPath, Page>> = {};
      for (const r of rows) pages[r.path as StandardPath] = toPage(r);
      const recent = await db.query<{ path: string; version: number; via: string; actor: string | null; deleted: boolean; created_at: Date }>(
        `SELECT p.path, r.version, r.via, r.actor, r.deleted, r.created_at
           FROM revisions r JOIN pages p ON p.id = r.page_id
          WHERE p.project_id = $1 AND (r.actor IS NULL OR r.actor <> 'anywhere')
          ORDER BY r.created_at DESC, r.version DESC LIMIT 6`,
        [project.id],
      );
      const stale = await db.query<{ path: string; updated_at: Date }>(
        `SELECT path, updated_at FROM pages
          WHERE project_id = $1 AND deleted_at IS NULL AND updated_at < now() - make_interval(days => $2)
          ORDER BY updated_at`,
        [project.id, staleDays],
      );
      return {
        project: toProject(project),
        pages,
        recent: recent.map((r) => ({
          path: r.path,
          version: r.version,
          via: r.via,
          actor: r.actor,
          deleted: r.deleted,
          createdAt: new Date(r.created_at).toISOString(),
        })),
        stale: stale.map((r) => ({ path: r.path, updatedAt: new Date(r.updated_at).toISOString() })),
      };
    },

    /** The latest changes across all of a person's projects, newest first. */
    async recentActivity(userId: string, limit = 20): Promise<Activity[]> {
      const rows = await db.query<{ project: string; name: string; path: string; version: number; via: string; actor: string | null; deleted: boolean; created_at: Date; live: boolean }>(
        `SELECT pr.slug AS project, pr.name, p.path, r.version, r.via, r.actor, r.deleted, r.created_at,
                (p.deleted_at IS NULL) AS live
           FROM revisions r JOIN pages p ON p.id = r.page_id JOIN projects pr ON pr.id = p.project_id
          WHERE pr.user_id = $1
          ORDER BY r.created_at DESC, r.version DESC LIMIT $2`,
        [userId, Math.min(Math.max(1, limit), 100)],
      );
      return rows.map((r) => ({
        project: r.project,
        projectName: r.name,
        path: r.path,
        version: r.version,
        via: r.via,
        actor: r.actor,
        deleted: r.deleted,
        live: r.live,
        createdAt: new Date(r.created_at).toISOString(),
      }));
    },

    async usage(userId: string): Promise<Usage> {
      const [row] = await db.query<{ bytes: string; projects: string }>(
        "SELECT storage_bytes AS bytes, (SELECT count(*) FROM projects WHERE user_id = $1) AS projects FROM users WHERE id = $1",
        [userId],
      );
      return { bytes: Number(row?.bytes ?? 0), projects: Number(row?.projects ?? 0), limits };
    },

    async search(userId: string, query: string, slug?: string): Promise<SearchResult[]> {
      if (typeof query !== "string" || query.length > limits.maxSearchQuery) {
        throw new AppError(422, "invalid_body", `Search queries are limited to ${limits.maxSearchQuery} characters.`);
      }
      if (slug !== undefined) await findProject(db, userId, slug);
      if (!query.trim()) return [];
      return db.query<SearchResult>(searchSql(slug !== undefined), slug !== undefined ? [userId, query, slug] : [userId, query]);
    },
  };
}

export type Service = ReturnType<typeof createService>;

/**
 * Ranks and limits first, then builds snippets for those 20 rows only: a subquery with LIMIT is never
 * flattened, so ts_headline cannot run over every match. Snippets come from a prefix of the page
 * (audit D4).
 */
export function searchSql(withProject: boolean): string {
  return `SELECT m.project, m.path, m.version,
                 ts_headline('english', left(p.search_text, ${SNIPPET_SOURCE_CHARS}), q,
                             'MaxFragments=2, MaxWords=25, MinWords=8, StartSel=**, StopSel=**') AS snippet
            FROM (SELECT p.id, pr.slug AS project, p.path, p.version, ts_rank(p.search, q) AS rank
                    FROM pages p
                    JOIN projects pr ON pr.id = p.project_id
                    CROSS JOIN websearch_to_tsquery('english', $2) AS q
                   WHERE pr.user_id = $1 AND p.deleted_at IS NULL AND p.search @@ q ${withProject ? "AND pr.slug = $3" : ""}
                   ORDER BY rank DESC, pr.slug, p.path
                   LIMIT 20) m
            JOIN pages p ON p.id = m.id
           CROSS JOIN websearch_to_tsquery('english', $2) AS q
           ORDER BY m.rank DESC, m.project, m.path`;
}
