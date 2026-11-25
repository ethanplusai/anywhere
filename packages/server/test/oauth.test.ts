/* eslint-disable @typescript-eslint/no-explicit-any -- tests read loosely typed JSON bodies */
import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPrivateAddress, redirectUriMatches } from "../src/oauth/clients.js";
import { mcpStatus } from "./oauth-flow.js";
import { BASE, csrfFrom, makeTestApp, signIn, type TestApp } from "./helpers.js";

const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";

let t: TestApp;
let cookie: string;
beforeEach(async () => {
  t = await makeTestApp();
  cookie = await signIn(t);
});
afterEach(async () => {
  await t.close();
});

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function register(body: Record<string, unknown>) {
  const res = await t.fetch("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { res, body: (await res.json()) as Record<string, any> };
}

function authorizeUrl(params: Record<string, string>) {
  return `/oauth/authorize?${new URLSearchParams({ response_type: "code", state: "xyz", ...params })}`;
}

/** Plays the browser: opens the consent page with the session cookie and presses Approve (or Deny). */
async function consent(url: string, decision: "approve" | "deny" = "approve", sessionCookie = cookie) {
  const page = await t.fetch(url, { headers: { cookie: sessionCookie }, redirect: "manual" });
  expect(page.status).toBe(200);
  const htmlText = await page.text();
  const params = Object.fromEntries(new URL(url, BASE).searchParams);
  const res = await t.fetch("/oauth/authorize", {
    method: "POST",
    headers: { cookie: sessionCookie, "content-type": "application/x-www-form-urlencoded", origin: BASE },
    body: new URLSearchParams({ ...params, _csrf: csrfFrom(htmlText), decision }).toString(),
    redirect: "manual",
  });
  return { htmlText, res, location: new URL(res.headers.get("location") ?? "about:blank") };
}

async function token(form: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await t.fetch("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(form).toString(),
  });
  return { res, body: (await res.json()) as Record<string, any> };
}

/** Registers a public client and runs authorize + token. */
async function fullGrant(redirect = "http://127.0.0.1:33418/callback") {
  const { body: client } = await register({ redirect_uris: [redirect], token_endpoint_auth_method: "none", client_name: "Tester" });
  const { verifier, challenge } = pkce();
  const { location } = await consent(
    authorizeUrl({
      client_id: client.client_id,
      redirect_uri: redirect,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: `${BASE}/mcp`,
    }),
  );
  const code = location.searchParams.get("code")!;
  const tok = await token({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirect,
    client_id: client.client_id,
    code_verifier: verifier,
    resource: `${BASE}/mcp`,
  });
  return { client, code, verifier, tok };
}

