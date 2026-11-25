import type { Db } from "../db/db.js";
import { newId, randomToken, sha256Hex } from "./crypto.js";

export const PAT_PREFIX = "anywr_";

export interface PatInfo {
  id: string;
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
}

/** `expiresInDays` null means no expiry, which docs/api.md allows; the web form offers expiries (audit A3). */
export async function createPat(
  db: Db,
  userId: string,
  name: string,
  expiresInDays: number | null = null,
): Promise<{ id: string; token: string }> {
  const id = newId();
  const token = PAT_PREFIX + randomToken(32);
  await db.query(
    `INSERT INTO personal_access_tokens (id, user_id, name, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $5::int IS NULL THEN NULL ELSE now() + make_interval(days => $5::int) END)`,
    [id, userId, name.trim().slice(0, 100) || "token", sha256Hex(token), expiresInDays],
  );
  return { id, token };
}

export async function listPats(db: Db, userId: string): Promise<PatInfo[]> {
  return db.query<PatInfo>(
    `SELECT id, name, created_at AS "createdAt", last_used_at AS "lastUsedAt", expires_at AS "expiresAt"
       FROM personal_access_tokens WHERE user_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
      ORDER BY created_at`,
    [userId],
  );
}

export async function revokePat(db: Db, userId: string, id: string): Promise<void> {
  await db.query("UPDATE personal_access_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2", [id, userId]);
}

export async function revokeAllPats(db: Db, userId: string): Promise<void> {
  await db.query("UPDATE personal_access_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
}
