import type { Db } from "../db/db.js";
import type { User } from "./users.js";
import { randomToken, safeEqual, sha256Hex } from "./crypto.js";

const SESSION_DAYS = 30;
export const SESSION_MAX_AGE = SESSION_DAYS * 24 * 3600;
/** last_seen_at is written at most this often, so reading a page is not a write each time. */
const TOUCH_MS = 60 * 60 * 1000;
/** Deleting the account, removing a passkey and the like need the person to have proved who they are this recently. */
export const REAUTH_MS = 10 * 60 * 1000;

export type SignInMethod = "email" | "github" | "passkey" | "local";

/** Where a session came from, for the security page. Both are coarse on purpose (see describeRequest). */
export interface SessionOrigin {
  method: SignInMethod;
  device: string;
  ip: string;
}

export interface SessionInfo {
  publicId: string;
  reauthAt: Date;
}

export interface SessionRow {
  publicId: string;
  method: SignInMethod;
  device: string;
  ip: string;
  createdAt: Date;
  lastSeenAt: Date;
}

/**
 * `__Host-` (audit A12) binds the cookie to this exact origin, with Secure, Path=/ and no Domain, so a
 * sibling subdomain cannot set or shadow it. Browsers only accept it over https.
 */
export function sessionCookieName(secure: boolean): string {
  return secure ? "__Host-anywr_session" : "anywr_session";
}

export async function createSession(db: Db, userId: string, origin: SessionOrigin = { method: "email", device: "", ip: "" }): Promise<string> {
  const sid = randomToken(32);
  await db.query(
    `INSERT INTO web_sessions (id_hash, user_id, expires_at, method, device, ip, public_id)
     VALUES ($1, $2, now() + make_interval(days => $3), $4, $5, $6, $7)`,
    [sha256Hex(sid), userId, SESSION_DAYS, origin.method, origin.device.slice(0, 120), origin.ip.slice(0, 64), randomToken(12)],
  );
  return sid;
}

/** A session is valid until 30 days after sign-in, and ends sooner after `idleDays` without use (audit A12). */
export async function getSessionUser(db: Db, sid: string | undefined, idleDays = 14): Promise<User | null> {
  return (await getSession(db, sid, idleDays))?.user ?? null;
}

export async function getSession(db: Db, sid: string | undefined, idleDays = 14): Promise<{ user: User; session: SessionInfo } | null> {
  if (!sid) return null;
  const rows = await db.query<User & { last_seen_at: Date; public_id: string; reauth_at: Date }>(
    `SELECT u.id, u.email, s.last_seen_at, s.public_id, s.reauth_at FROM web_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = $1 AND s.expires_at > now() AND s.last_seen_at > now() - make_interval(days => $2)`,
    [sha256Hex(sid), idleDays],
  );
  const row = rows[0];
  if (!row) return null;
  if (Date.now() - new Date(row.last_seen_at).getTime() > TOUCH_MS) {
    await db.query("UPDATE web_sessions SET last_seen_at = now() WHERE id_hash = $1", [sha256Hex(sid)]);
  }
  return { user: { id: row.id, email: row.email }, session: { publicId: row.public_id, reauthAt: new Date(row.reauth_at) } };
}

/** The person proved who they are again in this browser. */
export async function markReauth(db: Db, sid: string): Promise<void> {
  await db.query("UPDATE web_sessions SET reauth_at = now() WHERE id_hash = $1", [sha256Hex(sid)]);
}

export function isRecent(info: SessionInfo | null, now = Date.now()): boolean {
  return !!info && now - info.reauthAt.getTime() < REAUTH_MS;
}

export async function listSessions(db: Db, userId: string): Promise<SessionRow[]> {
  const rows = await db.query<{ public_id: string; method: SignInMethod; device: string; ip: string; created_at: Date; last_seen_at: Date }>(
    "SELECT public_id, method, device, ip, created_at, last_seen_at FROM web_sessions WHERE user_id = $1 AND expires_at > now() ORDER BY last_seen_at DESC",
    [userId],
  );
  return rows.map((r) => ({ publicId: r.public_id, method: r.method, device: r.device, ip: r.ip, createdAt: r.created_at, lastSeenAt: r.last_seen_at }));
}

/** Signs out one browser from the security page. */
export async function deleteSessionByPublicId(db: Db, userId: string, publicId: string): Promise<boolean> {
  const rows = await db.query("DELETE FROM web_sessions WHERE user_id = $1 AND public_id = $2 RETURNING 1", [userId, publicId]);
  return rows.length > 0;
}

export async function deleteSession(db: Db, sid: string): Promise<void> {
  await db.query("DELETE FROM web_sessions WHERE id_hash = $1", [sha256Hex(sid)]);
}

/** Signs a user out everywhere ("sign out everywhere", email change). */
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
