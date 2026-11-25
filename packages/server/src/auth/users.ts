import type { Db } from "../db/db.js";
import { AppError } from "../service/errors.js";
import { newId } from "./crypto.js";
import { hashPassword, needsRehash, verifyPassword } from "./passwords.js";

export interface User {
  id: string;
  email: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MIN_PASSWORD = 10;

// Unknown emails still run one scrypt so they cost the same time as a wrong password.
let dummyHash: Promise<string> | undefined;

function checkNewPassword(password: string): void {
  if (password.length < MIN_PASSWORD || password.length > 1024) {
    throw new AppError(422, "invalid_body", `Passwords need at least ${MIN_PASSWORD} characters.`);
  }
}

/**
 * Seam for email verification (audit A7, deferred): a deployment with an email provider would create
 * the user unverified here, send a link, and give the same response whether or not the address was new.
 */
export async function createUser(db: Db, email: string, password: string): Promise<User> {
  email = email.trim();
  if (!EMAIL_RE.test(email) || email.length > 254) throw new AppError(422, "invalid_body", "Enter a valid email address.");
  checkNewPassword(password);
  const hash = await hashPassword(password);
  const rows = await db.query<User>(
    "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id, email",
    [newId(), email, hash],
  );
  if (!rows[0]) throw new AppError(409, "email_taken", "An account with that email already exists.");
  return rows[0];
}

export async function verifyLogin(db: Db, email: string, password: string): Promise<User | null> {
  const rows = await db.query<User & { password_hash: string }>(
    "SELECT id, email, password_hash FROM users WHERE lower(email) = lower($1)",
    [email.trim()],
  );
  const row = rows[0];
  if (!row) {
    dummyHash ??= hashPassword("not-a-real-password");
    await verifyPassword(password, await dummyHash);
    return null;
  }
  if (!(await verifyPassword(password, row.password_hash))) return null;
  if (needsRehash(row.password_hash)) {
    await db.query("UPDATE users SET password_hash = $2 WHERE id = $1", [row.id, await hashPassword(password)]);
  }
  return { id: row.id, email: row.email };
}

/** Re-authentication before destructive actions. */
export async function checkPassword(db: Db, userId: string, password: string): Promise<boolean> {
  const rows = await db.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1", [userId]);
  return !!rows[0] && (await verifyPassword(password, rows[0].password_hash));
}

export async function setPassword(db: Db, userId: string, password: string): Promise<void> {
  checkNewPassword(password);
  await db.query("UPDATE users SET password_hash = $2 WHERE id = $1", [userId, await hashPassword(password)]);
}

/** Deletes the account; every project, page, revision, session, token and grant cascades with it. */
export async function deleteUser(db: Db, userId: string): Promise<void> {
  await db.query("DELETE FROM users WHERE id = $1", [userId]);
}
