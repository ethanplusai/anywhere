import { unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createMailer } from "../src/mail/mailer.js";
import { codeEmail, securityEmail } from "../src/mail/templates.js";
import { BASE, codeFor, cookiesFrom, csrfFrom, makeTestApp, signIn, type TestApp } from "./helpers.js";
import { grant } from "./oauth-flow.js";

/*
 * Passwordless accounts: GitHub sign-in, passkeys, security notices, changing the email address,
 * downloading everything, and how mail is sent.
 */

let t: TestApp;
let open: TestApp | null = null;
afterEach(async () => {
  if (t && t !== open) await t.close();
  open = t;
});

function post(body: Record<string, string>, cookie?: string): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE, ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(body).toString(),
    redirect: "manual",
  };
}
const page = async (path: string, cookie: string) => (await t.fetch(path, { headers: { cookie } })).text();

// ---------- GitHub ----------

const GITHUB = { GITHUB_CLIENT_ID: "Iv1.test", GITHUB_CLIENT_SECRET: "test-secret" };
const GH_TOKEN = "gho_thisTokenMustNeverBeStored0123456789";

function fakeGithub(account: { id: number; login: string; email: string | null; verified?: boolean }) {
  const calls: { url: string; body: string }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, body: typeof init?.body === "string" ? init.body : "" });
    if (url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: GH_TOKEN, token_type: "bearer" });
    if (url === "https://api.github.com/user") return Response.json({ id: account.id, login: account.login });
    if (url === "https://api.github.com/user/emails") {
      return Response.json(account.email ? [{ email: account.email, primary: true, verified: account.verified ?? true }] : []);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

/** Starts the GitHub flow and comes back from github.com with a code, as the browser would. */
async function viaGithub(next = "/projects", cookie = "", link = false) {
  const start = await t.fetch(`/auth/github?next=${encodeURIComponent(next)}${link ? "&link=1" : ""}`, { headers: cookie ? { cookie } : {}, redirect: "manual" });
  expect(start.status).toBe(302);
  const to = new URL(start.headers.get("location")!);
  const jar = cookiesFrom(start, cookie);
  return t.fetch(`/auth/github/callback?code=abc&state=${to.searchParams.get("state")}`, { headers: { cookie: jar }, redirect: "manual" });
}

describe("sign in with GitHub", () => {
  it("sends people to GitHub with state and PKCE, and creates a verified account from GitHub's verified email", async () => {
    const gh = fakeGithub({ id: 4242, login: "octo", email: "octo@example.com" });
    t = await makeTestApp(GITHUB, { fetch: gh.fetchFn });
    const start = await t.fetch("/auth/github?next=/tokens", { redirect: "manual" });
    const to = new URL(start.headers.get("location")!);
    expect(to.origin + to.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(to.searchParams.get("redirect_uri")).toBe(`${BASE}/auth/github/callback`);
    expect(to.searchParams.get("code_challenge_method")).toBe("S256");
    expect(to.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{24,}$/);

    const res = await viaGithub("/tokens");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/tokens");
    const [row] = await t.db.query<{ github_id: string; github_login: string; email_verified_at: Date | null }>(
      "SELECT github_id::text AS github_id, github_login, email_verified_at FROM users WHERE email = 'octo@example.com'",
    );
    expect(row).toMatchObject({ github_id: "4242", github_login: "octo" });
    expect(row!.email_verified_at).not.toBeNull();
    // GitHub's token is used once and never kept.
    expect(gh.calls[0]!.body).toContain("code_verifier");
    expect(JSON.stringify(await t.db.query("SELECT * FROM users"))).not.toContain(GH_TOKEN);
    expect(JSON.stringify(await t.db.query("SELECT * FROM security_events"))).not.toContain(GH_TOKEN);
  });

  it("refuses a callback whose state does not match the browser's", async () => {
    t = await makeTestApp(GITHUB, { fetch: fakeGithub({ id: 1, login: "x", email: "x@example.com" }).fetchFn });
    const res = await t.fetch("/auth/github/callback?code=abc&state=forged", { redirect: "manual" });
    expect(res.status).toBe(400);
    expect(res.headers.getSetCookie().some((c) => c.includes("anywr_session="))).toBe(false);
  });

  it("links GitHub to the existing account with that verified email, and tells its owner", async () => {
    t = await makeTestApp(GITHUB, { fetch: fakeGithub({ id: 7, login: "me-on-gh", email: "ME@example.com" }).fetchFn });
    const res = await viaGithub();
    expect(res.status).toBe(302);
    const [row] = await t.db.query<{ n: number }>("SELECT count(*)::int AS n FROM users");
    expect(row!.n).toBe(1);
    expect(t.mailer.last("me@example.com")!.subject).toBe("GitHub linked to Anywhere");
  });

  it("will not sign in a GitHub account with no verified email, or one not approved", async () => {
    t = await makeTestApp(GITHUB, { fetch: fakeGithub({ id: 8, login: "anon", email: "anon@example.com", verified: false }).fetchFn });
    const res = await viaGithub();
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("no verified primary email");
    await t.close();

    t = await makeTestApp({ ...GITHUB, ANYWHERE_SIGNUPS: "approved" }, { fetch: fakeGithub({ id: 9, login: "new", email: "new@example.com" }).fetchFn });
    const gated = await viaGithub();
    expect(gated.status).toBe(403);
    expect(await t.db.query("SELECT 1 FROM users WHERE email = 'new@example.com'")).toHaveLength(0);
  });

  it("links and unlinks from the security page, only after a recent sign-in", async () => {
    t = await makeTestApp(GITHUB, { fetch: fakeGithub({ id: 11, login: "linked", email: "someone-else@example.com" }).fetchFn });
    const cookie = await signIn(t);
    await t.db.query("UPDATE web_sessions SET reauth_at = now() - interval '11 minutes'");
    const stale = await t.fetch("/auth/github?link=1", { headers: { cookie }, redirect: "manual" });
    expect(stale.headers.get("location")).toMatch(/^\/account\/confirm/);
    await t.db.query("UPDATE web_sessions SET reauth_at = now()");
    const res = await viaGithub("/projects", cookie, true);
    expect(res.headers.get("location")).toBe("/account/security?done=github");
    const security = await page("/account/security", cookie);
    expect(security).toContain("@linked");
    const unlink = await t.fetch("/account/security/github/unlink", post({ _csrf: csrfFrom(security) }, cookie));
    expect(unlink.status).toBe(302);
    expect(await t.db.query("SELECT 1 FROM users WHERE github_id IS NOT NULL")).toHaveLength(0);
    expect(t.mailer.last("me@example.com")!.subject).toBe("GitHub unlinked from Anywhere");
  });

  it("is not offered when no GitHub app is configured", async () => {
    t = await makeTestApp();
    expect(await (await t.fetch("/signin")).text()).not.toContain("Continue with GitHub");
    expect((await t.fetch("/auth/github")).status).toBe(404);
  });
});

// ---------- passkeys ----------

describe("passkeys", () => {
  const json = (body: unknown, cookie: string, csrf = ""): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, cookie, ...(csrf ? { "x-csrf-token": csrf } : {}) },
    body: JSON.stringify(body),
  });

  it("offers registration only with the CSRF token and a recent sign-in, for this site, with user verification", async () => {
    t = await makeTestApp();
    const cookie = await signIn(t);
    const csrf = csrfFrom(await page("/account/security", cookie));
    expect((await t.fetch("/passkeys/register/options", json({}, cookie))).status).toBe(403);
    const res = await t.fetch("/passkeys/register/options", json({}, cookie, csrf));
    expect(res.status).toBe(200);
    const o = (await res.json()) as { rp: { id: string; name: string }; authenticatorSelection: { userVerification: string; residentKey: string }; attestation: string };
    expect(o.rp).toEqual({ id: "anywr.test", name: "Anywhere" });
    expect(o.authenticatorSelection).toMatchObject({ userVerification: "required", residentKey: "required" });
    expect(o.attestation).toBe("none");

    await t.db.query("UPDATE web_sessions SET reauth_at = now() - interval '11 minutes'");
    const stale = (await (await t.fetch("/passkeys/register/options", json({}, cookie, csrf))).json()) as { confirm?: string };
    expect(stale.confirm).toMatch(/^\/account\/confirm/);
  });

  it("refuses a made-up response, and a challenge works once", async () => {
    t = await makeTestApp();
    const cookie = await signIn(t);
    const csrf = csrfFrom(await page("/account/security", cookie));
    await t.fetch("/passkeys/register/options", json({}, cookie, csrf));
    const fake = { id: "AAAA", rawId: "AAAA", type: "public-key", response: { clientDataJSON: "e30", attestationObject: "AAAA" }, clientExtensionResults: {} };
    const bad = await t.fetch("/passkeys/register/verify", json(fake, cookie, csrf));
    expect(bad.status).toBe(400);
    expect(await t.db.query("SELECT 1 FROM passkeys")).toHaveLength(0);
    const again = (await (await t.fetch("/passkeys/register/verify", json(fake, cookie, csrf))).json()) as { error: string };
    expect(again.error).toContain("took too long");

    const signinOptions = await t.fetch("/passkeys/signin/options", { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: "{}" });
    expect(((await signinOptions.json()) as { userVerification: string }).userVerification).toBe("required");
    const noBrowser = await t.fetch("/passkeys/signin/verify", { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ id: "AAAA" }) });
    expect(noBrowser.status).toBe(400);
  });

  it("lists passkeys on the security page and removes one with a notice", async () => {
    t = await makeTestApp();
    const cookie = await signIn(t);
    await t.db.query("INSERT INTO passkeys (id, user_id, public_key, name) VALUES ('cred1', $1, '\\x00', 'Safari on macOS (synced)')", [t.user.id]);
    const security = await page("/account/security", cookie);
    expect(security).toContain("Safari on macOS (synced)");
    const res = await t.fetch("/account/security/passkeys/cred1/delete", post({ _csrf: csrfFrom(security) }, cookie));
    expect(res.status).toBe(302);
    expect(await t.db.query("SELECT 1 FROM passkeys")).toHaveLength(0);
    expect(t.mailer.last("me@example.com")!.subject).toBe("Passkey removed from Anywhere");
    expect(await page("/account/security", cookie)).toContain("Removed passkey");
  });
});

