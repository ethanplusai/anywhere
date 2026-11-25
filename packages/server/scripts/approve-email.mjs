/* global process, console, URL */
// Adds an email to the early-access list, for servers running with ANYWHERE_SIGNUPS=approved.
//
//   node packages/server/scripts/approve-email.mjs someone@example.com
//
// Uses DATABASE_URL when set, otherwise the embedded database in ANYWHERE_PGLITE_DIR (default ./data).
// Run `pnpm --filter ./packages/server build` first.
import { loadConfig, migrate, pgDb, pgliteDb } from "../dist/index.js";
import { approveEmail } from "../dist/auth/early-access.js";
import { fileURLToPath } from "node:url";

const email = process.argv[2];
if (!email || !email.includes("@")) {
  console.error("Usage: approve-email.mjs <email>");
  process.exit(1);
}
const config = loadConfig();
const db = config.databaseUrl ? pgDb(config.databaseUrl, config.db) : await pgliteDb(config.pgliteDir);
await migrate(db, fileURLToPath(new URL("../migrations/", import.meta.url)));
await approveEmail(db, email, "approve-email script");
await db.close();
console.log(`Approved ${email.trim().toLowerCase()}. They can now create an account.`);
