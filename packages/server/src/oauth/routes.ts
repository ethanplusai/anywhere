import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { html } from "hono/html";
import { mcpUrl, type Deps } from "../deps.js";
import { clientIp, ipKey } from "../http.js";
import { icon, layout, logo, mark } from "../web/render.js";
import { csrfOk, sessionMiddleware, type WebEnv } from "../web/session.js";
import { notify } from "../web/notify.js";

function appHost(uri: string): string {
  try {
    return new URL(uri).host || "an app";
  } catch {
    return "an app";
  }
}
import {
  OAuthError,
  authenticateClient,
  checkClientMetadata,
  getClient,
  redirectUriMatches,
  registerClient,
  type ClientLookupOptions,
  type OAuthClient,
} from "./clients.js";
import { createCode, exchangeCode, refresh, revokeToken } from "./grants.js";

const SCOPE = "anywhere";
const AUTH_PARAMS = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope", "resource"] as const;
type AuthParams = Partial<Record<(typeof AUTH_PARAMS)[number], string>>;

/** A failure that must not be sent to the redirect URI (unknown client or unregistered redirect). */
class FatalAuthorizeError extends Error {}
/** A failure reported to the client through its redirect URI. */
class RedirectAuthorizeError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
  ) {
    super(description);
  }
}

interface ValidRequest {
  client: OAuthClient;
  redirectUri: string;
  codeChallenge: string;
  state: string | undefined;
  resource: string;
  scope: string | null;
}

function noStore(c: Context) {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  // The consent page must never be framed (clickjacking). No form-action here: the approval
  // redirects to the client's own URI, which may be a private-use scheme.
  c.header("X-Frame-Options", "DENY");
  c.header("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'");
}

