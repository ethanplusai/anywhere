// Audit 2026-11-23: A4 (consent), A5 (metadata fetches), A6 (registration), A13 (client auth), and
// the suspected DNS-rebinding and private-use-scheme items.
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { purgeExpired } from "../src/db/maintenance.js";
import { fetchMetadataDocument } from "../src/oauth/clients.js";
import { makeTestApp, signIn, type TestApp } from "./helpers.js";

function challenge() {
  return createHash("sha256").update(randomBytes(32).toString("base64url")).digest("base64url");
}

async function register(t: TestApp, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const res = await t.fetch("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { res, body: (await res.json()) as Record<string, string> };
}

async function consentHtml(t: TestApp, cookie: string, clientId: string, redirect: string): Promise<string> {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge: challenge(),
    code_challenge_method: "S256",
  });
  return (await t.fetch(`/oauth/authorize?${q}`, { headers: { cookie } })).text();
}

function h1(html: string): string {
  return /<h1>([\s\S]*?)<\/h1>/.exec(html)![1]!.trim();
}

async function withApp(env: Record<string, string>, fn: (t: TestApp) => Promise<void>, opts: { fetch?: typeof fetch } = {}) {
  const t = await makeTestApp(env, opts);
  try {
    await fn(t);
  } finally {
    await t.close();
  }
}

describe("A4: consent page", () => {
  it("does not let an unverified client lead with a well-known name", () =>
    withApp({}, async (t) => {
      const cookie = await signIn(t);
      const { body } = await register(t, { redirect_uris: ["https://evil.example/cb"], token_endpoint_auth_method: "none", client_name: "Claude" });
      const html = await consentHtml(t, cookie, body.client_id!, "https://evil.example/cb");
      expect(h1(html)).toBe("An unverified app at https://evil.example wants to connect to Anywhere");
      expect(html).toContain("not the app it names");
    }));

  it("names a client verified by its redirect host", () =>
    withApp({}, async (t) => {
      const cookie = await signIn(t);
      const cb = "https://claude.ai/api/mcp/auth_callback";
      const { body } = await register(t, { redirect_uris: [cb], token_endpoint_auth_method: "none", client_name: "Claude" });
      const html = await consentHtml(t, cookie, body.client_id!, cb);
      expect(h1(html)).toBe("Connect Claude to Anywhere?");
      expect(html).toContain("Verified");
    }));

  it("shows an ordinary unverified name as a claim, and private-use redirects in full", () =>
    withApp({}, async (t) => {
      const cookie = await signIn(t);
      const cb = "com.example.notes:/oauth/callback";
      const { body } = await register(t, { redirect_uris: [cb], token_endpoint_auth_method: "none", client_name: "Notes Helper" });
      const html = await consentHtml(t, cookie, body.client_id!, cb);
      expect(h1(html)).toBe("An unverified app at com.example.notes:/oauth/callback wants to connect to Anywhere");
      expect(html).toContain("It calls itself “Notes Helper”");
      expect(html).not.toContain("not the app it names");
    }));
});

