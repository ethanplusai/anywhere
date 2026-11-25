import type { Db } from "../db/db.js";
import type { User } from "./users.js";
import { randomToken, safeEqual, sha256Hex } from "./crypto.js";

const SESSION_DAYS = 30;
export const SESSION_MAX_AGE = SESSION_DAYS * 24 * 3600;
/** last_seen_at is written at most this often, so reading a page is not a write each time. */
const TOUCH_MS = 60 * 60 * 1000;

/**
 * `__Host-` (audit A12) binds the cookie to this exact origin, with Secure, Path=/ and no Domain, so a
 * sibling subdomain cannot set or shadow it. Browsers only accept it over https.
 */
export function sessionCookieName(secure: boolean): string {
  return secure ? "__Host-anywr_session" : "anywr_session";
}

export async function createSession(db: Db, userId: string): Promise<string> {
  const sid = randomToken(32);
  await db.query(
    "INSERT INTO web_sessions (id_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))",
    [sha256Hex(sid), userId, SESSION_DAYS],
  );
  return sid;
}

/** A session is valid until 30 days after sign-in, and ends sooner after `idleDays` without use (audit A12). */
export async function getSessionUser(db: Db, sid: string | undefined, idleDays = 14): Promise<User | null> {
  if (!sid) return null;
  const rows = await db.query<User & { last_seen_at: Date }>(
    `SELECT u.id, u.email, s.last_seen_at FROM web_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = $1 AND s.expires_at > now() AND s.last_seen_at > now() - make_interval(days => $2)`,
    [sha256Hex(sid), idleDays],
  );
  const row = rows[0];
  if (!row) return null;
  if (Date.now() - new Date(row.last_seen_at).getTime() > TOUCH_MS) {
    await db.query("UPDATE web_sessions SET last_seen_at = now() WHERE id_hash = $1", [sha256Hex(sid)]);
  }
  return { id: row.id, email: row.email };
}

export async function deleteSession(db: Db, sid: string): Promise<void> {
  await db.query("DELETE FROM web_sessions WHERE id_hash = $1", [sha256Hex(sid)]);
}

/** Signs a user out everywhere (password change, "sign out everywhere"). */
export async function deleteUserSessions(db: Db, userId: string): Promise<void> {
  await db.query("DELETE FROM web_sessions WHERE user_id = $1", [userId]);
}

/** The session id lives only in an HttpOnly cookie, so a hash of it is a CSRF token no other site can know. */
export function csrfToken(sid: string): string {
  return sha256Hex(`csrf:${sid}`);
}

export function checkCsrf(sid: string, token: string | undefined): boolean {
  return typeof token === "string" && safeEqual(csrfToken(sid), token);
}
