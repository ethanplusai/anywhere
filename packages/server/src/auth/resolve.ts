import type { Db } from "../db/db.js";
import { sha256Hex } from "./crypto.js";
import { PAT_PREFIX } from "./tokens.js";

export interface Principal {
  userId: string;
  via: "pat" | "oauth";
  /** Recorded on the revisions this principal writes: "token:<name>" or "app:<client name>". */
  actor: string;
}

export interface ResolveOptions {
  /**
   * OAuth access tokens are accepted only when issued for one of these resources (audit A10). Tokens
   * with no recorded resource are accepted. Omit to accept any resource.
   */
  resources?: string[];
  /** Accept personal access tokens only, never OAuth access tokens (the sync API, audit A10). */
  patOnly?: boolean;
}

const TOUCH_INTERVAL_MS = 60_000;

/**
 * Accepts a personal access token or an OAuth access token from an Authorization header. Lookups are
 * a SELECT; a token's last_used_at is written at most once a minute, so guessed tokens cost no
 * writes (audit A14).
 */
export async function resolveBearer(db: Db, header: string | undefined, opts: ResolveOptions = {}): Promise<Principal | null> {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  const token = m?.[1];
  if (!token || token.length > 512) return null;
  const hash = sha256Hex(token);
  if (opts.patOnly && !token.startsWith(PAT_PREFIX)) return null;
  if (token.startsWith(PAT_PREFIX)) {
    const rows = await db.query<{ id: string; user_id: string; name: string; last_used_at: Date | null }>(
      `SELECT id, user_id, name, last_used_at FROM personal_access_tokens
        WHERE token_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
      [hash],
    );
    const row = rows[0];
    if (!row) return null;
    if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > TOUCH_INTERVAL_MS) {
      await db.query("UPDATE personal_access_tokens SET last_used_at = now() WHERE id = $1", [row.id]);
    }
    return { userId: row.user_id, via: "pat", actor: `token:${row.name}`.slice(0, 120) };
  }
  const rows = await db.query<{ user_id: string; resource: string | null; client_name: string | null }>(
    `SELECT t.user_id, t.resource, c.client_name FROM oauth_access_tokens t
       LEFT JOIN oauth_clients c ON c.client_id = t.client_id
      WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND t.expires_at > now()`,
    [hash],
  );
  const row = rows[0];
  if (!row) return null;
  if (opts.resources && row.resource !== null && !opts.resources.includes(row.resource)) return null;
  return { userId: row.user_id, via: "oauth", actor: `app:${row.client_name ?? "Unnamed app"}`.slice(0, 120) };
}
