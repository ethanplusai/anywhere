import { CliError } from "./errors.js";

export type Project = { slug: string; name: string; description: string; updatedAt: string };
export type PageMeta = { path: string; version: number; sha256: string; size: number; updatedAt: string };
export type Page = PageMeta & { content: string };

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    /** Present on a 409: the server's page, or null if it was deleted there. */
    public readonly current?: Page | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type ApiOptions = { sleep?: (ms: number) => Promise<void> };

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Api {
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(
    public readonly server: string,
    private readonly token: string,
    opts: ApiOptions = {},
  ) {
    this.sleep = opts.sleep ?? defaultSleep;
  }

  private async once(method: string, path: string, body: unknown): Promise<Response> {
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    try {
      return await fetch(`${this.server}/api/v1${path}`, init);
    } catch (e) {
      const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : (e as Error).message;
      throw new CliError(`Cannot reach ${this.server}: ${cause}`);
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res = await this.once(method, path, body);
    if (res.status === 429) {
      const wait = Math.min(Math.max(Number(res.headers.get("retry-after")) || 1, 0), 30);
      await res.arrayBuffer();
      await this.sleep(wait * 1000);
      res = await this.once(method, path, body);
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (res.ok) return json as T;
    const j = (json ?? {}) as { error?: { code?: string; message?: string }; current?: Page | null };
    const code = j.error?.code ?? (res.status === 429 ? "rate_limited" : "http_error");
    const message = j.error?.message ?? `The server answered ${res.status}.`;
    throw new ApiError(res.status, code, message, "current" in j ? (j.current ?? null) : undefined);
  }

  me = () => this.request<{ user: { id: string; email: string } }>("GET", "/me");
  projects = () => this.request<{ projects: Project[] }>("GET", "/projects");
  createProject = (b: { name: string; slug?: string; description?: string }) =>
    this.request<{ project: Project; pages: PageMeta[] }>("POST", "/projects", b);
  getProject = (slug: string) => this.request<{ project: Project; pages: PageMeta[] }>("GET", `/projects/${slug}`);
  getPage = (slug: string, path: string) =>
    this.request<{ page: Page }>("GET", `/projects/${slug}/pages/${path}`).then((r) => r.page);
  putPage = (slug: string, path: string, content: string, baseVersion: number) =>
    this.request<{ page: PageMeta }>("PUT", `/projects/${slug}/pages/${path}`, { content, baseVersion }).then(
      (r) => r.page,
    );
  deletePage = (slug: string, path: string, baseVersion: number) =>
    this.request<{ deleted: true }>("DELETE", `/projects/${slug}/pages/${path}?baseVersion=${baseVersion}`);
}
