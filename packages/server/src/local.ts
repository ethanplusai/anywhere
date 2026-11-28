import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync, chmodSync } from "node:fs";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { randomToken } from "./auth/crypto.js";
import { resolveBearer } from "./auth/resolve.js";
import { createPat } from "./auth/tokens.js";
import { createUser } from "./auth/users.js";
import { ConfigError, type Config } from "./config.js";
import type { Db } from "./db/db.js";

/*
 * Local mode: Anywhere for one person on their own computer. Four layers:
 *
 *   1. It listens on a loopback address only (config.ts refuses anything else).
 *   2. Every request must name this computer in its Host header (127.0.0.1, localhost or [::1] with
 *      this port), so a website that points its own domain name at 127.0.0.1 cannot reach it.
 *   3. Requests a browser sends on another website's behalf are refused: an Origin other than this
 *      server's, or a Sec-Fetch-Site other than same-origin or none.
 *   4. There are no accounts. The browser is unlocked with a link whose token sits in an owner-only
 *      file and is replaced as soon as it has been used, so a link seen in a terminal, a screen
 *      share or a log opens nothing afterwards; agents send a second token, from its own owner-only
 *      file, as a header.
 *
 * Programs already running as the same user can read the token files, as they can read the
 * database. That is the line local mode draws.
 */

/** The one account a local server has. The address is reserved (RFC 2606) and never receives mail. */
export const OWNER_EMAIL = "owner@this-computer.invalid";
export const AGENT_TOKEN_NAME = "Local agents";

export interface LocalSetup {
  ownerId: string;
  /** The token that unlocks a browser next. It changes each time it is used. */
  browserToken: string;
  browserTokenPath: string;
  agentTokenPath: string;
  /** Replaces the browser token, in the file and here, once it has unlocked a browser. */
  renewBrowserToken(): string;
}

/** Reads a token file, refusing one that is a link, not ours, or readable by anyone else. */
function readTokenFile(path: string): string | null {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return null;
  }
  const fix = `Delete ${path} and start Anywhere again to make a new one.`;
  if (!st.isFile()) throw new ConfigError(`${path} is not a plain file. ${fix}`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new ConfigError(`${path} belongs to another user. ${fix}`);
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
    throw new ConfigError(`${path} can be read by other users (mode ${(st.mode & 0o777).toString(8)}), so its token may be known. ${fix}`);
  }
  const token = readFileSync(path, "utf8").trim();
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) throw new ConfigError(`${path} does not hold a valid token. ${fix}`);
  return token;
}

/** Writes a new token file readable only by its owner. Never follows a link or replaces a file. */
function writeTokenFile(path: string, token: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    if (process.platform !== "win32") fchmodSync(fd, 0o600);
    if (!fstatSync(fd).isFile()) throw new ConfigError(`${path} is not a plain file.`);
    writeSync(fd, `${token}\n`);
  } finally {
    closeSync(fd);
  }
}

/** Creates the owner, the agent token and the browser token the first time; reuses them after. */
export async function prepareLocal(db: Db, config: Config): Promise<LocalSetup> {
  mkdirSync(config.home, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(config.home, 0o700);

  const [found] = await db.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [OWNER_EMAIL]);
  // The owner never signs in: the browser is unlocked with a token from a file instead.
  const ownerId = found?.id ?? (await createUser(db, OWNER_EMAIL)).id;

  const agentTokenPath = join(config.home, "agent-token");
  const existing = readTokenFile(agentTokenPath);
  if (existing) {
    const principal = await resolveBearer(db, `Bearer ${existing}`);
    if (principal?.userId !== ownerId) {
      throw new ConfigError(`${agentTokenPath} holds a token this database does not know. Delete it and start Anywhere again.`);
    }
  } else {
    const { token } = await createPat(db, ownerId, AGENT_TOKEN_NAME);
    writeTokenFile(agentTokenPath, token);
  }

  const browserTokenPath = join(config.home, "browser-token");
  let browserToken = readTokenFile(browserTokenPath);
  if (!browserToken) {
    browserToken = randomToken(32);
    writeTokenFile(browserTokenPath, browserToken);
  }
  const setup: LocalSetup = {
    ownerId,
    browserToken,
    browserTokenPath,
    agentTokenPath,
    renewBrowserToken() {
      const next = randomToken(32);
      const fresh = `${browserTokenPath}.new`;
      rmSync(fresh, { force: true });
      writeTokenFile(fresh, next);
      renameSync(fresh, browserTokenPath);
      setup.browserToken = next;
      return next;
    },
  };
  return setup;
}

/** Host values a local server answers to, for its own port. */
export function localHosts(config: Config): Set<string> {
  const port = new URL(config.baseUrl).port || String(config.port);
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

/** Layers 2 and 3: the request must name this computer and must not come from another website. */
export function localGuard(config: Config): MiddlewareHandler {
  const hosts = localHosts(config);
  const origins = new Set([...hosts].map((h) => `http://${h}`));
  const refuse = (text: string, status: 403 | 421) =>
    new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  return async (c, next) => {
    const host = c.req.header("host")?.toLowerCase() ?? "";
    if (!hosts.has(host)) {
      return refuse(`This Anywhere runs on this computer only. Open it at ${config.baseUrl}`, 421);
    }
    const origin = c.req.header("origin");
    if (origin !== undefined && !origins.has(origin.toLowerCase())) {
      return refuse("Requests from other websites are refused.", 403);
    }
    const site = c.req.header("sec-fetch-site");
    if (site !== undefined && site !== "same-origin" && site !== "none") {
      return refuse(`Requests from other websites are refused. Open ${config.baseUrl} directly.`, 403);
    }
    await next();
  };
}