// ---------- notices, email change, export ----------

describe("security notices", () => {
  it("emails the owner when a token is created or an app is connected, with where it came from", async () => {
    t = await makeTestApp();
    const cookie = await signIn(t);
    const tokens = await page("/tokens", cookie);
    await t.fetch("/tokens", { ...post({ _csrf: csrfFrom(tokens), name: "Laptop", expires: "30" }, cookie), headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE, cookie, "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15" } });
    const mail = t.mailer.last("me@example.com")!;
    expect(mail.subject).toBe("New Anywhere token: Laptop");
    expect(mail.text).toContain("Browser: Safari on macOS");
    expect(mail.text).toContain(`${BASE}/account/security`);

    await grant(t, cookie, "My Agent");
    expect(t.mailer.last("me@example.com")!.subject).toBe("My Agent was connected to Anywhere");
    const security = await page("/account/security", cookie);
    expect(security).toContain("Connected My Agent");
    expect(security).toContain("Created token “Laptop”");
  });
});

describe("changing the email address", () => {
  it("sends a code to the new address, switches once it is entered, and tells the old one", async () => {
    t = await makeTestApp();
    const cookie = await signIn(t);
    const form = await page("/account/email", cookie);
    expect((await t.fetch("/account/email", post({ _csrf: csrfFrom(form), email: "me@example.com" }, cookie))).status).toBe(422);
    const sent = await t.fetch("/account/email", post({ _csrf: csrfFrom(form), email: "New.Me@example.com" }, cookie));
    expect(sent.status).toBe(303);
    expect(t.mailer.last("new.me@example.com")!.subject).toMatch(/^Confirm your new Anywhere email: \d{6}$/);
    const res = await t.fetch("/account/email/code", post({ _csrf: csrfFrom(form), code: codeFor(t, "new.me@example.com") }, cookie));
    expect(res.headers.get("location")).toBe("/account/security?done=email");
    expect((await t.db.query<{ email: string }>("SELECT email FROM users"))[0]!.email).toBe("new.me@example.com");
    const notice = t.mailer.last("me@example.com")!;
    expect(notice.subject).toBe("Your Anywhere email was changed");
    expect(notice.text).toContain("new.me@example.com");
  });

  it("refuses an address another account uses", async () => {
    t = await makeTestApp();
    await t.db.query("INSERT INTO users (id, email) VALUES ('u2', 'taken@example.com')");
    const cookie = await signIn(t);
    const form = await page("/account/email", cookie);
    const res = await t.fetch("/account/email", post({ _csrf: csrfFrom(form), email: "Taken@example.com" }, cookie));
    expect(res.status).toBe(409);
    expect(t.mailer.last("taken@example.com")).toBeUndefined();
  });
});

