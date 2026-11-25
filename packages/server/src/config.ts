import { homedir } from "node:os";
import { join as joinPath, resolve as resolvePath } from "node:path";

export type SignupMode = "open" | "approved" | "closed";

function signupMode(env: Record<string, string | undefined>): SignupMode {
  const raw = env.ANYWHERE_SIGNUPS?.trim().toLowerCase();
  if (raw === "open" || raw === "approved" || raw === "closed") return raw;
  if (raw) throw new ConfigError(`ANYWHERE_SIGNUPS must be open, approved or closed, not "${raw}".`);
  return isTrue(env.ANYWHERE_DISABLE_SIGNUPS) ? "closed" : "open";
}

export interface Config {
  /**
   * Local mode (ANYWHERE_LOCAL=1): one person on their own computer. The server listens on a
   * loopback address only, refuses requests that do not name one or that come from another
   * website, keeps its data and tokens in `home`, and has no accounts: the owner unlocks the
   * browser with a one-time link and agents use a token from an owner-only file. See src/local.ts.
   */
  local: boolean;
  /** Where local mode keeps its database and token files. Default ~/.anywhere. */
  home: string;
  /** The address to listen on. Local mode allows loopback addresses only. */
  host: string;
  /** Public origin of the web app, OAuth and the sync API, no trailing slash, e.g. https://app.anywr.ai. */
  baseUrl: string;
  /**
   * Public origin the MCP endpoint is served from. The MCP URL is `${mcpOrigin}/mcp`. Defaults to
   * baseUrl; set ANYWHERE_MCP_ORIGIN (e.g. https://mcp.anywr.ai) to give agents a host of their own.
   */
  mcpOrigin: string;
  port: number;
  databaseUrl: string | undefined;
  pgliteDir: string;
  /** "open": anyone can sign up; "approved": only emails on the early-access list; "closed": nobody. */
  signups: SignupMode;
  /** Kept for callers that only ask whether sign-ups are closed. */
  disableSignups: boolean;
  /** Where people request early access while signups are "approved"; empty to show no link. */
  earlyAccessUrl: string;
  /** Requests per minute per subject on /api/v1 and /mcp. */
  apiRateLimit: number;
  /** Requests per minute per address on sign-in, sign-up, client registration and token creation. */
  authRateLimit: number;
  /** Failed sign-ins per account per 15 minutes before that account is locked for the rest of the window. */
  signinEmailLimit: number;
  /** Requests per minute per signed-in user (or per address when signed out) on web pages. */
  webRateLimit: number;
  /** Requests per minute per address that fail bearer authentication on /api/v1 and /mcp. */
  unauthRateLimit: number;
  /** Dynamic client registrations per hour across the whole server. */
  registrationsPerHour: number;
  /** Dynamic client registration attempts per hour from one address. */
  registrationsPerAddressPerHour: number;
  /** Client ID Metadata Document fetches per minute across the whole server. */
  cimdFetchesPerMinute: number;
  /** Concurrent /api/v1 and /mcp requests per user in one process. */
  maxConcurrentPerUser: number;
  /** Allow Client ID Metadata Documents on private or loopback hosts (tests and local dev only). */
  allowPrivateCimd: boolean;
  /**
   * How many proxies append to X-Forwarded-For in front of the server. 0 ignores the header; N takes
   * the Nth entry from the right, the one the outermost proxy you control wrote.
   */
  trustProxyHops: number;
  /** A header set by the platform with the client address (x-real-ip, cf-connecting-ip, ...). Wins over the hops. */
  clientIpHeader: string | undefined;
  /** Redirect hosts (or `scheme:` for private-use schemes) shown as verified on the consent page, with a name. */
  verifiedRedirects: Record<string, string>;
  layoutPath: string | undefined;
  /** The public website the app links to for docs, privacy and terms. */
  siteUrl: string;
  limits: Limits;
  /** Postgres pool settings (ignored for the embedded database). */
  db: { max: number; statementTimeoutMs: number; idleInTransactionTimeoutMs: number };
  /** Absolute lifetime of an OAuth grant (one connected app), however often it refreshes. */
  grantLifetimeDays: number;
  /** A web session ends after this many days without use, and always after 30. */
  sessionIdleDays: number;
}

