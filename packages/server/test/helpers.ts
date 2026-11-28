import { pgliteDb, type Db } from "../src/db/db.js";
import { migrate } from "../src/db/migrate.js";
import { createApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import { createUser, type User } from "../src/auth/users.js";
import { createPat } from "../src/auth/tokens.js";
import { MemoryMailer } from "../src/mail/mailer.js";

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
  /** Every email the app sent. */
  mailer: MemoryMailer;
  /** Calls the app in-process; relative paths are resolved against BASE. */
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Shorthand for an authenticated JSON request to the sync API. */
  api: (method: string, path: string, body?: unknown, token?: string) => Promise<Response>;
  close: () => Promise<void>;
}

export async function makeTestApp(
  env: Record<string, string> = {},
  opts: { fetch?: typeof fetch; db?: Db; mailer?: MemoryMailer } = {},
): Promise<TestApp> {
  const db = opts.db ?? (await freshDb());
  const config = loadConfig({ BASE_URL: BASE, ...env });
  const mailer = opts.mailer ?? new MemoryMailer();
  const app = createApp({ db, config, mailer, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  const existing = await db.query<User>("SELECT id, email FROM users WHERE email = 'me@example.com'");
  const user = existing[0] ?? (await createUser(db, "me@example.com", { verified: true }));
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
    mailer,
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

/** The six-digit code in the last email to this address. */
export function codeFor(t: TestApp, email: string): string {
  const mail = t.mailer.last(email);
  const m = mail && /\b(\d{6})\b/.exec(mail.text);
  if (!m?.[1]) throw new Error(`no code emailed to ${email}`);
  return m[1];
}

/** Cookie header values from a response, joined for the next request. */
export function cookiesFrom(res: Response, previous = ""): string {
  const jar = new Map(previous.split("; ").filter(Boolean).map((c) => [c.split("=")[0]!, c] as const));
  for (const line of res.headers.getSetCookie()) {
    const pair = line.split(";")[0]!;
    const name = pair.split("=")[0]!;
    if (/=$/.test(pair) || /max-age=0/i.test(line)) jar.delete(name);
    else jar.set(name, pair);
  }
  return [...jar.values()].join("; ");
}

/**
 * Signs in through the web form with an emailed code and returns the Cookie header value (the
 * session, and the browser id the code was tied to).
 */
export async function signIn(t: TestApp, email = "me@example.com"): Promise<string> {
  const form = (body: Record<string, string>, cookie = ""): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE, ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(body).toString(),
    redirect: "manual",
  });
  const sent = await t.fetch("/signin", form({ email }));
  if (sent.status !== 303) throw new Error(`sign-in failed: ${sent.status}`);
  let cookie = cookiesFrom(sent);
  const res = await t.fetch("/signin/code", form({ code: codeFor(t, email) }, cookie));
  if (res.status !== 302) throw new Error(`code was refused: ${res.status}`);
  cookie = cookiesFrom(res, cookie);
  return cookie;
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
