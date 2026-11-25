import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { Db } from "../db/db.js";
import { randomToken, safeEqual, sha256Hex } from "../auth/crypto.js";

export type AuthMethod = "none" | "client_secret_post" | "client_secret_basic";
const AUTH_METHODS: readonly AuthMethod[] = ["none", "client_secret_post", "client_secret_basic"];

export interface OAuthClient {
  clientId: string;
  kind: "dcr" | "cimd";
  clientName: string | null;
  clientUri: string | null;
  redirectUris: string[];
  authMethod: AuthMethod;
  secretHash: string | null;
}

export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);
const CIMD_TTL_MS = 60 * 60 * 1000;
const CIMD_MAX_BYTES = 64 * 1024;
const CIMD_TIMEOUT_MS = 5000;

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLoopback(u: URL): boolean {
  return u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname);
}

/**
 * Exact string match, except loopback redirects (RFC 8252 section 7.3): same host, path and query,
 * any port, because native clients such as Claude Code pick a free port at run time.
 */
export function redirectUriMatches(registered: string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  const req = parseUrl(requested);
  if (!req || !isLoopback(req)) return false;
  return registered.some((r) => {
    const reg = parseUrl(r);
    return (
      !!reg &&
      isLoopback(reg) &&
      reg.hostname === req.hostname &&
      reg.pathname === req.pathname &&
      reg.search === req.search &&
      !req.hash
    );
  });
}

/** https anywhere, http only on loopback, or a private-use scheme like `cursor://`; never a fragment. */
function acceptableRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2000) return false;
  const u = parseUrl(value);
  if (!u || u.hash || value.includes("#")) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") return isLoopback(u);
  return /^[a-z][a-z0-9+.-]*\.[a-z0-9+.-]+:$/.test(u.protocol); // reverse-domain private-use scheme
}

function validRedirectUris(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new OAuthError("invalid_redirect_uri", "redirect_uris must be a non-empty array.");
  }
  for (const uri of value) {
    if (!acceptableRedirectUri(uri)) {
      throw new OAuthError(
        "invalid_redirect_uri",
        "Each redirect URI must be https, http on a loopback address, or a private-use scheme, without a fragment.",
      );
    }
  }
  return value as string[];
}

function optionalString(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;
}

interface ClientRow {
  client_id: string;
  kind: "dcr" | "cimd";
  client_name: string | null;
  client_uri: string | null;
  redirect_uris: string[];
  token_endpoint_auth_method: AuthMethod;
  client_secret_hash: string | null;
  fetched_at: Date | null;
}

const toClient = (r: ClientRow): OAuthClient => ({
  clientId: r.client_id,
  kind: r.kind,
  clientName: r.client_name,
  clientUri: r.client_uri,
  redirectUris: r.redirect_uris,
  authMethod: r.token_endpoint_auth_method,
  secretHash: r.client_secret_hash,
});

/** RFC 7591 dynamic client registration. Returns the response body for a 201. */
const GRANT_TYPES = ["authorization_code", "refresh_token"];
const MAX_METADATA_JSON = 8 * 1024;

/** Checks registration metadata and returns the parts this server uses. Throws OAuthError on anything it refuses. */
export function checkClientMetadata(meta: Record<string, unknown>) {
  if (JSON.stringify(meta).length > MAX_METADATA_JSON) {
    throw new OAuthError("invalid_client_metadata", `Client metadata is limited to ${MAX_METADATA_JSON} bytes.`);
  }
  const redirectUris = validRedirectUris(meta.redirect_uris);
  // RFC 7591: the default is client_secret_basic.
  const method = (meta.token_endpoint_auth_method ?? "client_secret_basic") as AuthMethod;
  if (!AUTH_METHODS.includes(method)) {
    throw new OAuthError("invalid_client_metadata", `token_endpoint_auth_method must be one of ${AUTH_METHODS.join(", ")}.`);
  }
  const grantTypes = (meta.grant_types as unknown) ?? ["authorization_code", "refresh_token"];
  if (!Array.isArray(grantTypes) || !grantTypes.includes("authorization_code") || grantTypes.some((g) => !GRANT_TYPES.includes(g))) {
    throw new OAuthError("invalid_client_metadata", "grant_types must include authorization_code and may also include refresh_token.");
  }
  const responseTypes = (meta.response_types as unknown) ?? ["code"];
  if (!Array.isArray(responseTypes) || responseTypes.some((r) => r !== "code")) {
    throw new OAuthError("invalid_client_metadata", 'response_types may only contain "code".');
  }
  const clientName = optionalString(meta.client_name, 200);
  const clientUri = optionalString(meta.client_uri, 500);
  return { redirectUris, method, grantTypes: grantTypes as string[], clientName, clientUri };
}