export function oauthRoutes(deps: Deps): Hono<WebEnv> {
  const { db, config } = deps;
  /** Metadata-document fetches are limited per address and server-wide (audit A5). */
  const lookupFor = (c: Context): ClientLookupOptions => ({
    fetch: deps.fetch,
    allowPrivate: config.allowPrivateCimd,
    beforeFetch: async () => {
      const wait =
        (await deps.limiter.hit(`cimd:${ipKey(clientIp(c, config))}`, { limit: config.authRateLimit, windowS: 60 })) ??
        (await deps.limiter.hit("cimd:all", { limit: config.cimdFetchesPerMinute, windowS: 60 }));
      if (wait !== null) throw new OAuthError("temporarily_unavailable", `Too many client lookups. Try again in ${wait} seconds.`, 429);
    },
  });
  const issuer = config.baseUrl;
  const resource = mcpUrl(config);
  /** The MCP URL, the issuer and the issuer with a slash all name the one protected resource. */
  const normaliseResource = (r: string | null): string | null =>
    r === null ? null : [resource, issuer, `${issuer}/`, config.mcpOrigin, `${config.mcpOrigin}/`].includes(r) ? resource : r;
  const app = new Hono<WebEnv>();

  // Browser-based MCP clients read metadata and call the token and registration endpoints cross-origin.
  const openCors = cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type", "MCP-Protocol-Version"], maxAge: 86400 });
  app.use("/.well-known/*", openCors);
  app.use("/oauth/token", openCors);
  app.use("/oauth/register", openCors);
  app.use("/oauth/revoke", openCors);

  const protectedResource = {
    resource,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: [SCOPE],
    resource_name: "Anywhere",
    resource_documentation: `${issuer}/connect`,
  };
  app.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(protectedResource));
  app.get("/.well-known/oauth-protected-resource", (c) => c.json(protectedResource));

  app.get("/.well-known/oauth-authorization-server", (c) =>
    c.json({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      revocation_endpoint: `${issuer}/oauth/revoke`,
      revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      scopes_supported: [SCOPE],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      service_documentation: `${issuer}/connect`,
    }),
  );

  app.post("/oauth/register", async (c) => {
    noStore(c);
    // Per address first, by the minute and by the hour, so one address cannot spend the allowance
    // the whole server shares; that one is only counted for a registration that is well formed.
    const address = ipKey(clientIp(c, config));
    const slowDown = (wait: number) =>
      c.json({ error: "slow_down", error_description: "Too many registrations." }, 429, { "Retry-After": String(wait) });
    const mine =
      (await deps.limiter.hit(`register:${address}`, { limit: config.authRateLimit, windowS: 60 })) ??
      (await deps.limiter.hit(`register-hour:${address}`, { limit: config.registrationsPerAddressPerHour, windowS: 3600 }));
    if (mine !== null) return slowDown(mine);
    let meta: unknown;
    try {
      meta = await c.req.json();
    } catch {
      return c.json({ error: "invalid_client_metadata", error_description: "Send the client metadata as a JSON object." }, 400);
    }
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
      return c.json({ error: "invalid_client_metadata", error_description: "Send the client metadata as a JSON object." }, 400);
    }
    try {
      checkClientMetadata(meta as Record<string, unknown>);
      const all = await deps.limiter.hit("register:all", { limit: config.registrationsPerHour, windowS: 3600 });
      if (all !== null) return slowDown(all);
      return c.json(await registerClient(db, meta as Record<string, unknown>), 201);
    } catch (err) {
      if (err instanceof OAuthError) return c.json({ error: err.error, error_description: err.description }, 400);
      throw err;
    }
  });

  async function validate(p: AuthParams, lookup: ClientLookupOptions): Promise<ValidRequest> {
    if (!p.client_id) throw new FatalAuthorizeError("The request has no client_id.");
    let client: OAuthClient;
    try {
      client = await getClient(db, p.client_id, lookup);
    } catch (err) {
      if (err instanceof OAuthError) throw new FatalAuthorizeError(err.description);
      throw err;
    }
    let redirectUri = p.redirect_uri;
    if (!redirectUri) {
      if (client.redirectUris.length !== 1) throw new FatalAuthorizeError("The request has no redirect_uri.");
      redirectUri = client.redirectUris[0]!;
    }
    if (!redirectUriMatches(client.redirectUris, redirectUri)) {
      throw new FatalAuthorizeError("The redirect_uri is not registered for this client.");
    }
    if (p.response_type !== "code") throw new RedirectAuthorizeError("unsupported_response_type", 'Only response_type "code" is supported.');
    if (!p.code_challenge || p.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(p.code_challenge)) {
      throw new RedirectAuthorizeError("invalid_request", "PKCE with code_challenge_method S256 is required.");
    }
    if (p.resource && normaliseResource(p.resource) !== resource) {
      throw new RedirectAuthorizeError("invalid_target", `This server only issues tokens for ${resource}.`);
    }
    const scopes = (p.scope ?? "").split(" ").filter(Boolean);
    return {
      client,
      redirectUri,
      codeChallenge: p.code_challenge,
      state: p.state,
      resource,
      scope: scopes.includes(SCOPE) ? SCOPE : null,
    };
  }

  function redirectWith(c: Context, redirectUri: string, params: Record<string, string | undefined>) {
    const url = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
    url.searchParams.set("iss", issuer);
    return c.redirect(url.toString(), 302);
  }

  function errorPage(c: Context<WebEnv>, message: string, status: 400 | 403) {
    const body = html`<div class="auth-box">
      ${mark(44)}
      <h1>That sign-in link did not work</h1>
      <p class="lead">Go back to the app you came from and connect again.</p>
      <div class="error" role="alert">${icon("alert")}<div>${message}</div></div>
    </div>`;
    return c.html(layout("Sign-in problem", body, { user: c.get("user"), csrf: c.get("csrf"), path: c.req.path, kind: "auth", siteUrl: config.siteUrl }), status);
  }

  /**
   * `redirectErrors` is false for the GET: anyone can register a client, so redirecting an invalid
   * request with no user step would make this an open redirector (RFC 9700 section 4.11.2). Those
   * errors are shown here instead; only the consent POST, after the person acted, redirects.
   */
  async function handle(
    c: Context<WebEnv>,
    p: AuthParams,
    redirectErrors: boolean,
    onValid: (v: ValidRequest) => Promise<Response> | Response,
  ) {
    let v: ValidRequest;
    const lookup = lookupFor(c);
    try {
      v = await validate(p, lookup);
    } catch (err) {
      if (err instanceof FatalAuthorizeError) return errorPage(c, err.message, 400);
      if (err instanceof RedirectAuthorizeError && !redirectErrors) {
        return errorPage(c, `${err.description} (${err.error})`, 400);
      }
      if (err instanceof RedirectAuthorizeError) {
        // Validation passed the redirect checks before throwing this, so the redirect is safe.
        const client = await getClient(db, p.client_id!, lookup);
        const redirectUri = p.redirect_uri ?? client.redirectUris[0]!;
        return redirectWith(c, redirectUri, { error: err.error, error_description: err.description, state: p.state });
      }
      throw err;
    }
    return onValid(v);
  }

  app.use("/oauth/authorize", sessionMiddleware(db, config));

  app.get("/oauth/authorize", async (c) => {
    noStore(c);
    const p: AuthParams = {};
    for (const k of AUTH_PARAMS) {
      const v = c.req.query(k);
      if (v !== undefined) p[k] = v;
    }
    return handle(c, p, false, (v) => {
      const user = c.get("user");
      if (!user) {
        const next = new URL(c.req.url);
        return c.redirect(`/signin?next=${encodeURIComponent(next.pathname + next.search)}`, 302);
      }
      return c.html(consentPage(c, v, p, config.verifiedRedirects, config.siteUrl));
    });
  });

  app.post("/oauth/authorize", async (c) => {
    noStore(c);
    const form = await c.req.parseBody();
    const field = (k: string) => (typeof form[k] === "string" ? (form[k] as string) : undefined);
    const user = c.get("user");
    if (!user) return errorPage(c, "You are signed out. Start again from the app.", 403);
    if (!csrfOk(c, form._csrf)) return errorPage(c, "This form expired. Start again from the app.", 403);
    const p: AuthParams = {};
    for (const k of AUTH_PARAMS) {
      const v = field(k);
      if (v !== undefined) p[k] = v;
    }
    return handle(c, p, true, async (v) => {
      if (field("decision") !== "approve") {
        return redirectWith(c, v.redirectUri, { error: "access_denied", error_description: "The user declined.", state: v.state });
      }
      const code = await createCode(db, {
        clientId: v.client.clientId,
        userId: user.id,
        redirectUri: v.redirectUri,
        redirectUriSupplied: p.redirect_uri !== undefined,
        codeChallenge: v.codeChallenge,
        resource: v.resource,
        scope: v.scope,
      });
      await notify(deps, c, user, "app_connected", (v.client.clientName ?? "").slice(0, 80) || appHost(v.redirectUri));
      return redirectWith(c, v.redirectUri, { code, state: v.state });
    });
  });

  app.post("/oauth/token", async (c) => {
    noStore(c);
    const fail = (err: OAuthError) =>
      c.json({ error: err.error, error_description: err.description }, err.status as 400 | 401 | 429 | 503, {
        "Cache-Control": "no-store",
        ...(err.status === 401 ? { "WWW-Authenticate": 'Basic realm="anywhere"' } : {}),
      });
    const type = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "application/x-www-form-urlencoded") {
      return fail(new OAuthError("invalid_request", "The token endpoint takes application/x-www-form-urlencoded bodies."));
    }
    const form = new URLSearchParams(await c.req.text());
    try {
      const grantType = form.get("grant_type");
      if (grantType !== "authorization_code" && grantType !== "refresh_token") {
        throw new OAuthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
      }
      const client = await authenticateClient(db, form, c.req.header("authorization"), lookupFor(c));
      if (grantType === "authorization_code") {
        const code = form.get("code");
        if (!code) throw new OAuthError("invalid_request", "code is required.");
        return c.json(
          await exchangeCode(db, {
            code,
            clientId: client.clientId,
            redirectUri: form.get("redirect_uri"),
            verifier: form.get("code_verifier"),
            // The same aliases authorize accepts all mean the MCP resource.
            resource: normaliseResource(form.get("resource")),
          }, { grantLifetimeDays: config.grantLifetimeDays }),
        );
      }
      const refreshToken = form.get("refresh_token");
      if (!refreshToken) throw new OAuthError("invalid_request", "refresh_token is required.");
      return c.json(await refresh(db, { refreshToken, clientId: client.clientId }));
    } catch (err) {
      if (err instanceof OAuthError) return fail(err);
      throw err;
    }
  });

  // RFC 7009 token revocation (audit A3). Revoking either token ends the whole grant.
  app.post("/oauth/revoke", async (c) => {
    noStore(c);
    const type = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "application/x-www-form-urlencoded") {
      return c.json({ error: "invalid_request", error_description: "Send an application/x-www-form-urlencoded body." }, 400);
    }
    const form = new URLSearchParams(await c.req.text());
    const token = form.get("token");
    if (!token) return c.json({ error: "invalid_request", error_description: "token is required." }, 400);
    try {
      const client = await authenticateClient(db, form, c.req.header("authorization"), lookupFor(c));
      await revokeToken(db, token, client.clientId);
    } catch (err) {
      if (err instanceof OAuthError) {
        return c.json({ error: err.error, error_description: err.description }, err.status as 400 | 401 | 429 | 503);
      }
      throw err;
    }
    return c.body(null, 200);
  });

  return app;
}

