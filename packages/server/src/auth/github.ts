import { createHash } from "node:crypto";
import { randomToken } from "./crypto.js";

/**
 * Sign in with GitHub through this server's own GitHub OAuth app, so the only addresses a person
 * sees are github.com and this server. The flow is the authorization-code flow with `state` and
 * PKCE. GitHub's token is used once to read the account's id, login and verified primary email, and
 * is never stored.
 */

export interface GithubConfig {
  clientId: string;
  clientSecret: string;
}

export interface GithubAccount {
  id: string;
  login: string;
  /** The primary email, only when GitHub says it is verified. */
  email: string | null;
}

export interface GithubStart {
  state: string;
  verifier: string;
  url: string;
}

export function githubStart(cfg: GithubConfig, redirectUri: string): GithubStart {
  const state = randomToken(24);
  const verifier = randomToken(48);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "read:user user:email");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("allow_signup", "true");
  return { state, verifier, url: url.toString() };
}

export class GithubError extends Error {}

async function getJson(fetchFn: typeof fetch, url: string, init: RequestInit): Promise<unknown> {
  const res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new GithubError(`GitHub answered ${res.status}.`);
  return res.json();
}

/** Trades the code for a token, reads the account, and forgets the token. */
export async function githubAccount(fetchFn: typeof fetch, cfg: GithubConfig, code: string, verifier: string, redirectUri: string): Promise<GithubAccount> {
  const token = (await getJson(fetchFn, "https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code, redirect_uri: redirectUri, code_verifier: verifier }),
  })) as { access_token?: unknown; error?: unknown };
  if (typeof token.access_token !== "string" || !token.access_token) throw new GithubError("GitHub did not approve the sign-in.");
  const headers = { accept: "application/vnd.github+json", authorization: `Bearer ${token.access_token}`, "x-github-api-version": "2022-11-28", "user-agent": "Anywhere" };
  const user = (await getJson(fetchFn, "https://api.github.com/user", { headers })) as { id?: unknown; login?: unknown };
  const emails = (await getJson(fetchFn, "https://api.github.com/user/emails", { headers })) as { email?: unknown; primary?: unknown; verified?: unknown }[];
  if (typeof user.id !== "number" || typeof user.login !== "string") throw new GithubError("GitHub sent an account Anywhere could not read.");
  const primary = Array.isArray(emails) ? emails.find((e) => e.primary === true && e.verified === true && typeof e.email === "string") : undefined;
  return { id: String(user.id), login: user.login.slice(0, 64), email: primary ? String(primary.email) : null };
}
