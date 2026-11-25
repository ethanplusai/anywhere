import { chmodSync, mkdirSync } from "node:fs";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { embeddedDbRefusal, loadConfig } from "./config.js";
import { pgDb, pgliteDb, type Db } from "./db/db.js";
import { migrate } from "./db/migrate.js";
import { prepareLocal } from "./local.js";

const config = loadConfig();
const refusal = embeddedDbRefusal(config);
if (refusal) {
  console.error(refusal);
  process.exit(1);
}

let db: Db;
if (config.databaseUrl) {
  db = pgDb(config.databaseUrl, config.db);
} else {
  // The embedded database's files are created readable and writable by everyone, so the folder
  // that holds them is the owner's alone.
  mkdirSync(config.pgliteDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(config.pgliteDir, 0o700);
  db = await pgliteDb(config.pgliteDir);
  console.log(`No DATABASE_URL: using the embedded database in ${config.pgliteDir}`);
}

const applied = await migrate(db);
if (applied.length) console.log(`Applied migrations: ${applied.join(", ")}`);

const local = config.local ? await prepareLocal(db, config) : undefined;
const app = createApp({ db, config, ...(local ? { local } : {}) });
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  if (!local) {
    console.log(`Anywhere listening on ${config.host}:${info.port}. MCP endpoint: ${config.baseUrl}/mcp`);
    return;
  }
  console.log(
    [
      "",
      `Anywhere is running on this computer only, at ${config.baseUrl}`,
      "",
      "Open it (this link unlocks one browser, once; keep it to yourself):",
      `  ${config.baseUrl}/local/unlock#token=${local.browserToken}`,
      "",
      "Connect Claude Code (once):",
      `  claude mcp add --scope user --transport http anywhere-local ${config.baseUrl}/mcp --header "Authorization: Bearer $(cat ${local.agentTokenPath})"`,
      "",
      `Your pages and tokens are in ${config.home}. Stop with Ctrl+C.`,
      "",
    ].join("\n"),
  );
});

async function shutdown(signal: string) {
  console.log(`${signal}: shutting down`);
  server.close();
  await db.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