export async function registerClient(db: Db, meta: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { redirectUris, method, grantTypes, clientName, clientUri } = checkClientMetadata(meta);
  const clientId = randomToken(18);
  const secret = method === "none" ? null : randomToken(32);
  // Only the fields this server uses are stored, never the caller's whole blob (audit A6).
  const stored = { redirect_uris: redirectUris, grant_types: grantTypes, response_types: ["code"], token_endpoint_auth_method: method };
  await db.query(
    `INSERT INTO oauth_clients (client_id, kind, client_name, client_uri, redirect_uris, token_endpoint_auth_method, client_secret_hash, metadata)
     VALUES ($1, 'dcr', $2, $3, $4, $5, $6, $7)`,
    [clientId, clientName, clientUri, JSON.stringify(redirectUris), method, secret ? sha256Hex(secret) : null, JSON.stringify(stored)],
  );
  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    redirect_uris: redirectUris,
    token_endpoint_auth_method: method,
    grant_types: grantTypes,
    response_types: ["code"],
    ...(clientName ? { client_name: clientName } : {}),
    ...(clientUri ? { client_uri: clientUri } : {}),
  };
}

/** A client_id that is an https URL with a path is a Client ID Metadata Document. */
export function isMetadataDocumentId(clientId: string): boolean {
  const u = parseUrl(clientId);
  return !!u && u.protocol === "https:" && u.pathname.length > 1;
}

export interface ClientLookupOptions {
  /**
   * Injected fetch (tests). Without it, documents are fetched over https pinned to the address that
   * passed the public-address check, so a second DNS answer cannot point the request elsewhere.
   */
  fetch?: typeof fetch | undefined;
  allowPrivate: boolean;
  /** Called before any network fetch; throws OAuthError to refuse (rate limits, audit A5). */
  beforeFetch?: () => Promise<void>;
  /** DNS resolution, injectable for tests. */
  resolve?: (host: string) => Promise<string[]>;
  /** https.request, injectable for tests. */
  request?: typeof httpsRequest;
}

const CIMD_FAILURE_TTL_S = 300;
const CIMD_MAX_CONCURRENT = 4;
/** One fetch per document URL at a time in this process; other callers wait for its result. */
const inFlight = new Map<string, Promise<Record<string, unknown>>>();
let fetching = 0;

/** Finds a registered client or fetches (and caches) a metadata document. Throws OAuthError("invalid_client"). */
export async function getClient(db: Db, clientId: string, opts: ClientLookupOptions): Promise<OAuthClient> {
  const rows = await db.query<ClientRow>("SELECT * FROM oauth_clients WHERE client_id = $1", [clientId]);
  const row = rows[0];
  if (row && row.kind === "dcr") return toClient(row);
  if (!isMetadataDocumentId(clientId)) throw new OAuthError("invalid_client", "Unknown client_id.");
  if (row && row.fetched_at && Date.now() - new Date(row.fetched_at).getTime() < CIMD_TTL_MS) return toClient(row);
  const doc = await fetchDeduplicated(db, clientId, opts);
  const redirectUris = validRedirectUris(doc.redirect_uris);
  const method = (doc.token_endpoint_auth_method ?? "none") as string;
  if (method !== "none") {
    throw new OAuthError("invalid_client", "Clients identified by a metadata document must use token_endpoint_auth_method none.");
  }
  const saved = await db.query<ClientRow>(
    `INSERT INTO oauth_clients (client_id, kind, client_name, client_uri, redirect_uris, token_endpoint_auth_method, metadata, fetched_at)
     VALUES ($1, 'cimd', $2, $3, $4, 'none', $5, now())
     ON CONFLICT (client_id) DO UPDATE SET client_name = EXCLUDED.client_name, client_uri = EXCLUDED.client_uri,
       redirect_uris = EXCLUDED.redirect_uris, metadata = EXCLUDED.metadata, fetched_at = now()
     RETURNING *`,
    [clientId, optionalString(doc.client_name, 200), optionalString(doc.client_uri, 500), JSON.stringify(redirectUris), JSON.stringify(doc)],
  );
  return toClient(saved[0]!);
}