/** Names an unverified client may not use as its heading: they belong to clients people already trust. */
const RESERVED_NAMES = ["claude", "anthropic", "chatgpt", "openai", "cursor", "anywhere", "anywr", "github", "copilot", "vscode", "visualstudio", "windsurf", "gemini", "google", "microsoft", "apple"];

/** Where approval sends the person, written out in full for private-use schemes (audit A4). */
export function describeRedirect(uri: string): { display: string; key: string } {
  const u = new URL(uri);
  if (u.protocol === "https:") return { display: `https://${u.host}`, key: u.hostname.toLowerCase() };
  if (u.protocol === "http:") return { display: `an app on this computer (http://${u.host})`, key: "loopback" };
  const full = uri.length > 120 ? `${uri.slice(0, 117)}...` : uri;
  return { display: full, key: u.protocol.toLowerCase() };
}

function claimsReservedName(name: string): boolean {
  const flat = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return RESERVED_NAMES.some((n) => flat.includes(n));
}

function consentPage(c: Context<WebEnv>, v: ValidRequest, p: AuthParams, verified: Record<string, string>, siteUrl: string) {
  const user = c.get("user")!;
  const target = describeRedirect(v.redirectUri);
  const verifiedName = Object.hasOwn(verified, target.key) ? verified[target.key] : undefined;
  const claimed = v.client.clientName;
  // A verified client is recognised by where the code goes, which an impostor cannot redirect.
  const name = verifiedName ?? (claimed && !claimsReservedName(claimed) ? claimed : null);
  const heading = verifiedName
    ? html`<h1>Connect ${verifiedName} to Anywhere?</h1>`
    : html`<h1>An unverified app at ${target.display} wants to connect to Anywhere</h1>`;
  let nameNote: ReturnType<typeof html> | string = "";
  if (claimed && (!verifiedName || claimed !== verifiedName)) {
    nameNote =
      !verifiedName && claimsReservedName(claimed)
        ? html`<div class="error" role="alert">${icon("alert")}<div>It calls itself “${claimed}”, but it is not the app it names: that app would send you back to its own address, and this one sends you to ${target.display}. Deny unless you are sure.</div></div>`
        : html`<p class="small muted">It calls itself “${claimed}”. Nothing checks that name.</p>`;
  }
  const identity =
    v.client.kind === "cimd"
      ? html`<div>Identified by a document at <strong>${new URL(v.client.clientId).host}</strong>.</div>`
      : verifiedName
        ? html`<div>Verified: approval sends you back to <strong>${target.display}</strong>.</div>`
        : html`<div>Only continue if you just asked this app to connect.</div>`;
  const logoId = verifiedName ? (/claude code/i.test(verifiedName) ? "claudecode" : /claude/i.test(verifiedName) ? "claude" : /chatgpt|openai/i.test(verifiedName) ? "openai" : /codex/i.test(verifiedName) ? "codex" : null) : null;
  const hidden = AUTH_PARAMS.map((k) => (p[k] !== undefined ? html`<input type="hidden" name="${k}" value="${p[k]}" />` : ""));
  const body = html`<div class="auth-box">
    <div class="consent-apps" aria-hidden="true">
      <span class="app">${logoId ? logo(logoId) : (name ?? "?").slice(0, 1).toUpperCase()}</span>
      <span class="link-line"></span>
      <span class="app">${mark(30)}</span>
    </div>
    ${heading}
    <p class="lead">It is asking for access to your Anywhere account.</p>
    <div class="card stack">
      ${nameNote}
      <ul class="perm">
        <li>${icon("read")}<span>Read every page in all of your projects</span></li>
        <li>${icon("write")}<span>Create, change and delete pages and projects</span></li>
      </ul>
      <div class="consent-meta">
        ${identity}
        <div>Signed in as ${user.email}. Disconnect it any time in <a href="/account/apps">Connected apps</a>.</div>
      </div>
      <form method="post" action="/oauth/authorize">
        ${hidden}
        <input type="hidden" name="_csrf" value="${c.get("csrf")}" />
        <div class="consent-buttons">
          <button type="submit" name="decision" value="deny" class="secondary">Deny</button>
          <button type="submit" name="decision" value="approve">Approve</button>
        </div>
      </form>
    </div>
  </div>`;
  return layout("Connect an app", body, { user, csrf: c.get("csrf"), path: c.req.path, kind: "auth", siteUrl });
}