describe("suspected: unusual private-use redirect schemes", () => {
  it("accepts only reverse-domain schemes and shows the whole URI, host or not", () =>
    withApp({}, async (t) => {
      const refused = ["javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "vbscript:x", "myapp:/cb", "http://evil.example/cb", "com.example.app:/cb#frag"];
      for (const uri of refused) {
        const { res } = await register(t, { redirect_uris: [uri], token_endpoint_auth_method: "none" });
        expect(res.status, uri).toBe(400);
      }
      const cookie = await signIn(t);
      for (const uri of ["com.example.app:/cb", "x.y://evil.example/cb", "app.test:cb"]) {
        const { res, body } = await register(t, { redirect_uris: [uri], token_endpoint_auth_method: "none" });
        expect(res.status, uri).toBe(201);
        const html = await consentHtml(t, cookie, body.client_id!, uri);
        expect(h1(html), uri).toContain(uri);
      }
    }));
});

describe("A5: Client ID Metadata Document fetches", () => {
  const url = (host: string) => `https://${host}/oauth/meta.json`;

  it("caches failures per host and does not echo the upstream status", async () => {
    let calls = 0;
    const failing: typeof fetch = async () => {
      calls++;
      return new Response("nope", { status: 503 });
    };
    await withApp({ ANYWHERE_ALLOW_PRIVATE_CIMD: "1" }, async (t) => {
      const cookie = await signIn(t);
      const first = await consentHtml(t, cookie, url("down.example"), "http://127.0.0.1/cb");
      expect(first).not.toContain("503");
      await consentHtml(t, cookie, url("down.example"), "http://127.0.0.1/cb");
      await consentHtml(t, cookie, "https://down.example/other.json", "http://127.0.0.1/cb");
      expect(calls).toBe(1);
    }, { fetch: failing });
  });

  it("limits fetches server-wide", async () => {
    let calls = 0;
    const counting: typeof fetch = async () => {
      calls++;
      return new Response("{}", { status: 404 });
    };
    await withApp({ ANYWHERE_ALLOW_PRIVATE_CIMD: "1", ANYWHERE_CIMD_FETCH_LIMIT: "2" }, async (t) => {
      const cookie = await signIn(t);
      for (let i = 0; i < 5; i++) await consentHtml(t, cookie, url(`h${i}.example`), "http://127.0.0.1/cb");
      expect(calls).toBe(2);
    }, { fetch: counting });
  });

  it("shares one in-flight fetch between simultaneous requests for the same document", async () => {
    let calls = 0;
    const doc = { client_id: url("slow.example"), client_name: "Slow", redirect_uris: ["http://127.0.0.1/cb"], token_endpoint_auth_method: "none" };
    const slow: typeof fetch = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 100));
      return new Response(JSON.stringify(doc));
    };
    await withApp({ ANYWHERE_ALLOW_PRIVATE_CIMD: "1" }, async (t) => {
      const cookie = await signIn(t);
      const pages = await Promise.all([1, 2, 3].map(() => consentHtml(t, cookie, doc.client_id, "http://127.0.0.1/cb")));
      for (const p of pages) expect(p).toContain("Slow");
      expect(calls).toBe(1);
    }, { fetch: slow });
  });
});

describe("suspected: DNS rebinding in the metadata fetch", () => {
  it("connects to the address that passed the public check, not a second DNS answer", async () => {
    const answers = [["93.184.216.34"], ["127.0.0.1"]];
    let resolved = 0;
    const resolve = async () => answers[Math.min(resolved++, 1)]!;
    const connectedTo: string[] = [];
    const doc = { client_id: "https://rebind.example/meta.json", redirect_uris: ["http://127.0.0.1/cb"] };
    const request = ((_url: URL, options: { lookup: (h: string, o: object, cb: (e: unknown, a: unknown) => void) => void }, cb: (res: unknown) => void) => {
      const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
      req.destroy = () => {};
      req.end = () => {
        // What the socket would do: ask the lookup function where to connect, both ways Node can ask.
        options.lookup("rebind.example", {}, (_e, address) => connectedTo.push(String(address)));
        options.lookup("rebind.example", { all: true }, (_e, list) => connectedTo.push((list as { address: string }[])[0]!.address));
        const res = Readable.from([Buffer.from(JSON.stringify(doc))]) as Readable & { statusCode: number };
        res.statusCode = 200;
        cb(res);
      };
      return req;
    }) as never;
    const result = await fetchMetadataDocument(doc.client_id, { allowPrivate: false, resolve, request });
    expect(result.client_id).toBe(doc.client_id);
    expect(resolved).toBe(1);
    expect(connectedTo).toEqual(["93.184.216.34", "93.184.216.34"]);
  });

  it("refuses a host with any private address", async () => {
    await expect(
      fetchMetadataDocument("https://mixed.example/meta.json", { allowPrivate: false, resolve: async () => ["93.184.216.34", "10.0.0.1"] }),
    ).rejects.toMatchObject({ error: "invalid_client" });
  });
});