/**
 * Negative cache per host, the caller's rate limits, one in-flight fetch per URL and a cap on
 * concurrent fetches, so /oauth/authorize and /oauth/token cannot be used as a request reflector
 * (audit A5).
 */
async function fetchDeduplicated(db: Db, url: string, opts: ClientLookupOptions): Promise<Record<string, unknown>> {
  const pending = inFlight.get(url);
  if (pending) return pending;
  const host = new URL(url).hostname.toLowerCase();
  const p = (async () => {
    const failed = await db.query("SELECT 1 FROM cimd_failures WHERE host = $1 AND until > now()", [host]);
    if (failed[0]) throw new OAuthError("invalid_client", "The client metadata document could not be fetched recently. Try again in a few minutes.");
    await opts.beforeFetch?.();
    if (fetching >= CIMD_MAX_CONCURRENT) throw new OAuthError("temporarily_unavailable", "Too many client lookups at once. Try again shortly.", 503);
    fetching++;
    try {
      return await fetchMetadataDocument(url, opts);
    } catch (err) {
      if (err instanceof OAuthError) {
        await db.query(
          `INSERT INTO cimd_failures (host, until) VALUES ($1, now() + make_interval(secs => $2))
           ON CONFLICT (host) DO UPDATE SET until = EXCLUDED.until`,
          [host, CIMD_FAILURE_TTL_S],
        );
      }
      throw err;
    } finally {
      fetching--;
    }
  })().finally(() => inFlight.delete(url));
  // Set before any await, so simultaneous callers find it.
  inFlight.set(url, p);
  return p;
}

const GENERIC_FETCH_ERROR = "Could not fetch the client metadata document.";

async function resolvePublic(host: string, opts: ClientLookupOptions): Promise<string[]> {
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : opts.resolve ? await opts.resolve(host) : (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    throw new OAuthError("invalid_client", "The client metadata document's host does not resolve.");
  }
  if (addresses.length === 0) throw new OAuthError("invalid_client", "The client metadata document's host does not resolve.");
  if (!opts.allowPrivate && addresses.some(isPrivateAddress)) {
    throw new OAuthError("invalid_client", "Client metadata documents must be on a public address.");
  }
  return addresses;
}

/**
 * GET over https to exactly `address`: the connection's DNS lookup is answered with the address that
 * was vetted, so a rebinding resolver gets no second chance. TLS still verifies the certificate
 * against the URL's host name. Redirects are not followed.
 */
function pinnedGet(url: URL, address: string, request: typeof httpsRequest): Promise<string> {
  const family = isIP(address) === 6 ? 6 : 4;
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        headers: { accept: "application/json" },
        timeout: CIMD_TIMEOUT_MS,
        lookup: ((_host: string, options: { all?: boolean }, cb: (...args: unknown[]) => void) => {
          if (options?.all) cb(null, [{ address, family }]);
          else cb(null, address, family);
        }) as never,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new OAuthError("invalid_client", GENERIC_FETCH_ERROR));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > CIMD_MAX_BYTES) {
            req.destroy();
            reject(new OAuthError("invalid_client", "The client metadata document is too large."));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        res.on("error", () => reject(new OAuthError("invalid_client", GENERIC_FETCH_ERROR)));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => reject(new OAuthError("invalid_client", GENERIC_FETCH_ERROR)));
    req.end();
  });
}

export async function fetchMetadataDocument(url: string, opts: ClientLookupOptions): Promise<Record<string, unknown>> {
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  // Tests inject fetch and allow private hosts; nothing needs resolving then.
  const addresses = opts.fetch && opts.allowPrivate ? [] : await resolvePublic(host, opts);
  let text: string;
  if (opts.fetch) {
    let res: Response;
    try {
      res = await opts.fetch(url, {
        redirect: "error",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(CIMD_TIMEOUT_MS),
      });
    } catch {
      throw new OAuthError("invalid_client", GENERIC_FETCH_ERROR);
    }
    // The upstream status is not echoed (audit, suspected item 1).
    if (!res.ok) throw new OAuthError("invalid_client", GENERIC_FETCH_ERROR);
    text = await readCapped(res, CIMD_MAX_BYTES);
  } else {
    text = await pinnedGet(parsed, addresses[0]!, opts.request ?? httpsRequest);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new OAuthError("invalid_client", "The client metadata document is not JSON.");
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new OAuthError("invalid_client", "The client metadata document is not a JSON object.");
  }
  const record = doc as Record<string, unknown>;
  if (record.client_id !== url) {
    throw new OAuthError("invalid_client", "The client metadata document's client_id does not match its URL.");
  }
  return record;
}

