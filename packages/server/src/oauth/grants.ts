import { createHash } from "node:crypto";
import type { Db } from "../db/db.js";
import { newId, randomToken, safeEqual, sha256Hex } from "../auth/crypto.js";
import { OAuthError } from "./clients.js";

export const ACCESS_TTL_S = 3600;
const REFRESH_TTL_DAYS = 30;
const CODE_TTL_S = 600;
// Distinct from the personal access token prefix ("anywr_") so resolveBearer can tell them apart.
const ACCESS_PREFIX = "awa_";
const REFRESH_PREFIX = "awr_";

export interface CodeRequest {
  clientId: string;
  userId: string;
  redirectUri: string;
  /** Whether redirect_uri was in the authorization request; the token request must repeat it only then. */
  redirectUriSupplied: boolean;
  codeChallenge: string;
  resource: string | null;
  scope: string | null;
}

export async function createCode(db: Db, req: CodeRequest): Promise<string> {
  const code = randomToken(32);
  await db.query(
    `INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, redirect_uri_supplied, code_challenge, family_id, resource, scope, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + make_interval(secs => $10))`,
    [sha256Hex(code), req.clientId, req.userId, req.redirectUri, req.redirectUriSupplied, req.codeChallenge, newId(), req.resource, req.scope, CODE_TTL_S],
  );
  return code;
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope?: string;
}

export interface GrantOptions {
  /** Absolute lifetime of a grant in days (audit A3). */
  grantLifetimeDays: number;
}

/** Tokens never outlive their grant: both expiries are capped at the grant's. */
async function issue(
  db: Db,
  g: { clientId: string; userId: string; familyId: string; resource: string | null; scope: string | null },
): Promise<TokenResponse> {
  const access = ACCESS_PREFIX + randomToken(32);
  const refresh = REFRESH_PREFIX + randomToken(32);
  const [row] = await db.query<{ expires_in: number }>(
    `INSERT INTO oauth_access_tokens (token_hash, client_id, user_id, family_id, resource, scope, expires_at)
     SELECT $1, $2, $3, $4, $5, $6, LEAST(now() + make_interval(secs => $7), g.expires_at)
       FROM oauth_grants g WHERE g.family_id = $4
     RETURNING GREATEST(1, floor(extract(epoch FROM expires_at - now())))::int AS expires_in`,
    [sha256Hex(access), g.clientId, g.userId, g.familyId, g.resource, g.scope, ACCESS_TTL_S],
  );
  await db.query(
    `INSERT INTO oauth_refresh_tokens (token_hash, client_id, user_id, family_id, resource, scope, expires_at)
     SELECT $1, $2, $3, $4, $5, $6, LEAST(now() + make_interval(days => $7), g.expires_at)
       FROM oauth_grants g WHERE g.family_id = $4`,
    [sha256Hex(refresh), g.clientId, g.userId, g.familyId, g.resource, g.scope, REFRESH_TTL_DAYS],
  );
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: row?.expires_in ?? ACCESS_TTL_S,
    refresh_token: refresh,
    ...(g.scope ? { scope: g.scope } : {}),
  };
}