describe("downloading everything", () => {
  it("zips every project under its own folder", async () => {
    t = await makeTestApp();
    await t.api("POST", "/projects", { name: "Alpha" });
    await t.api("POST", "/projects", { name: "Beta" });
    const cookie = await signIn(t);
    const res = await t.fetch("/account/export.zip", { headers: { cookie } });
    expect(res.headers.get("content-type")).toBe("application/zip");
    const files = Object.keys(unzipSync(new Uint8Array(await res.arrayBuffer())));
    expect(files.some((f) => /^anywhere-\d{4}-\d{2}-\d{2}\/alpha\/overview\.md$/.test(f))).toBe(true);
    expect(files.some((f) => /\/beta\/plan\.md$/.test(f))).toBe(true);
  });
});

// ---------- mail ----------

describe("sending mail", () => {
  it("needs a provider and a sender address in production", () => {
    const prod = { NODE_ENV: "production", BASE_URL: "https://anywr.example" };
    expect(() => loadConfig(prod)).toThrow(/signs people in by email/);
    expect(() => loadConfig({ ...prod, RESEND_API_KEY: "re_x" })).toThrow(/ANYWHERE_MAIL_FROM/);
    expect(() => loadConfig({ ...prod, RESEND_API_KEY: "re_x", ANYWHERE_SMTP_URL: "smtp://x" })).toThrow(/not both/);
    expect(loadConfig({ ...prod, RESEND_API_KEY: "re_x", ANYWHERE_MAIL_FROM: "Anywhere <hello@mail.anywr.example>" }).mail.provider).toBe("resend");
    expect(loadConfig({}).mail.provider).toBe("log");
    expect(loadConfig({ ANYWHERE_LOCAL: "1" }).mail.provider).toBe("none");
    expect(() => loadConfig({ GITHUB_CLIENT_ID: "x" })).toThrow(/both/);
  });

  it("sends through Resend with the configured sender and reply-to, and only to the allowlist when one is set", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const cfg = loadConfig({ RESEND_API_KEY: "re_key", ANYWHERE_MAIL_FROM: "Anywhere <hello@mail.anywr.example>", ANYWHERE_MAIL_REPLY_TO: "support@anywr.example", ANYWHERE_MAIL_ALLOWLIST: "e@example.com,@team.example" }).mail;
    const mailer = createMailer(cfg, fetchFn);
    const brand = { productName: "Anywhere", appUrl: "https://app.anywr.example", siteUrl: "https://anywr.example", supportEmail: "support@anywr.example" };
    await mailer.send(codeEmail(brand, "e@example.com", "signin", "123456", "https://app.anywr.example/signin/link?t=x", 10));
    await mailer.send(codeEmail(brand, "a@team.example", "signin", "123456", "https://app.anywr.example/signin/link?t=x", 10));
    await mailer.send(codeEmail(brand, "stranger@example.org", "signin", "123456", "https://app.anywr.example/signin/link?t=x", 10));
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer re_key");
    const body = JSON.parse(String(calls[0]!.init.body)) as { from: string; reply_to: string; to: string[]; subject: string };
    expect(body).toMatchObject({ from: "Anywhere <hello@mail.anywr.example>", reply_to: "support@anywr.example", to: ["e@example.com"], subject: "Your Anywhere sign-in code: 123456" });
  });

  it("templates carry a plain-text part, the server's own mark as the only image, and say who sent them and why", () => {
    const brand = { productName: "Anywhere", appUrl: "https://app.anywr.example", siteUrl: "https://anywr.example", supportEmail: "support@anywr.example" };
    for (const mail of [
      codeEmail(brand, "e@example.com", "signup", "654321", "https://app.anywr.example/signin/link?t=x", 10),
      securityEmail(brand, "e@example.com", "New sign-in", "New sign-in", ["Your account was signed in to with GitHub."], { when: new Date(0), device: "Chrome on macOS", ip: "203.0.113.x" }, "notice-signin"),
    ]) {
      // One image, the same address for every recipient, so it cannot report an open.
      expect([...mail.html.matchAll(/src="([^"]*)"/g)].map((m) => m[1])).toEqual(["https://app.anywr.example/assets/mark.png"]);
      expect(mail.html).not.toMatch(/<link|<script/i);
      expect(mail.html).toContain('href="https://anywr.example"');
      expect(mail.text).toContain("This email was sent to e@example.com by Anywhere (app.anywr.example)");
      expect(mail.text).toContain("support@anywr.example");
    }
    const notice = securityEmail(brand, "e@example.com", "New sign-in", "New sign-in", ["Signed in."], { when: new Date(0), device: "Chrome on macOS", ip: "203.0.113.x" }, "notice-signin");
    expect(notice.text).toContain("Browser: Chrome on macOS");
    expect(notice.html).toContain(">Network</td>");
  });

  it("serves the mark the emails show, and the icon for browser tabs", async () => {
    t = await makeTestApp();
    const png = await t.fetch("/assets/mark.png");
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await png.arrayBuffer()).slice(1, 4)).toEqual(new TextEncoder().encode("PNG"));
    const svg = await t.fetch("/assets/mark.svg");
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
    expect(svg.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await (await t.fetch("/signin")).text()).toContain('rel="icon" href="/assets/mark.svg"');
  });
});
