/**
 * The server as a library. `main.ts` is the standalone program built from these pieces; anything
 * else that hosts Anywhere (a serverless entry, a test, another service) imports from here.
 */
export { createApp, type AppOptions } from "./app.js";
export { loadConfig, type Config } from "./config.js";
export { pgDb, pgliteDb, type Db, type PgOptions } from "./db/db.js";
export { migrate } from "./db/migrate.js";
export { loadLayout, parseLayout, type Layout } from "./content/layout.js";
export { purgeExpired } from "./db/maintenance.js";
export { approveEmail, isApproved, normalizeEmail } from "./auth/early-access.js";
export { prepareLocal, localGuard, OWNER_EMAIL, type LocalSetup } from "./local.js";
