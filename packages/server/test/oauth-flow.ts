import { createHash, randomBytes } from "node:crypto";
import { BASE, csrfFrom, type TestApp } from "./helpers.js";

export interface Granted {
  clientId: string;
  access: string;
  refresh: string;
  body: Record<string, unknown>;
}

/** Registers a public client and runs authorize, consent and token for the signed-in cookie. */
export async function grant(t: TestApp, cookie: string, name = "Tester", redirect = "http://127.0.0.1:33418/callback"): Promise<Granted> {
  const reg = await t.fetch("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: "none", client_name: name }),
  });
  const client = (await reg.json()) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const params = {
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${BASE}/mcp`,
    scope: "anywhere",
    state: "s",
  };
  const page = await t.fetch(`/oauth/authorize?${new URLSearchParams(params)}`, { headers: { cookie } });
  const res = await t.fetch("/oauth/authorize", {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: BASE },
    body: new URLSearchParams({ ...params, _csrf: csrfFrom(await page.text()), decision: "approve" }).toString(),
    redirect: "manual",
  });
  const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
  const tok = await tokenRequest(t, {
    grant_type: "authorization_code",
    code,
    client_id: client.client_id,
    redirect_uri: redirect,
    code_verifier: verifier,
    resource: `${BASE}/mcp`,
  });
  const body = (await tok.json()) as Record<string, unknown>;
  return { clientId: client.client_id, access: body.access_token as string, refresh: body.refresh_token as string, body };
}

export function tokenRequest(t: TestApp, form: Record<string, string>, path = "/oauth/token"): Promise<Response> {
  return t.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
}

export async function mcpStatus(t: TestApp, token: string): Promise<number> {
  const res = await t.fetch("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
  return res.status;
}