async function revokeFamily(db: Db, familyId: string): Promise<void> {
  await db.query("UPDATE oauth_grants SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL", [familyId]);
  await db.query("UPDATE oauth_access_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL", [familyId]);
  await db.query("UPDATE oauth_refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL", [familyId]);
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

interface CodeRow {
  client_id: string;
  user_id: string;
  redirect_uri: string;
  redirect_uri_supplied: boolean;
  code_challenge: string;
  family_id: string;
  resource: string | null;
  scope: string | null;
  expires_at: Date;
  used_at: Date | null;
}

export async function exchangeCode(
  db: Db,
  p: { code: string; clientId: string; redirectUri: string | null; verifier: string | null; resource: string | null },
  opts: GrantOptions,
): Promise<TokenResponse> {
  // Failures are returned, not thrown, so marking the code used (and any revocation) commits.
  const outcome = await db.transaction(async (tx): Promise<{ tokens: TokenResponse } | { error: OAuthError }> => {
    const fail = (error: string, description: string) => ({ error: new OAuthError(error, description) });
    const rows = await tx.query<CodeRow>("SELECT * FROM oauth_codes WHERE code_hash = $1 FOR UPDATE", [sha256Hex(p.code)]);
    const row = rows[0];
    if (!row) return fail("invalid_grant", "Unknown authorization code.");
    if (row.used_at) {
      // A replayed code means it leaked: revoke everything it produced (OAuth 2.1 section 4.1.3).
      await revokeFamily(tx, row.family_id);
      return fail("invalid_grant", "This authorization code has already been used.");
    }
    await tx.query("UPDATE oauth_codes SET used_at = now() WHERE code_hash = $1", [sha256Hex(p.code)]);
    if (new Date(row.expires_at).getTime() < Date.now()) return fail("invalid_grant", "The authorization code has expired.");
    if (row.client_id !== p.clientId) return fail("invalid_grant", "The code was issued to another client.");
    const redirectOk = row.redirect_uri_supplied ? p.redirectUri === row.redirect_uri : p.redirectUri === null || p.redirectUri === row.redirect_uri;
    if (!redirectOk) return fail("invalid_grant", "redirect_uri does not match the authorization request.");
    if (!p.verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(p.verifier) || !safeEqual(s256(p.verifier), row.code_challenge)) {
      return fail("invalid_grant", "PKCE verification failed.");
    }
    if (p.resource && row.resource && p.resource !== row.resource) {
      return fail("invalid_target", "resource does not match the authorization request.");
    }
    await tx.query(
      `INSERT INTO oauth_grants (family_id, user_id, client_id, expires_at, last_used_at)
       VALUES ($1, $2, $3, now() + make_interval(days => $4), now())`,
      [row.family_id, row.user_id, row.client_id, opts.grantLifetimeDays],
    );
    const tokens = await issue(tx, { clientId: row.client_id, userId: row.user_id, familyId: row.family_id, resource: row.resource, scope: row.scope });
    return { tokens };
  });
  if ("error" in outcome) throw outcome.error;
  return outcome.tokens;
}

interface RefreshRow {
  client_id: string;
  user_id: string;
  family_id: string;
  resource: string | null;
  scope: string | null;
  expires_at: Date;
  used_at: Date | null;
  revoked_at: Date | null;
}

/** Refresh-token rotation: each refresh token works once; presenting a spent one revokes the family. */
export async function refresh(db: Db, p: { refreshToken: string; clientId: string }): Promise<TokenResponse> {
  const outcome = await db.transaction(async (tx) => {
    const hash = sha256Hex(p.refreshToken);
    const rows = await tx.query<RefreshRow>("SELECT * FROM oauth_refresh_tokens WHERE token_hash = $1 FOR UPDATE", [hash]);
    const row = rows[0];
    if (!row || row.client_id !== p.clientId) return { error: "Unknown refresh token." } as const;
    if (row.revoked_at) return { error: "This refresh token has been revoked." } as const;
    if (row.used_at) {
      await revokeFamily(tx, row.family_id);
      return { error: "This refresh token was already used; the session has been revoked for safety." } as const;
    }
    if (new Date(row.expires_at).getTime() < Date.now()) return { error: "The refresh token has expired." } as const;
    const grants = await tx.query<{ ok: boolean }>(
      `UPDATE oauth_grants SET last_used_at = now() WHERE family_id = $1 AND revoked_at IS NULL AND expires_at > now()
       RETURNING true AS ok`,
      [row.family_id],
    );
    if (!grants[0]) return { error: "This connection has ended. Connect the app to Anywhere again." } as const;
    await tx.query("UPDATE oauth_refresh_tokens SET used_at = now() WHERE token_hash = $1", [hash]);
    return { tokens: await issue(tx, { clientId: row.client_id, userId: row.user_id, familyId: row.family_id, resource: row.resource, scope: row.scope }) };
  });
  // Errors are returned rather than thrown so the family revocation above commits.
  if ("error" in outcome) throw new OAuthError("invalid_grant", outcome.error);
  return outcome.tokens;
}

export interface GrantInfo {
  familyId: string;
  clientId: string;
  clientName: string | null;
  redirectUris: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date;
}

/** The apps a user has connected and not revoked, newest first. */
export async function listGrants(db: Db, userId: string): Promise<GrantInfo[]> {
  return db.query<GrantInfo>(
    `SELECT g.family_id AS "familyId", g.client_id AS "clientId", c.client_name AS "clientName",
            COALESCE(c.redirect_uris, '[]'::jsonb) AS "redirectUris", g.created_at AS "createdAt",
            g.last_used_at AS "lastUsedAt", g.expires_at AS "expiresAt"
       FROM oauth_grants g LEFT JOIN oauth_clients c ON c.client_id = g.client_id
      WHERE g.user_id = $1 AND g.revoked_at IS NULL AND g.expires_at > now()
      ORDER BY g.created_at DESC`,
    [userId],
  );
}

/** Ends one connected app: its grant, refresh tokens and access tokens. */
export async function revokeGrant(db: Db, userId: string, familyId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx.query("SELECT 1 FROM oauth_grants WHERE family_id = $1 AND user_id = $2", [familyId, userId]);
    if (!rows[0]) return false;
    await revokeFamily(tx, familyId);
    return true;
  });
}

/** Ends every connected app of a user. */
export async function revokeAllGrants(db: Db, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query("UPDATE oauth_grants SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
    await tx.query("UPDATE oauth_access_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
    await tx.query("UPDATE oauth_refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
  });
}

/**
 * RFC 7009 revocation: a token presented by the client it was issued to ends its whole grant. Unknown
 * tokens and tokens of other clients are ignored, as the RFC asks (the response is the same).
 */
export async function revokeToken(db: Db, token: string, clientId: string): Promise<void> {
  const hash = sha256Hex(token);
  const rows = await db.query<{ family_id: string }>(
    `SELECT family_id FROM oauth_access_tokens WHERE token_hash = $1 AND client_id = $2
     UNION ALL SELECT family_id FROM oauth_refresh_tokens WHERE token_hash = $1 AND client_id = $2`,
    [hash, clientId],
  );
  if (rows[0]) await db.transaction((tx) => revokeFamily(tx, rows[0]!.family_id));
}
