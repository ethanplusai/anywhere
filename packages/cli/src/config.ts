import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CliError } from "./errors.js";

export type Credentials = { default?: string; servers: Record<string, { token: string }> };

export function configDir(env: NodeJS.ProcessEnv): string {
  if (env["ANYWR_CONFIG_DIR"]) return env["ANYWR_CONFIG_DIR"];
  if (env["XDG_CONFIG_HOME"]) return join(env["XDG_CONFIG_HOME"], "anywr");
  if (process.platform === "win32" && env["APPDATA"]) return join(env["APPDATA"], "anywr");
  return join(env["HOME"] ?? homedir(), ".config", "anywr");
}

export function normalizeServer(input: string): string {
  let u: URL;
  try {
    u = new URL(input.includes("://") ? input : `https://${input}`);
  } catch {
    throw new CliError(`"${input}" is not a valid server URL.`, 2);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new CliError("The server URL must start with https:// or http://.", 2);
  // Over plain http the token crosses the network in the clear, so it is only allowed to this computer.
  if (u.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) {
    throw new CliError(`${u.origin} is not on this computer, so it must use https://.`, 2);
  }
  return u.origin + u.pathname.replace(/\/+$/, "");
}

const file = (env: NodeJS.ProcessEnv) => join(configDir(env), "credentials.json");

export async function readCredentials(env: NodeJS.ProcessEnv): Promise<Credentials> {
  try {
    const parsed = JSON.parse(await readFile(file(env), "utf8")) as Credentials;
    return { ...parsed, servers: parsed.servers ?? {} };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { servers: {} };
    throw new CliError(`Cannot read ${file(env)}: ${(e as Error).message}`);
  }
}

export async function writeCredentials(env: NodeJS.ProcessEnv, creds: Credentials): Promise<void> {
  const path = file(env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

/**
 * The token for a server. ANYWR_TOKEN wins over the stored one, but only for a server the person
 * named themself with --server or ANYWR_SERVER. A linked folder names its own server in a file that
 * can arrive with a cloned repository, and the token must never be sent wherever that file says.
 */
export async function tokenFor(env: NodeJS.ProcessEnv, server: string, named?: string): Promise<string> {
  const fromEnv = env["ANYWR_TOKEN"];
  if (fromEnv) {
    const chosen = [named, env["ANYWR_SERVER"]].filter((s): s is string => Boolean(s)).map(normalizeServer);
    if (chosen.includes(server)) return fromEnv;
  }
  const creds = await readCredentials(env);
  const t = creds.servers[server]?.token;
  if (!t) {
    const hint = fromEnv ? ` ANYWR_TOKEN is only used for the server named by --server or ANYWR_SERVER.` : "";
    throw new CliError(`Not signed in to ${server}. Run: anywr login ${server}${hint}`);
  }
  return t;
}