/** Per-account storage limits, enforced inside the write transaction. */
export interface Limits {
  maxProjectsPerUser: number;
  maxPagesPerProject: number;
  /** Logical bytes per user: current page contents plus kept revisions. */
  maxBytesPerUser: number;
  /** Revisions kept per page (the current version counts as one). */
  revisionsKept: number;
  /** Appends to one page within this many seconds share one revision. */
  appendCoalesceSeconds: number;
  maxSearchQuery: number;
  /** Projects larger than this cannot be exported in one zip. */
  maxExportBytes: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxProjectsPerUser: 50,
  maxPagesPerProject: 500,
  maxBytesPerUser: 50 * 1024 * 1024,
  revisionsKept: 20,
  appendCoalesceSeconds: 600,
  maxSearchQuery: 256,
  maxExportBytes: 64 * 1024 * 1024,
};

/**
 * A local server belongs to one person on their own computer, so there is nobody to share it
 * fairly with: the quotas that keep a public server usable for everyone do not apply. How much
 * history is kept, and the shapes of things, stay the same.
 */
const NO_LIMIT = Number.MAX_SAFE_INTEGER;
export const LOCAL_LIMITS: Limits = {
  ...DEFAULT_LIMITS,
  maxProjectsPerUser: NO_LIMIT,
  maxPagesPerProject: NO_LIMIT,
  maxBytesPerUser: NO_LIMIT,
  maxExportBytes: NO_LIMIT,
};
/** True when a quota has been lifted rather than set. */
export const unlimited = (n: number) => n >= NO_LIMIT;

/** Well-known MCP clients, recognised by where they send the authorization code. */
const DEFAULT_VERIFIED_REDIRECTS: Record<string, string> = {
  "claude.ai": "Claude",
  "claude.com": "Claude",
  "chatgpt.com": "ChatGPT",
  "chat.openai.com": "ChatGPT",
  "cursor:": "Cursor",
  "vscode:": "Visual Studio Code",
};

export class ConfigError extends Error {}

/** The addresses local mode may listen on and be reached at. */
export const LOOPBACK_HOSTS = ["127.0.0.1", "::1", "localhost"];

function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(u.hostname);
  } catch {
    return false;
  }
}

/**
 * The standalone server refuses to run in production on the embedded database unless told to, so a
 * missing DATABASE_URL cannot quietly put real data in a container's filesystem (audit D10).
 */
