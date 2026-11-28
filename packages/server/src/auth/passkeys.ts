import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { Db } from "../db/db.js";
import { newId } from "./crypto.js";
import { browserHash } from "./email-codes.js";

/**
 * Passkeys (WebAuthn). A passkey signs a person in with no email round trip, and proves who they
 * are again before a destructive change. Each ceremony's challenge is stored server-side, tied to
 * the browser that started it, used once and kept for five minutes. User verification (a PIN,
 * fingerprint or face) is required, so a passkey on its own is two factors.
 */

export interface RelyingParty {
  id: string;
  name: string;
  origin: string;
}

export interface Passkey {
  id: string;
  name: string;
  backedUp: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
}

type Purpose = "register" | "signin" | "reauth";
const CHALLENGE_MINUTES = 5;

async function saveChallenge(db: Db, browser: string, purpose: Purpose, userId: string | null, challenge: string, next = "/projects"): Promise<void> {
  const bh = browserHash(browser);
  await db.query("DELETE FROM webauthn_challenges WHERE browser_hash = $1 AND purpose = $2", [bh, purpose]);
  await db.query(
    `INSERT INTO webauthn_challenges (id, browser_hash, purpose, user_id, challenge, next, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(mins => $7))`,
    [newId(), bh, purpose, userId, challenge, next, CHALLENGE_MINUTES],
  );
}

async function takeChallenge(db: Db, browser: string, purpose: Purpose): Promise<{ challenge: string; userId: string | null; next: string } | null> {
  const rows = await db.query<{ challenge: string; user_id: string | null; next: string }>(
    "DELETE FROM webauthn_challenges WHERE browser_hash = $1 AND purpose = $2 AND expires_at > now() RETURNING challenge, user_id, next",
    [browserHash(browser), purpose],
  );
  const r = rows[0];
  return r ? { challenge: r.challenge, userId: r.user_id, next: r.next } : null;
}

export async function listPasskeys(db: Db, userId: string): Promise<Passkey[]> {
  const rows = await db.query<{ id: string; name: string; backed_up: boolean; created_at: Date; last_used_at: Date | null }>(
    "SELECT id, name, backed_up, created_at, last_used_at FROM passkeys WHERE user_id = $1 ORDER BY created_at",
    [userId],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, backedUp: r.backed_up, createdAt: r.created_at, lastUsedAt: r.last_used_at }));
}

export async function deletePasskey(db: Db, userId: string, id: string): Promise<string | null> {
  const rows = await db.query<{ name: string }>("DELETE FROM passkeys WHERE user_id = $1 AND id = $2 RETURNING name", [userId, id]);
  return rows[0]?.name ?? null;
}

export async function registrationOptions(db: Db, rp: RelyingParty, user: { id: string; email: string }, browser: string) {
  const existing = await db.query<{ id: string; transports: string[] }>("SELECT id, transports FROM passkeys WHERE user_id = $1", [user.id]);
  const options = await generateRegistrationOptions({
    rpName: rp.name,
    rpID: rp.id,
    userName: user.email,
    userID: new TextEncoder().encode(user.id),
    attestationType: "none",
    excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  await saveChallenge(db, browser, "register", user.id, options.challenge);
  return options;
}

/** Name a passkey after where it was made: "iCloud Keychain" is more use on the security page than an id. */
function defaultName(device: string, backedUp: boolean): string {
  return device ? `${device}${backedUp ? " (synced)" : ""}` : "Passkey";
}

export async function finishRegistration(
  db: Db,
  rp: RelyingParty,
  userId: string,
  browser: string,
  response: unknown,
  device: string,
): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  const ch = await takeChallenge(db, browser, "register");
  if (!ch || ch.userId !== userId) return { ok: false, error: "This took too long. Try adding the passkey again." };
  let verified;
  try {
    verified = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON,
      expectedChallenge: ch.challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      requireUserVerification: true,
    });
  } catch {
    return { ok: false, error: "The passkey could not be checked. Try again." };
  }
  if (!verified.verified || !verified.registrationInfo) return { ok: false, error: "The passkey could not be checked. Try again." };
  const { credential, credentialBackedUp } = verified.registrationInfo;
  const name = defaultName(device, credentialBackedUp);
  const rows = await db.query(
    `INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, backed_up)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7) ON CONFLICT (id) DO NOTHING RETURNING 1`,
    [credential.id, userId, Buffer.from(credential.publicKey), credential.counter, JSON.stringify(credential.transports ?? []), name, credentialBackedUp],
  );
  if (!rows.length) return { ok: false, error: "That passkey is already added." };
  return { ok: true, name };
}

/** Options to sign in (any passkey for this site) or to confirm it is you (this account's passkeys only). */
export async function authenticationOptions(db: Db, rp: RelyingParty, browser: string, opts: { userId?: string; next?: string } = {}) {
  const allow = opts.userId
    ? (await db.query<{ id: string; transports: string[] }>("SELECT id, transports FROM passkeys WHERE user_id = $1", [opts.userId])).map((p) => ({ id: p.id, transports: p.transports }))
    : undefined;
  const options = await generateAuthenticationOptions({ rpID: rp.id, userVerification: "required", ...(allow ? { allowCredentials: allow } : {}) });
  await saveChallenge(db, browser, opts.userId ? "reauth" : "signin", opts.userId ?? null, options.challenge, opts.next);
  return options;
}

/** Checks a passkey assertion. Returns the account it belongs to, and where to go next. */
export async function finishAuthentication(
  db: Db,
  rp: RelyingParty,
  browser: string,
  purpose: "signin" | "reauth",
  response: unknown,
): Promise<{ ok: true; userId: string; next: string; name: string } | { ok: false; error: string }> {
  const ch = await takeChallenge(db, browser, purpose);
  if (!ch) return { ok: false, error: "This took too long. Try again." };
  const id = (response as { id?: unknown } | null)?.id;
  if (typeof id !== "string") return { ok: false, error: "That passkey could not be read." };
  const rows = await db.query<{ user_id: string; public_key: Buffer; counter: string; transports: string[]; name: string }>(
    "SELECT user_id, public_key, counter::text AS counter, transports, name FROM passkeys WHERE id = $1",
    [id],
  );
  const pk = rows[0];
  if (!pk || (ch.userId && pk.user_id !== ch.userId)) return { ok: false, error: "That passkey is not on this account. It may have been removed." };
  let verified;
  try {
    verified = await verifyAuthenticationResponse({
      response: response as AuthenticationResponseJSON,
      expectedChallenge: ch.challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      requireUserVerification: true,
      credential: { id, publicKey: new Uint8Array(pk.public_key), counter: Number(pk.counter), transports: pk.transports },
    });
  } catch {
    return { ok: false, error: "That passkey could not be checked. Try again." };
  }
  if (!verified.verified) return { ok: false, error: "That passkey could not be checked. Try again." };
  await db.query("UPDATE passkeys SET counter = $2, last_used_at = now() WHERE id = $1", [id, verified.authenticationInfo.newCounter]);
  return { ok: true, userId: pk.user_id, next: ch.next, name: pk.name };
}
