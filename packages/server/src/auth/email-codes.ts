import { randomInt } from "node:crypto";
import type { Db } from "../db/db.js";
import { newId, randomToken, safeEqual, sha256Hex } from "./crypto.js";

/**
 * Email challenges: a six-digit code and a one-time link, sent together.
 *
 * - The code only works in the browser that asked for it (`browser` is a random id held in an
 *   HttpOnly cookie, stored hashed), so a code read out by someone fooled into it is useless to the
 *   person who fooled them. Five wrong guesses end the challenge.
 * - The link works on any device, once. It opens a page with a button rather than signing in on
 *   the GET, so mail scanners that open links cannot use it up or sign anyone in.
 * - Both last ten minutes and are stored hashed. A new challenge in the same browser replaces the
 *   old one.
 */

export type ChallengePurpose = "signin" | "reauth" | "change_email";

export const CODE_MINUTES = 10;
export const MAX_CODE_ATTEMPTS = 5;

export interface Challenge {
  id: string;
  purpose: ChallengePurpose;
  email: string;
  userId: string | null;
  next: string;
}

interface Row {
  id: string;
  purpose: ChallengePurpose;
  email: string;
  user_id: string | null;
  code_hash: string;
  attempts: number;
  next: string;
}

const codeHash = (id: string, code: string) => sha256Hex(`email-code:${id}:${code}`);
const linkHash = (token: string) => sha256Hex(`email-link:${token}`);
export const browserHash = (browser: string) => sha256Hex(`browser:${browser}`);

const toChallenge = (r: Row): Challenge => ({ id: r.id, purpose: r.purpose, email: r.email, userId: r.user_id, next: r.next });

export async function startChallenge(
  db: Db,
  p: { purpose: ChallengePurpose; email: string; userId: string | null; browser: string; next: string },
): Promise<{ code: string; link: string }> {
  const id = newId();
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const link = randomToken(32);
  const bh = browserHash(p.browser);
  await db.transaction(async (tx) => {
    // One live challenge per browser and purpose: asking again replaces the code.
    await tx.query("UPDATE email_challenges SET used_at = now() WHERE browser_hash = $1 AND purpose = $2 AND used_at IS NULL", [bh, p.purpose]);
    await tx.query(
      `INSERT INTO email_challenges (id, purpose, email, user_id, browser_hash, code_hash, link_hash, next, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(mins => $9))`,
      [id, p.purpose, p.email.trim().toLowerCase(), p.userId, bh, codeHash(id, code), linkHash(link), p.next, CODE_MINUTES],
    );
  });
  return { code, link };
}

/** The challenge this browser is waiting on, if any: for showing the address on the code page. */
export async function pendingChallenge(db: Db, browser: string, purpose: ChallengePurpose): Promise<Challenge | null> {
  const rows = await db.query<Row>(
    `SELECT id, purpose, email, user_id, code_hash, attempts, next FROM email_challenges
      WHERE browser_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1`,
    [browserHash(browser), purpose],
  );
  return rows[0] ? toChallenge(rows[0]) : null;
}

export type CodeResult = { ok: true; challenge: Challenge } | { ok: false; reason: "none" | "wrong" | "spent"; left: number };

/** Checks a code typed in this browser. A right code is used up; a wrong one counts as an attempt. */
export async function checkCode(db: Db, browser: string, purpose: ChallengePurpose, code: string): Promise<CodeResult> {
  const typed = code.replace(/\D/g, "");
  return db.transaction(async (tx) => {
    const rows = await tx.query<Row>(
      `SELECT id, purpose, email, user_id, code_hash, attempts, next FROM email_challenges
        WHERE browser_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [browserHash(browser), purpose],
    );
    const row = rows[0];
    if (!row) return { ok: false, reason: "none", left: 0 };
    if (row.attempts >= MAX_CODE_ATTEMPTS) return { ok: false, reason: "spent", left: 0 };
    if (typed.length === 6 && safeEqual(codeHash(row.id, typed), row.code_hash)) {
      await tx.query("UPDATE email_challenges SET used_at = now() WHERE id = $1", [row.id]);
      return { ok: true, challenge: toChallenge(row) };
    }
    const attempts = row.attempts + 1;
    await tx.query(`UPDATE email_challenges SET attempts = $2${attempts >= MAX_CODE_ATTEMPTS ? ", used_at = now()" : ""} WHERE id = $1`, [row.id, attempts]);
    const left = MAX_CODE_ATTEMPTS - attempts;
    return { ok: false, reason: left > 0 ? "wrong" : "spent", left };
  });
}

/** What a link is for, without using it up (for the page that asks the person to press the button). */
export async function peekLink(db: Db, token: string): Promise<Challenge | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const rows = await db.query<Row>(
    "SELECT id, purpose, email, user_id, code_hash, attempts, next FROM email_challenges WHERE link_hash = $1 AND used_at IS NULL AND expires_at > now()",
    [linkHash(token)],
  );
  return rows[0] ? toChallenge(rows[0]) : null;
}

/** Uses a link up. Only sign-in links exist: the other purposes are code-only. */
export async function useLink(db: Db, token: string): Promise<Challenge | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const rows = await db.query<Row>(
    `UPDATE email_challenges SET used_at = now()
      WHERE link_hash = $1 AND purpose = 'signin' AND used_at IS NULL AND expires_at > now()
      RETURNING id, purpose, email, user_id, code_hash, attempts, next`,
    [linkHash(token)],
  );
  return rows[0] ? toChallenge(rows[0]) : null;
}