export function embeddedDbRefusal(config: Config, env: Record<string, string | undefined> = process.env): string | null {
  if (config.databaseUrl || env.NODE_ENV !== "production" || isTrue(env.ANYWHERE_ALLOW_EMBEDDED_DB)) return null;
  return "DATABASE_URL is not set. In production Anywhere needs Postgres; set ANYWHERE_ALLOW_EMBEDDED_DB=1 to use the embedded database on purpose.";
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const local = isTrue(env.ANYWHERE_LOCAL);
  const quotas = local ? LOCAL_LIMITS : DEFAULT_LIMITS;
  const port = int(env, "PORT", local ? 3341 : 3000, 1);
  const home = resolvePath(env.ANYWHERE_HOME || joinPath(homedir(), ".anywhere"));
  const host = env.ANYWHERE_HOST?.trim() || (local ? "127.0.0.1" : "0.0.0.0");
  if (local && !LOOPBACK_HOSTS.includes(host)) {
    throw new ConfigError(`Local mode listens on this computer only: ANYWHERE_HOST must be one of ${LOOPBACK_HOSTS.join(", ")}, not "${host}".`);
  }
  if (local && env.BASE_URL && !isLoopbackUrl(env.BASE_URL)) {
    throw new ConfigError("Local mode serves this computer only: BASE_URL must be a loopback address such as http://127.0.0.1:3341.");
  }
  const baseUrl = (env.BASE_URL ?? `http://${local ? "127.0.0.1" : "localhost"}:${port}`).replace(/\/+$/, "");
  const production = env.NODE_ENV === "production";
  if (production) assertSecureBaseUrl(baseUrl);
  const mcpOrigin = (env.ANYWHERE_MCP_ORIGIN || baseUrl).replace(/\/+$/, "");
  if (production) assertSecureBaseUrl(mcpOrigin);
  const signups = local ? "closed" : signupMode(env);
  return {
    local,
    home,
    host,
    baseUrl,
    mcpOrigin,
    signups,
    earlyAccessUrl: env.ANYWHERE_EARLY_ACCESS_URL?.trim() ?? "",
    port,
    databaseUrl: env.DATABASE_URL || undefined,
    pgliteDir: env.ANYWHERE_PGLITE_DIR ?? (local ? joinPath(home, "data") : "./data"),
    disableSignups: signups === "closed",
    apiRateLimit: int(env, "ANYWHERE_API_RATE_LIMIT", 600),
    authRateLimit: int(env, "ANYWHERE_AUTH_RATE_LIMIT", 20),
    signinEmailLimit: int(env, "ANYWHERE_SIGNIN_EMAIL_LIMIT", 10),
    webRateLimit: int(env, "ANYWHERE_WEB_RATE_LIMIT", 300),
    unauthRateLimit: int(env, "ANYWHERE_UNAUTH_RATE_LIMIT", 30),
    registrationsPerHour: int(env, "ANYWHERE_REGISTRATIONS_PER_HOUR", 200),
    registrationsPerAddressPerHour: int(env, "ANYWHERE_REGISTRATIONS_PER_ADDRESS_PER_HOUR", 20),
    cimdFetchesPerMinute: int(env, "ANYWHERE_CIMD_FETCH_LIMIT", 60),
    maxConcurrentPerUser: int(env, "ANYWHERE_MAX_CONCURRENT_PER_USER", 8),
    allowPrivateCimd: isTrue(env.ANYWHERE_ALLOW_PRIVATE_CIMD),
    trustProxyHops: proxyHops(env.ANYWHERE_TRUST_PROXY),
    clientIpHeader: env.ANYWHERE_CLIENT_IP_HEADER?.trim().toLowerCase() || undefined,
    verifiedRedirects: { ...DEFAULT_VERIFIED_REDIRECTS, ...verifiedRedirects(env.ANYWHERE_VERIFIED_REDIRECTS) },
    layoutPath: env.ANYWHERE_LAYOUT_PATH || undefined,
    siteUrl: (env.ANYWHERE_SITE_URL || "https://anywr.ai").replace(/\/+$/, ""),
    limits: {
      maxProjectsPerUser: int(env, "ANYWHERE_MAX_PROJECTS", quotas.maxProjectsPerUser),
      maxPagesPerProject: int(env, "ANYWHERE_MAX_PAGES_PER_PROJECT", quotas.maxPagesPerProject),
      maxBytesPerUser: int(env, "ANYWHERE_MAX_BYTES_PER_USER", quotas.maxBytesPerUser),
      revisionsKept: int(env, "ANYWHERE_REVISIONS_KEPT", quotas.revisionsKept),
      appendCoalesceSeconds: int(env, "ANYWHERE_APPEND_COALESCE_SECONDS", quotas.appendCoalesceSeconds, 0),
      maxSearchQuery: int(env, "ANYWHERE_MAX_SEARCH_QUERY", quotas.maxSearchQuery),
      maxExportBytes: int(env, "ANYWHERE_MAX_EXPORT_BYTES", quotas.maxExportBytes),
    },
    db: {
      max: int(env, "ANYWHERE_DB_POOL_MAX", 10),
      statementTimeoutMs: int(env, "ANYWHERE_DB_STATEMENT_TIMEOUT_MS", 15_000),
      idleInTransactionTimeoutMs: int(env, "ANYWHERE_DB_IDLE_TX_TIMEOUT_MS", 10_000),
    },
    grantLifetimeDays: int(env, "ANYWHERE_GRANT_LIFETIME_DAYS", 90),
    sessionIdleDays: int(env, "ANYWHERE_SESSION_IDLE_DAYS", 14),
  };
}

/**
 * In production the session cookie must be Secure, which it only is on an https BASE_URL. Loopback
 * hosts are allowed so `docker compose up` on a laptop still works.
 */
function assertSecureBaseUrl(baseUrl: string): void {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new ConfigError(`BASE_URL "${baseUrl}" is not a URL.`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !loopback) {
    throw new ConfigError(`BASE_URL must be https in production (got ${baseUrl}); session cookies would not be Secure.`);
  }
}

function int(env: Record<string, string | undefined>, name: string, fallback: number, min = 1): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min) throw new ConfigError(`${name} must be an integer of at least ${min} (got "${raw}").`);
  return n;
}

function proxyHops(raw: string | undefined): number {
  if (raw === undefined || raw === "" || raw === "0" || raw.toLowerCase() === "false") return 0;
  if (raw.toLowerCase() === "true") return 1;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0 || n > 10) throw new ConfigError(`ANYWHERE_TRUST_PROXY must be 0-10 (got "${raw}").`);
  return n;
}

/** `host=Name,scheme:=Name` */
function verifiedRedirects(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (raw ?? "").split(",")) {
    const [key, name] = part.split("=").map((s) => s.trim());
    if (key && name) out[key.toLowerCase()] = name;
  }
  return out;
}

function isTrue(v: string | undefined): boolean {
  return v === "1" || v?.toLowerCase() === "true";
}