async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw new OAuthError("invalid_client", "The client metadata document is too large.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Loopback, private, link-local, CGNAT, unspecified and unique-local addresses, v4 and v6. */
export function isPrivateAddress(address: string): boolean {
  let a = address.toLowerCase();
  // IPv4-mapped IPv6, dotted (::ffff:127.0.0.1) or hex (::ffff:7f00:1, which is how URL normalises it).
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (mapped?.[1]) a = mapped[1];
  else if (mappedHex?.[1] && mappedHex[2]) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    a = [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
  }
  if (isIP(a) === 4) {
    const [p0, p1] = a.split(".").map(Number) as [number, number];
    return (
      p0 === 0 ||
      p0 === 10 ||
      p0 === 127 ||
      (p0 === 100 && p1 >= 64 && p1 <= 127) ||
      (p0 === 169 && p1 === 254) ||
      (p0 === 172 && p1 >= 16 && p1 <= 31) ||
      (p0 === 192 && p1 === 168) ||
      (p0 === 192 && p1 === 0 && Number(a.split(".")[2]) === 0) ||
      (p0 === 198 && (p1 === 18 || p1 === 19)) ||
      p0 >= 224
    );
  }
  if (isIP(a) === 6) {
    // Also NAT64 (64:ff9b::/96), 6to4 (2002::/16) and the discard/documentation prefixes, which can reach IPv4 space.
    return (
      a === "::" ||
      a === "::1" ||
      /^f[cd]/.test(a) ||
      /^fe[89ab]/.test(a) ||
      /^ff/.test(a) ||
      /^64:ff9b:/.test(a) ||
      /^2002:/.test(a) ||
      /^100::/.test(a) ||
      /^2001:db8:/.test(a) ||
      /^::(\d|[0-9a-f]{1,4}:)/.test(a) // other IPv4-compatible / embedded forms
    );
  }
  return true;
}

/** Client authentication at the token endpoint. Returns the authenticated client. */
export async function authenticateClient(
  db: Db,
  form: URLSearchParams,
  authorization: string | undefined,
  opts: ClientLookupOptions,
): Promise<OAuthClient> {
  let clientId = form.get("client_id");
  const postSecret = form.get("client_secret");
  let basicSecret: string | null = null;
  const basic = /^Basic\s+(\S+)$/i.exec(authorization ?? "");
  if (basic?.[1]) {
    const decoded = Buffer.from(basic[1], "base64").toString("utf8");
    const i = decoded.indexOf(":");
    if (i < 0) throw new OAuthError("invalid_client", "Malformed Basic credentials.", 401);
    try {
      clientId = decodeURIComponent(decoded.slice(0, i));
      basicSecret = decodeURIComponent(decoded.slice(i + 1));
    } catch {
      // A bad percent-escape was a 500 (audit A13).
      throw new OAuthError("invalid_client", "Malformed Basic credentials.", 401);
    }
  }
  if (!clientId) throw new OAuthError("invalid_client", "client_id is required.", 401);
  let client: OAuthClient;
  try {
    client = await getClient(db, clientId, opts);
  } catch (err) {
    if (err instanceof OAuthError) throw new OAuthError("invalid_client", err.description, 401);
    throw err;
  }
  if (client.authMethod !== "none") {
    // The secret must arrive the way the client registered (audit A13).
    const secret = client.authMethod === "client_secret_basic" ? basicSecret : postSecret;
    const other = client.authMethod === "client_secret_basic" ? postSecret : basicSecret;
    if (other !== null || !secret || !client.secretHash || !safeEqual(sha256Hex(secret), client.secretHash)) {
      throw new OAuthError("invalid_client", "Client authentication failed.", 401);
    }
  }
  return client;
}
