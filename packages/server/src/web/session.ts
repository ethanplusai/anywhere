import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Config } from "../config.js";
import type { Db } from "../db/db.js";
import { SESSION_MAX_AGE, checkCsrf, csrfToken, getSession, sessionCookieName, type SessionInfo } from "../auth/sessions.js";
import { randomToken } from "../auth/crypto.js";
import type { User } from "../auth/users.js";

export type WebEnv = { Variables: { user: User | null; sid: string | null; csrf: string; session: SessionInfo | null } };

function secure(config: Config): boolean {
  return config.baseUrl.startsWith("https://");
}

export function sessionMiddleware(db: Db, config: Config): MiddlewareHandler<WebEnv> {
  return async (c, next) => {
    const sid = getCookie(c, sessionCookieName(secure(config))) ?? null;
    const found = await getSession(db, sid ?? undefined, config.sessionIdleDays);
    const user = found?.user ?? null;
    c.set("user", user);
    c.set("session", found?.session ?? null);
    c.set("sid", user ? sid : null);
    c.set("csrf", user && sid ? csrfToken(sid) : "");
    await next();
  };
}

export function setSessionCookie(c: Context, config: Config, sid: string): void {
  setCookie(c, sessionCookieName(secure(config)), sid, {
    httpOnly: true,
    sameSite: "Lax",
    secure: secure(config),
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
}

export function clearSessionCookie(c: Context, config: Config): void {
  deleteCookie(c, sessionCookieName(secure(config)), { path: "/", secure: secure(config) });
}

/**
 * A random id for this browser, in an HttpOnly cookie. Email codes and passkey challenges are tied to
 * it, so a code or a challenge only works in the browser that asked for it. It identifies nothing
 * else and is never shown.
 */
export function browserId(c: Context, config: Config): string {
  const name = secure(config) ? "__Host-anywr_browser" : "anywr_browser";
  const existing = getCookie(c, name);
  if (existing && /^[A-Za-z0-9_-]{32,64}$/.test(existing)) return existing;
  const id = randomToken(32);
  setCookie(c, name, id, { httpOnly: true, sameSite: "Lax", secure: secure(config), path: "/", maxAge: 400 * 24 * 3600 });
  return id;
}

/** For forms posted by a signed-in user. */
export function csrfOk(c: Context<WebEnv>, token: unknown): boolean {
  const sid = c.get("sid");
  return !!sid && checkCsrf(sid, typeof token === "string" ? token : undefined);
}

/**
 * For forms posted before there is a session (sign-in, sign-up). The Origin must be ours; a request
 * without one must carry `Sec-Fetch-Site: same-origin`. A request with neither is refused, so another
 * site cannot sign a visitor in to an account it controls (login CSRF, audit A11).
 */
export function originOk(c: Context, config: Config): boolean {
  const origin = c.req.header("origin");
  if (origin) return origin === new URL(config.baseUrl).origin;
  return c.req.header("sec-fetch-site") === "same-origin";
}

/** Only same-site relative paths may be used as a post-sign-in destination. */
export function safeNext(next: unknown): string {
  const fallback = "/projects";
  // Browsers strip tabs and newlines and treat "\" as "/", so "/\t/evil.example" would leave the site.
  if (typeof next !== "string" || !next.startsWith("/") || hasControlOrBackslash(next)) return fallback;
  const origin = "https://same-origin.invalid";
  let url: URL;
  try {
    url = new URL(next, origin);
  } catch {
    return fallback;
  }
  return url.origin === origin ? url.pathname + url.search : fallback;
}

function hasControlOrBackslash(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || code === 0x5c) return true;
  }
  return false;
}
