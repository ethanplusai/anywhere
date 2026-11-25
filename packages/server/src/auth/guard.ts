import type { Context } from "hono";
import type { Deps } from "../deps.js";
import { clientIp, ipKey } from "../http.js";
import { resolveBearer, type Principal } from "./resolve.js";

export type Guarded =
  | { ok: true; principal: Principal; release: () => void }
  | { ok: false; status: 401 | 429; message: string; retryAfter?: number };

/**
 * Shared front door of /api/v1 and /mcp: bearer authentication, a per-address limit on failed
 * authentication (audit A2, A14), the per-user request limit, and a per-user cap on concurrent
 * requests in this process (audit D1). The caller must call `release` when the response is ready.
 */
export async function guardBearer(deps: Deps, c: Context, resources: string[], opts: { patOnly?: boolean } = {}): Promise<Guarded> {
  const { db, config, limiter, userGate } = deps;
  const principal = await resolveBearer(db, c.req.header("authorization"), { resources, ...(opts.patOnly ? { patOnly: true } : {}) });
  if (!principal) {
    const wait = await limiter.hit(`unauth:${ipKey(clientIp(c, config))}`, { limit: config.unauthRateLimit, windowS: 60 });
    if (wait !== null) return { ok: false, status: 429, retryAfter: wait, message: `Too many failed requests. Try again in ${wait} seconds.` };
    return { ok: false, status: 401, message: "Send a valid token as Authorization: Bearer <token>." };
  }
  const wait = await limiter.hit(`user:${principal.userId}`, { limit: config.apiRateLimit, windowS: 60 });
  if (wait !== null) return { ok: false, status: 429, retryAfter: wait, message: `Too many requests. Try again in ${wait} seconds.` };
  const release = userGate.tryEnter(principal.userId);
  if (!release) return { ok: false, status: 429, retryAfter: 1, message: "Too many requests at once. Wait for the others to finish." };
  return { ok: true, principal, release };
}
