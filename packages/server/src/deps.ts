import type { Config } from "./config.js";
import type { Db } from "./db/db.js";
import type { Layout } from "./content/layout.js";
import type { Service } from "./service/projects.js";
import type { ConcurrencyGate, RateLimiter } from "./auth/ratelimit.js";
import type { LocalSetup } from "./local.js";
import type { LocalConnector } from "./local-connect.js";
import type { Mailer } from "./mail/mailer.js";
import type { Brand } from "./mail/templates.js";
import type { RelyingParty } from "./auth/passkeys.js";

/** Everything the route modules share. Built once in createApp. */
export interface Deps {
  db: Db;
  config: Config;
  layout: Layout;
  service: Service;
  /** Postgres-backed, so limits hold across instances. */
  limiter: RateLimiter;
  /** Concurrent authenticated requests per user in this process. */
  userGate: ConcurrencyGate;
  /** Injected fetch for OAuth Client ID Metadata Documents (tests). Unset: pinned https requests. */
  fetch: typeof fetch | undefined;
  /** Set in local mode: the owner and the browser token (see src/local.ts). */
  local: LocalSetup | undefined;
  /** Set in local mode: connects the agents on this computer at the press of a button (see src/local-connect.ts). */
  connector: LocalConnector | undefined;
  /** Sends sign-in codes and security notices. */
  mailer: Mailer;
  /** Names and addresses that go into emails. */
  brand: Brand;
  /** The passkey relying party: this server's host name and origin. */
  rp: RelyingParty;
}

export type Env = { Variables: { userId: string; actor: string } };

export function mcpUrl(config: Config): string {
  return `${config.mcpOrigin}/mcp`;
}

export function resourceMetadataUrl(config: Config): string {
  return `${config.mcpOrigin}/.well-known/oauth-protected-resource/mcp`;
}
