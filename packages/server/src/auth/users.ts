import type { Db } from "../db/db.js";
import { AppError } from "../service/errors.js";
import { newId } from "./crypto.js";

export interface User {
  id: string;
  email: string;
}

export interface UserDetails extends User {
  emailVerifiedAt: Date | null;
  githubId: string | null;
  githubLogin: string | null;
  createdAt: Date;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The one spelling an email is compared under. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function checkEmail(email: string): string {
  const e = email.trim();
  if (!EMAIL_RE.test(e) || e.length > 254 || [...e].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) throw new AppError(422, "invalid_body", "Enter a valid email address.");
  return e;
}

/**
 * Accounts have no password: people sign in with a code sent to their email, with GitHub or with a
 * passkey. `verified` is true when the caller has just proved the address (an email code, or GitHub's
 * verified primary email).
 */
export async function createUser(db: Db, email: string, opts: { verified?: boolean; githubId?: string; githubLogin?: string } = {}): Promise<User> {
  email = checkEmail(email);
  const rows = await db.query<User>(
    `INSERT INTO users (id, email, email_verified_at, github_id, github_login)
     VALUES ($1, $2, CASE WHEN $3 THEN now() END, $4, $5) ON CONFLICT DO NOTHING RETURNING id, email`,
    [newId(), email, opts.verified ?? false, opts.githubId ?? null, opts.githubLogin ?? null],
  );
  if (!rows[0]) throw new AppError(409, "email_taken", "An account with that email already exists.");
  return rows[0];
}

export async function findUserByEmail(db: Db, email: string): Promise<User | null> {
  const rows = await db.query<User>("SELECT id, email FROM users WHERE lower(email) = lower($1)", [email.trim()]);
  return rows[0] ?? null;
}

export async function findUserByGithub(db: Db, githubId: string): Promise<User | null> {
  const rows = await db.query<User>("SELECT id, email FROM users WHERE github_id = $1", [githubId]);
  return rows[0] ?? null;
}

export async function getUserDetails(db: Db, userId: string): Promise<UserDetails | null> {
  const rows = await db.query<{ id: string; email: string; email_verified_at: Date | null; github_id: string | null; github_login: string | null; created_at: Date }>(
    "SELECT id, email, email_verified_at, github_id::text AS github_id, github_login, created_at FROM users WHERE id = $1",
    [userId],
  );
  const r = rows[0];
  return r ? { id: r.id, email: r.email, emailVerifiedAt: r.email_verified_at, githubId: r.github_id, githubLogin: r.github_login, createdAt: r.created_at } : null;
}

/** Records that the person receives mail at their address. */
export async function markEmailVerified(db: Db, userId: string): Promise<void> {
  await db.query("UPDATE users SET email_verified_at = now() WHERE id = $1 AND email_verified_at IS NULL", [userId]);
}

/** Changes the address, already proved by a code sent to it. */
export async function changeEmail(db: Db, userId: string, email: string): Promise<void> {
  email = checkEmail(email);
  const rows = await db.query("UPDATE users SET email = $2, email_verified_at = now() WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM users WHERE lower(email) = lower($2) AND id <> $1) RETURNING 1", [userId, email]);
  if (!rows.length) throw new AppError(409, "email_taken", "Another account already uses that email.");
}

export async function linkGithub(db: Db, userId: string, githubId: string, login: string): Promise<void> {
  const rows = await db.query("UPDATE users SET github_id = $2, github_login = $3 WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM users WHERE github_id = $2 AND id <> $1) RETURNING 1", [userId, githubId, login]);
  if (!rows.length) throw new AppError(409, "email_taken", "That GitHub account is already linked to another Anywhere account.");
}

export async function unlinkGithub(db: Db, userId: string): Promise<void> {
  await db.query("UPDATE users SET github_id = NULL, github_login = NULL WHERE id = $1", [userId]);
}

/** Deletes the account; every project, page, revision, session, token, passkey and grant cascades with it. */
export async function deleteUser(db: Db, userId: string): Promise<void> {
  await db.query("DELETE FROM users WHERE id = $1", [userId]);
}
