import type { Db } from "../db/db.js";

/** The one spelling an email is stored and looked up under. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Whether this email may create an account while sign-ups need approval. */
export async function isApproved(db: Db, email: string): Promise<boolean> {
  const rows = await db.query("SELECT 1 FROM early_access WHERE email = $1", [normalizeEmail(email)]);
  return rows.length > 0;
}

/** Adds an email to the early-access list. Approving twice is harmless. */
export async function approveEmail(db: Db, email: string, by = ""): Promise<void> {
  await db.query("INSERT INTO early_access (email, approved_by) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING", [normalizeEmail(email), by]);
}