describe("A6: dynamic client registration", () => {
  it("stores only the fields it uses and validates grant_types", () =>
    withApp({}, async (t) => {
      const { res, body } = await register(t, {
        redirect_uris: ["https://ok.example/cb"],
        token_endpoint_auth_method: "none",
        client_name: "Ok",
        logo_uri: "https://tracker.example/pixel.png",
        junk: "x".repeat(2000),
      });
      expect(res.status).toBe(201);
      const [row] = await t.db.query<{ metadata: Record<string, unknown> }>("SELECT metadata FROM oauth_clients WHERE client_id = $1", [body.client_id]);
      expect(Object.keys(row!.metadata).sort()).toEqual(["grant_types", "redirect_uris", "response_types", "token_endpoint_auth_method"]);
      expect((await register(t, { redirect_uris: ["https://ok.example/cb"], grant_types: ["authorization_code", "implicit"] })).res.status).toBe(400);
      expect((await register(t, { redirect_uris: ["https://ok.example/cb"], junk: "y".repeat(9000) })).res.status).toBe(400);
    }));

  it("caps registrations per hour across all addresses", () =>
    withApp({ ANYWHERE_REGISTRATIONS_PER_HOUR: "2", ANYWHERE_TRUST_PROXY: "1" }, async (t) => {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        statuses.push((await register(t, { redirect_uris: ["https://ok.example/cb"] }, { "x-forwarded-for": `203.0.113.${i}` })).res.status);
      }
      expect(statuses).toEqual([201, 201, 429, 429]);
    }));

  it("one address cannot spend the allowance everyone shares, and refused requests do not count toward it", () =>
    withApp(
      { ANYWHERE_REGISTRATIONS_PER_HOUR: "3", ANYWHERE_REGISTRATIONS_PER_ADDRESS_PER_HOUR: "2", ANYWHERE_TRUST_PROXY: "1" },
      async (t) => {
        const from = (n: number) => ({ "x-forwarded-for": `203.0.113.${n}` });
        const good = { redirect_uris: ["https://ok.example/cb"] };
        // One address is stopped at its own cap, having used two of the shared three.
        const one: number[] = [];
        for (let i = 0; i < 4; i++) one.push((await register(t, good, from(1))).res.status);
        expect(one).toEqual([201, 201, 429, 429]);
        // Malformed registrations from other addresses are refused without touching the shared allowance.
        for (let n = 10; n < 16; n++) expect((await register(t, { redirect_uris: "nope" }, from(n))).res.status).toBe(400);
        expect((await register(t, good, from(2))).res.status).toBe(201);
        expect((await register(t, good, from(3))).res.status).toBe(429);
      },
    ));

  it("purges registered clients that never connected after a day, keeping used ones", () =>
    withApp({}, async (t) => {
      const cookie = await signIn(t);
      const { grant } = await import("./oauth-flow.js");
      const used = await grant(t, cookie);
      const { body: unused } = await register(t, { redirect_uris: ["https://ok.example/cb"] });
      await t.db.query("UPDATE oauth_clients SET created_at = now() - interval '2 days'");
      // A purge that requests start now and then may run alongside, so check the outcome, not the count.
      await purgeExpired(t.db);
      const left = await t.db.query<{ client_id: string }>("SELECT client_id FROM oauth_clients");
      expect(left.map((r) => r.client_id)).toEqual([used.clientId]);
      expect(left.map((r) => r.client_id)).not.toContain(unused.client_id);
    }));
});

describe("A13: client authentication at the token endpoint", () => {
  async function tokenWith(t: TestApp, form: Record<string, string>, headers: Record<string, string> = {}) {
    return t.fetch("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(form).toString(),
    });
  }

  it("answers malformed Basic credentials with invalid_client, not a 500", () =>
    withApp({}, async (t) => {
      const res = await tokenWith(t, { grant_type: "refresh_token", refresh_token: "x" }, { authorization: `Basic ${Buffer.from("%E0%A4%A:secret").toString("base64")}` });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_client");
    }));

  it("requires the secret to arrive the way the client registered", () =>
    withApp({}, async (t) => {
      const { body: basic } = await register(t, { redirect_uris: ["https://ok.example/cb"], token_endpoint_auth_method: "client_secret_basic" });
      const { body: post } = await register(t, { redirect_uris: ["https://ok.example/cb"], token_endpoint_auth_method: "client_secret_post" });
      const form = { grant_type: "refresh_token", refresh_token: "awr_unknown" };
      const viaPost = await tokenWith(t, { ...form, client_id: basic.client_id!, client_secret: basic.client_secret! });
      expect(viaPost.status).toBe(401);
      const viaBasic = await tokenWith(t, form, { authorization: `Basic ${Buffer.from(`${post.client_id}:${post.client_secret}`).toString("base64")}` });
      expect(viaBasic.status).toBe(401);
      // The right way gets past client authentication to the grant check.
      const right = await tokenWith(t, { ...form, client_id: post.client_id!, client_secret: post.client_secret! });
      expect(right.status).toBe(400);
      expect(((await right.json()) as { error: string }).error).toBe("invalid_grant");
    }));
});

