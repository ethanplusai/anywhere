import { pgliteDb, type Db } from "../src/db/db.js";
import { migrate } from "../src/db/migrate.js";
import { createApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import { createUser, type User } from "../src/auth/users.js";
import { createPat } from "../src/auth/tokens.js";

export const BASE = "https://anywr.test";

export async function freshDb(): Promise<Db> {
  const db = await pgliteDb();
  await migrate(db);
  return db;
}

export interface TestApp {
  app: ReturnType<typeof createApp>;
  db: Db;
  config: Config;
  user: User;
  token: string;
  /** Calls the app in-process; relative paths are resolved against BASE. */
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Shorthand for an authenticated JSON request to the sync API. */
  api: (method: string, path: string, body?: unknown, token?: string) => Promise<Response>;
  close: () => Promise<void>;
}

export async function makeTestApp(
  env: Record<string, string> = {},
  opts: { fetch?: typeof fetch; db?: Db } = {},
): Promise<TestApp> {
  const db = opts.db ?? (await freshDb());
  const config = loadConfig({ BASE_URL: BASE, ...env });
  const app = createApp({ db, config, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  const existing = await db.query<User>("SELECT id, email FROM users WHERE email = 'me@example.com'");
  const user = existing[0] ?? (await createUser(db, "me@example.com", "long enough pw"));
  const { token } = await createPat(db, user.id, "test");
  const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(new URL(String(input), BASE), init);
    return app.fetch(req);
  };
  return {
    app,
    db,
    config,
    user,
    token,
    fetch: fetchFn,
    api: (method, path, body, tok = token) =>
      fetchFn(`/api/v1${path}`, {
        method,
        headers: {
          authorization: `Bearer ${tok}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
      }),
    close: () => db.close(),
  };
}

/** Signs in through the web form and returns the Cookie header value. */
export async function signIn(t: TestApp, email = "me@example.com", password = "long enough pw"): Promise<string> {
  const res = await t.fetch("/signin", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE },
    body: new URLSearchParams({ email, password }).toString(),
    redirect: "manual",
  });
  if (res.status !== 302) throw new Error(`sign-in failed: ${res.status}`);
  const cookie = res.headers.get("set-cookie") ?? "";
  return cookie.split(";")[0]!;
}

/** Pulls the CSRF token out of a rendered form. */
export function csrfFrom(htmlText: string): string {
  const m = /name="_csrf" value="([^"]+)"/.exec(htmlText);
  if (!m?.[1]) throw new Error("no CSRF field in page");
  return m[1];
}

/** Wraps a Db so tests can see every statement it runs. */
export function spyDb(db: Db): { db: Db; statements: string[] } {
  const statements: string[] = [];
  const wrap = (inner: Db): Db => ({
    query: (sql, params) => {
      statements.push(sql);
      return inner.query(sql, params);
    },
    transaction: (fn) => inner.transaction((tx) => fn(wrap(tx))),
    close: () => inner.close(),
  });
  return { db: wrap(db), statements };
}

/** A form POST with the given address as the right-most X-Forwarded-For entry (what a trusted proxy appends). */
export function formFrom(body: Record<string, string>, xff: string, cookie?: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: BASE,
      "x-forwarded-for": xff,
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams(body).toString(),
    redirect: "manual",
  };
}
