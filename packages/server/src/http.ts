import type { Context } from "hono";
import { isIP } from "node:net";
import { AppError } from "./service/errors.js";
import { MAX_BODY_BYTES } from "./service/validate.js";

/** docs/api.md ApiError body, plus `current` on conflicts. */
export function errorResponse(c: Context, err: AppError): Response {
  const body: Record<string, unknown> = { error: { code: err.code, message: err.message } };
  if ("current" in err.extra) body.current = err.extra.current;
  const headers: Record<string, string> = {};
  if (typeof err.extra.retryAfter === "number") headers["Retry-After"] = String(err.extra.retryAfter);
  return c.json(body, err.status, headers);
}

/** Reads the raw body with the 1 MiB cap from docs/api.md. */
export async function readBody(c: Context): Promise<string> {
  const declared = Number(c.req.header("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) throw tooLarge();
  const buf = Buffer.from(await c.req.arrayBuffer());
  if (buf.length > MAX_BODY_BYTES) throw tooLarge();
  return buf.toString("utf8");
}

/** Parses a JSON object body; anything else is 422 invalid_body. */
export async function readJsonObject(c: Context): Promise<Record<string, unknown>> {
  const text = await readBody(c);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new AppError(422, "invalid_body", "The request body must be a JSON object.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(422, "invalid_body", "The request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function tooLarge(): AppError {
  return new AppError(422, "too_large", `Request bodies are limited to ${MAX_BODY_BYTES} bytes.`);
}

export interface ClientIpConfig {
  trustProxyHops: number;
  clientIpHeader: string | undefined;
}

let warnedUnknown = false;

/**
 * Client address for rate limiting (audit A1). In order: a platform header named by
 * ANYWHERE_CLIENT_IP_HEADER; the Nth X-Forwarded-For entry from the right when N proxies you control
 * append to it (the left-most entries are whatever the client sent); the socket address. When none is
 * available every client shares one bucket, which is logged once rather than happening silently.
 */
export function clientIp(c: Context, config: ClientIpConfig): string {
  if (config.clientIpHeader) {
    const value = c.req.header(config.clientIpHeader);
    const last = value?.split(",").pop()?.trim();
    if (last && isIP(stripBrackets(last))) return stripBrackets(last);
  } else if (config.trustProxyHops > 0) {
    const entries = (c.req.header("x-forwarded-for") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const entry = entries[entries.length - config.trustProxyHops];
    if (entry && isIP(stripBrackets(entry))) return stripBrackets(entry);
  }
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  const socket = env?.incoming?.socket?.remoteAddress;
  if (socket) return socket;
  if (!warnedUnknown && process.env.NODE_ENV !== "test") {
    warnedUnknown = true;
    console.warn(
      "Anywhere cannot see client addresses: set ANYWHERE_CLIENT_IP_HEADER (or ANYWHERE_TRUST_PROXY behind your own proxy). " +
        "Until then every client shares one address-based rate limit bucket.",
    );
  }
  return "unknown";
}

function stripBrackets(s: string): string {
  return s.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
}

/** The rate limit key for an address: IPv4 as is, IPv6 by its /64 (one customer usually holds a whole /64). */
export function ipKey(address: string): string {
  let a = stripBrackets(address.trim().toLowerCase());
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped?.[1]) a = mapped[1];
  if (isIP(a) !== 6) return a;
  return expandIPv6(a).slice(0, 4).join(":") + "::/64";
}

function expandIPv6(a: string): string[] {
  // An embedded IPv4 tail becomes two hextets.
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (v4) {
    const [b0, b1, b2, b3] = v4.slice(1).map(Number) as [number, number, number, number];
    a = a.slice(0, v4.index) + ((b0 << 8) | b1).toString(16) + ":" + ((b2 << 8) | b3).toString(16);
  }
  const [head = "", tail] = a.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const fill = tail === undefined ? [] : Array(8 - h.length - t.length).fill("0");
  return [...h, ...fill, ...t].map((x) => x.padStart(4, "0"));
}