describe("discovery", () => {
  it("serves RFC 9728 protected-resource metadata whose resource is the MCP URL", async () => {
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
      const res = await t.fetch(path);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.resource).toBe(`${BASE}/mcp`);
      expect(body.authorization_servers).toEqual([BASE]);
      expect(body.bearer_methods_supported).toEqual(["header"]);
    }
  });

  it("serves RFC 8414 authorization-server metadata", async () => {
    const res = await t.fetch("/.well-known/oauth-authorization-server");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      issuer: BASE,
      authorization_endpoint: `${BASE}/oauth/authorize`,
      token_endpoint: `${BASE}/oauth/token`,
      registration_endpoint: `${BASE}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
    });
    expect(body.token_endpoint_auth_methods_supported).toContain("none");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("dynamic client registration", () => {
  it("registers Claude's hosted callback as a public client", async () => {
    const { res, body } = await register({
      client_name: "Claude",
      redirect_uris: [CLAUDE_CALLBACK],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    expect(res.status).toBe(201);
    expect(body.client_id).toEqual(expect.any(String));
    expect(body.redirect_uris).toEqual([CLAUDE_CALLBACK]);
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body.client_secret).toBeUndefined();
  });

  it("issues a secret to confidential clients and checks it at the token endpoint", async () => {
    const redirect = "https://app.example/cb";
    const { body: client } = await register({ redirect_uris: [redirect], token_endpoint_auth_method: "client_secret_basic" });
    expect(client.client_secret).toEqual(expect.any(String));
    const { verifier, challenge } = pkce();
    const { location } = await consent(
      authorizeUrl({ client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256" }),
    );
    const form = { grant_type: "authorization_code", code: location.searchParams.get("code")!, redirect_uri: redirect, code_verifier: verifier };
    const bad = await token(form, { authorization: `Basic ${Buffer.from(`${client.client_id}:wrong`).toString("base64")}` });
    expect(bad.res.status).toBe(401);
    expect(bad.body.error).toBe("invalid_client");
    const good = await token(form, {
      authorization: `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString("base64")}`,
    });
    expect(good.res.status).toBe(200);
  });

  it("refuses unsafe or missing redirect URIs", async () => {
    expect((await register({ redirect_uris: [] })).res.status).toBe(400);
    expect((await register({ redirect_uris: ["http://evil.example/cb"] })).body.error).toBe("invalid_redirect_uri");
    expect((await register({ redirect_uris: ["javascript:alert(1)"] })).body.error).toBe("invalid_redirect_uri");
    expect((await register({ redirect_uris: ["https://ok.example/cb#frag"] })).body.error).toBe("invalid_redirect_uri");
    expect((await register({ redirect_uris: ["http://localhost:8080/cb"], token_endpoint_auth_method: "private_key_jwt" })).body.error).toBe(
      "invalid_client_metadata",
    );
  });
});

describe("authorization endpoint", () => {
  it("sends a signed-out user to sign in and back", async () => {
    const { body: client } = await register({ redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "none" });
    const url = authorizeUrl({ client_id: client.client_id, redirect_uri: CLAUDE_CALLBACK, code_challenge: pkce().challenge, code_challenge_method: "S256" });
    const res = await t.fetch(url, { redirect: "manual" });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!, BASE);
    expect(loc.pathname).toBe("/signin");
    expect(loc.searchParams.get("next")).toBe(url);
  });

  it("shows a consent page naming the client and redirects with code, state and iss on approval", async () => {
    const { body: client } = await register({ redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "none", client_name: "Claude <b>" });
    const { htmlText, res, location } = await consent(
      authorizeUrl({ client_id: client.client_id, redirect_uri: CLAUDE_CALLBACK, code_challenge: pkce().challenge, code_challenge_method: "S256" }),
    );
    expect(htmlText).toContain("Claude &lt;b&gt;");
    expect(htmlText).toContain("claude.ai");
    expect(res.status).toBe(302);
    expect(location.origin + location.pathname).toBe(CLAUDE_CALLBACK);
    expect(location.searchParams.get("code")).toEqual(expect.any(String));
    expect(location.searchParams.get("state")).toBe("xyz");
    expect(location.searchParams.get("iss")).toBe(BASE);
  });

  it("redirects access_denied when the user denies", async () => {
    const { body: client } = await register({ redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "none" });
    const { location } = await consent(
      authorizeUrl({ client_id: client.client_id, redirect_uri: CLAUDE_CALLBACK, code_challenge: pkce().challenge, code_challenge_method: "S256" }),
      "deny",
    );
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("code")).toBeNull();
  });

  it("requires PKCE with S256, showing the error rather than redirecting before the person acts", async () => {
    const { body: client } = await register({ redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "none" });
    for (const extra of [{}, { code_challenge: "abc", code_challenge_method: "plain" }]) {
      const res = await t.fetch(authorizeUrl({ client_id: client.client_id, redirect_uri: CLAUDE_CALLBACK, ...extra }), {
        headers: { cookie },
        redirect: "manual",
      });
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
      expect(await res.text()).toContain("invalid_request");
    }
  });

  it("cannot be used as an open redirector by a freshly registered client", async () => {
    const { body: client } = await register({ redirect_uris: ["https://evil.example/cb"], token_endpoint_auth_method: "none" });
    for (const headers of [{}, { cookie }]) {
      const res = await t.fetch(authorizeUrl({ client_id: client.client_id, redirect_uri: "https://evil.example/cb", response_type: "bogus" }), {
        headers,
        redirect: "manual",
      });
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
    }
  });

  it("redirects request errors to the client only after the person submits the consent form", async () => {
    const { body: client } = await register({ redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "none" });
    const okUrl = authorizeUrl({ client_id: client.client_id, redirect_uri: CLAUDE_CALLBACK, code_challenge: pkce().challenge, code_challenge_method: "S256" });
    const page = await (await t.fetch(okUrl, { headers: { cookie } })).text();
    const res = await t.fetch("/oauth/authorize", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: client.client_id, redirect_uri: CLAUDE_CALLBACK, response_type: "code", state: "s", _csrf: csrfFrom(page), decision: "approve" }).toString(),
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(CLAUDE_CALLBACK);
    expect(loc.searchParams.get("error")).toBe("invalid_request");
    expect(loc.searchParams.get("state")).toBe("s");
  });

  it("never redirects to an unregistered redirect URI, and refuses a foreign resource", async () => {
    const { body: client } = await register({ redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "none" });
    const res = await t.fetch(
      authorizeUrl({ client_id: client.client_id, redirect_uri: "https://evil.example/cb", code_challenge: pkce().challenge, code_challenge_method: "S256" }),
      { headers: { cookie }, redirect: "manual" },
    );
    expect(res.status).toBe(400);
    const unknown = await t.fetch(authorizeUrl({ client_id: "nope", redirect_uri: CLAUDE_CALLBACK }), { headers: { cookie }, redirect: "manual" });
    expect(unknown.status).toBe(400);
    const foreign = await t.fetch(
      authorizeUrl({
        client_id: client.client_id,
        redirect_uri: CLAUDE_CALLBACK,
        code_challenge: pkce().challenge,
        code_challenge_method: "S256",
        resource: "https://other.example/mcp",
      }),
      { headers: { cookie }, redirect: "manual" },
    );
    expect(foreign.status).toBe(400);
    expect(await foreign.text()).toContain("invalid_target");
  });

  it("refuses an approval without the CSRF token", async () => {
    const { body: client } = await register({ redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "none" });
    const res = await t.fetch("/oauth/authorize", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: CLAUDE_CALLBACK,
        code_challenge: pkce().challenge,
        code_challenge_method: "S256",
        decision: "approve",
      }).toString(),
      redirect: "manual",
    });
    expect(res.status).toBe(403);
  });

  it("matches loopback redirects ignoring the port, and nothing else", async () => {
    expect(redirectUriMatches(["http://127.0.0.1:3000/cb"], "http://127.0.0.1:51234/cb")).toBe(true);
    expect(redirectUriMatches(["http://127.0.0.1/cb"], "http://127.0.0.1:51234/cb")).toBe(true);
    expect(redirectUriMatches(["http://localhost:3000/cb"], "http://localhost:9/cb")).toBe(true);
    expect(redirectUriMatches(["http://[::1]:3000/cb"], "http://[::1]:4000/cb")).toBe(true);
    expect(redirectUriMatches(["http://127.0.0.1:3000/cb"], "http://127.0.0.1:51234/other")).toBe(false);
    expect(redirectUriMatches(["http://127.0.0.1:3000/cb"], "http://localhost:3000/cb")).toBe(false);
    expect(redirectUriMatches(["http://127.0.0.1:3000/cb"], "http://evil.example/cb")).toBe(false);
    expect(redirectUriMatches(["https://app.example:443/cb"], "https://app.example:8443/cb")).toBe(false);
    expect(redirectUriMatches([CLAUDE_CALLBACK], CLAUDE_CALLBACK)).toBe(true);
    expect(redirectUriMatches([CLAUDE_CALLBACK], CLAUDE_CALLBACK + "?x=1")).toBe(false);

    // And through the real endpoint.
    const { body: client } = await register({ redirect_uris: ["http://127.0.0.1:3000/cb"], token_endpoint_auth_method: "none" });
    const { location } = await consent(
      authorizeUrl({ client_id: client.client_id, redirect_uri: "http://127.0.0.1:51234/cb", code_challenge: pkce().challenge, code_challenge_method: "S256" }),
    );
    expect(location.origin).toBe("http://127.0.0.1:51234");
    expect(location.searchParams.get("code")).toBeTruthy();
  });
});

describe("token endpoint", () => {
  it("exchanges a code once, with the right verifier, for bearer tokens", async () => {
    const { tok, client, code, verifier } = await fullGrant();
    expect(tok.res.status).toBe(200);
    expect(tok.res.headers.get("cache-control")).toBe("no-store");
    expect(tok.body).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    expect(tok.body.access_token).toEqual(expect.any(String));
    expect(tok.body.refresh_token).toEqual(expect.any(String));

    const replay = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: "http://127.0.0.1:33418/callback",
      client_id: client.client_id,
      code_verifier: verifier,
    });
    expect(replay.body.error).toBe("invalid_grant");
    // Replaying a code revokes what it issued.
    expect((await t.api("GET", "/me", undefined, tok.body.access_token)).status).toBe(401);
  });

  it("refuses a wrong verifier and a mismatched redirect URI", async () => {
    const redirect = "http://127.0.0.1:1/cb";
    const { body: client } = await register({ redirect_uris: [redirect], token_endpoint_auth_method: "none" });
    for (const tamper of ["verifier", "redirect"] as const) {
      const { verifier, challenge } = pkce();
      const { location } = await consent(
        authorizeUrl({ client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256" }),
      );
      const res = await token({
        grant_type: "authorization_code",
        code: location.searchParams.get("code")!,
        client_id: client.client_id,
        redirect_uri: tamper === "redirect" ? "http://127.0.0.1:1/other" : redirect,
        code_verifier: tamper === "verifier" ? pkce().verifier : verifier,
      });
      expect(res.body.error).toBe("invalid_grant");
    }
  });

  it("accepts the issuer as resource at both steps, and an omitted redirect_uri at both steps", async () => {
    const redirect = "https://only.example/cb";
    const { body: client } = await register({ redirect_uris: [redirect], token_endpoint_auth_method: "none" });
    const { verifier, challenge } = pkce();
    const { location } = await consent(
      authorizeUrl({ client_id: client.client_id, code_challenge: challenge, code_challenge_method: "S256", resource: BASE }),
    );
    expect(location.origin + location.pathname).toBe(redirect);
    const res = await token({
      grant_type: "authorization_code",
      code: location.searchParams.get("code")!,
      client_id: client.client_id,
      code_verifier: verifier,
      resource: BASE,
    });
    expect(res.res.status).toBe(200);
  });

  it("accepts only form-encoded bodies", async () => {
    const res = await t.fetch("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
    expect((await token({ grant_type: "password" })).body.error).toBe("unsupported_grant_type");
  });

  it("rotates refresh tokens and kills the family when an old one is replayed", async () => {
    const { tok, client } = await fullGrant();
    const first = await token({ grant_type: "refresh_token", refresh_token: tok.body.refresh_token, client_id: client.client_id });
    expect(first.res.status).toBe(200);
    expect(first.body.refresh_token).not.toBe(tok.body.refresh_token);
    expect(await mcpStatus(t, first.body.access_token)).toBe(200);

    const replay = await token({ grant_type: "refresh_token", refresh_token: tok.body.refresh_token, client_id: client.client_id });
    expect(replay.body.error).toBe("invalid_grant");
    // The whole family is revoked: the newest tokens stop working too.
    expect(await mcpStatus(t, first.body.access_token)).toBe(401);
    const next = await token({ grant_type: "refresh_token", refresh_token: first.body.refresh_token, client_id: client.client_id });
    expect(next.body.error).toBe("invalid_grant");
  });

  it("refuses a refresh token presented by another client", async () => {
    const { tok } = await fullGrant();
    const { body: other } = await register({ redirect_uris: ["http://127.0.0.1/x"], token_endpoint_auth_method: "none" });
    const res = await token({ grant_type: "refresh_token", refresh_token: tok.body.refresh_token, client_id: other.client_id });
    expect(res.body.error).toBe("invalid_grant");
  });

  it("refuses OAuth access tokens on /api/v1, which takes personal access tokens only", async () => {
    const { tok } = await fullGrant();
    const me = await t.api("GET", "/me", undefined, tok.body.access_token);
    expect(me.status).toBe(401);
  });
});

describe("unauthenticated endpoints", () => {
  it("cap request bodies, including chunked ones without a Content-Length", async () => {
    const big = "x".repeat(200 * 1024);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ redirect_uris: ["https://a.example/cb"], client_name: big })));
        controller.close();
      },
    });
    const res = await t.fetch("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half", // Node's fetch needs this for a streamed body
    } as RequestInit);
    expect(res.status).toBe(413);
    const signin = await t.fetch("/signin", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "email=" + big,
    });
    expect(signin.status).toBe(413);
  });
});

describe("client ID metadata documents", () => {
  const CIMD_URL = "https://client.example/oauth/metadata.json";

  async function withCimd(doc: unknown) {
    const served: string[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      served.push(String(input));
      return new Response(JSON.stringify(doc), { headers: { "content-type": "application/json" } });
    };
    const app = await makeTestApp({ ANYWHERE_ALLOW_PRIVATE_CIMD: "1" }, { fetch: fakeFetch });
    return { app, served };
  }

  it("accepts a URL client_id whose document lists the redirect URI", async () => {
    const { app, served } = await withCimd({
      client_id: CIMD_URL,
      client_name: "Example Agent",
      redirect_uris: ["http://127.0.0.1/callback"],
      token_endpoint_auth_method: "none",
    });
    try {
      const sessionCookie = await signIn(app);
      const { verifier, challenge } = pkce();
      const url = authorizeUrl({ client_id: CIMD_URL, redirect_uri: "http://127.0.0.1:4444/callback", code_challenge: challenge, code_challenge_method: "S256" });
      const page = await app.fetch(url, { headers: { cookie: sessionCookie } });
      const htmlText = await page.text();
      expect(htmlText).toContain("Example Agent");
      expect(htmlText).toContain("client.example");
      const res = await app.fetch("/oauth/authorize", {
        method: "POST",
        headers: { cookie: sessionCookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...Object.fromEntries(new URL(url, BASE).searchParams), _csrf: csrfFrom(htmlText), decision: "approve" }).toString(),
        redirect: "manual",
      });
      const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
      const tok = await app.fetch("/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: CIMD_URL,
          redirect_uri: "http://127.0.0.1:4444/callback",
          code_verifier: verifier,
        }).toString(),
      });
      expect(tok.status).toBe(200);
      // Cached: fetched once for the consent page and reused afterwards.
      expect(served.length).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("refuses a document whose client_id does not match its URL", async () => {
    const { app } = await withCimd({ client_id: "https://someone-else.example/meta", redirect_uris: ["http://127.0.0.1/callback"] });
    try {
      const sessionCookie = await signIn(app);
      const res = await app.fetch(
        authorizeUrl({ client_id: CIMD_URL, redirect_uri: "http://127.0.0.1/callback", code_challenge: pkce().challenge, code_challenge_method: "S256" }),
        { headers: { cookie: sessionCookie }, redirect: "manual" },
      );
      expect(res.status).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("refuses metadata URLs on private addresses unless allowed", async () => {
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("10.1.2.3")).toBe(true);
    expect(isPrivateAddress("192.168.0.4")).toBe(true);
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("fd00::1")).toBe(true);
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:7f00:1")).toBe(true);
    expect(isPrivateAddress("::ffff:a00:1")).toBe(true);
    expect(isPrivateAddress("64:ff9b::7f00:1")).toBe(true);
    expect(isPrivateAddress("198.18.0.1")).toBe(true);
    expect(isPrivateAddress("192.0.0.8")).toBe(true);
    expect(isPrivateAddress("2606:4700::1111")).toBe(false);
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
    const res = await t.fetch(
      authorizeUrl({ client_id: "https://127.0.0.1/meta.json", redirect_uri: "http://127.0.0.1/cb", code_challenge: pkce().challenge, code_challenge_method: "S256" }),
      { headers: { cookie }, redirect: "manual" },
    );
    expect(res.status).toBe(400);
  });
});

describe("end to end with the MCP SDK's own OAuth client", () => {
  class TestProvider implements OAuthClientProvider {
    info: OAuthClientInformationMixed | undefined;
    saved: OAuthTokens | undefined;
    verifier = "";
    authorizationUrl: URL | undefined;
    get redirectUrl() {
      return "http://127.0.0.1:9876/callback";
    }
    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: "SDK test client",
        redirect_uris: [this.redirectUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      };
    }
    clientInformation() {
      return this.info;
    }
    saveClientInformation(info: OAuthClientInformationMixed) {
      this.info = info;
    }
    tokens() {
      return this.saved;
    }
    saveTokens(tokens: OAuthTokens) {
      this.saved = tokens;
    }
    redirectToAuthorization(url: URL) {
      this.authorizationUrl = url;
    }
    saveCodeVerifier(v: string) {
      this.verifier = v;
    }
    codeVerifier() {
      return this.verifier;
    }
  }

  it("discovers, registers, authorizes with PKCE, gets tokens, calls a tool and refreshes", async () => {
    const provider = new TestProvider();
    const sdkFetch = (url: string | URL, init?: RequestInit) => t.fetch(String(url), init);
    const makeTransport = () =>
      new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { authProvider: provider, fetch: sdkFetch });

    // 1. Unauthenticated connect: 401 -> discovery -> DCR -> redirect to authorize.
    const first = new Client({ name: "sdk", version: "1" });
    const transport = makeTransport();
    await expect(first.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(provider.info?.client_id).toEqual(expect.any(String));
    const authUrl = provider.authorizationUrl!;
    expect(authUrl.origin + authUrl.pathname).toBe(`${BASE}/oauth/authorize`);
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("resource")).toBe(`${BASE}/mcp`);

    // 2. The person signs in and approves.
    const { location } = await consent(authUrl.pathname + authUrl.search);
    expect(location.origin).toBe("http://127.0.0.1:9876");
    await transport.finishAuth(location.searchParams.get("code")!);
    expect(provider.saved?.access_token).toEqual(expect.any(String));

    // 3. Authenticated MCP call.
    const client = new Client({ name: "sdk", version: "1" });
    await client.connect(makeTransport());
    const created = await client.callTool({ name: "create_project", arguments: { name: "Via OAuth" } });
    expect(created.isError).toBeFalsy();
    await client.close();

    // 4. With the access token gone bad, the SDK refreshes with its refresh token and carries on.
    const oldRefresh = provider.saved!.refresh_token;
    provider.saved = { ...provider.saved!, access_token: "expired-or-revoked" };
    const again = new Client({ name: "sdk", version: "1" });
    await again.connect(makeTransport());
    const list = await again.callTool({ name: "list_projects", arguments: {} });
    expect(JSON.stringify(list.content)).toContain("via-oauth");
    expect(provider.saved.refresh_token).not.toBe(oldRefresh);
    await again.close();
  });
});
