import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { html, raw } from "hono/html";
import { safeEqual } from "../auth/crypto.js";
import { isApproved } from "../auth/early-access.js";
import { CODE_MINUTES, checkCode, peekLink, pendingChallenge, startChallenge, useLink, type Challenge } from "../auth/email-codes.js";
import { GithubError, githubAccount, githubStart } from "../auth/github.js";
import { authenticationOptions, finishAuthentication } from "../auth/passkeys.js";
import type { SignInMethod } from "../auth/sessions.js";
import { checkEmail, createUser, findUserByEmail, findUserByGithub, linkGithub, markEmailVerified, type User } from "../auth/users.js";
import type { Deps } from "../deps.js";
import { clientIp, ipKey } from "../http.js";
import { codeEmail, noAccountEmail } from "../mail/templates.js";
import { AppError } from "../service/errors.js";
import { notify, sendQuietly } from "./notify.js";
import { flash, mark, type Html } from "./render.js";
import { browserId, originOk, safeNext, type WebEnv } from "./session.js";

type C = Context<WebEnv>;
type Status = 200 | 400 | 403 | 404 | 409 | 422 | 429 | 500;
type Kind = "app" | "flush" | "auth" | "status";
type View = (c: C, title: string, body: Html, status?: Status, kind?: Kind) => Response | Promise<Response>;

interface Helpers {
  view: View;
  /** Starts a session for the person and sends them on. */
  startSession: (c: C, userId: string, next: string, method: SignInMethod) => Promise<Response>;
}

/** GitHub's mark (Octicons, MIT licence), in the text colour. */
export const GITHUB_MARK = raw(
  '<svg class="i i-fill" viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/></svg>',
);

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Signing in has no password. A person types their email and gets a code (and a link that does the
 * same on another device), or continues with GitHub, or uses a passkey. There is one form for
 * signing in and signing up: an address with no account gets an account once its code is entered,
 * if sign-ups allow it. The page says the same thing whether or not an address has an account.
 */
export function registerSignin(app: Hono<WebEnv>, deps: Deps, h: Helpers): void {
  const { db, config, limiter } = deps;
  const authRule = { limit: config.authRateLimit, windowS: 60 };
  // Codes sent to one address: enough to retry, not enough to flood someone's inbox.
  const sendRule = { limit: config.signinEmailLimit, windowS: 60 * 60 };
  const addr = (c: C) => ipKey(clientIp(c, config));
  const gated = config.signups === "approved";
  const github = config.github;
  const githubRedirect = `${config.baseUrl}/auth/github/callback`;

  const mayCreate = async (email: string) => config.signups === "open" || (gated && (await isApproved(db, email)));
  const requestLink = config.earlyAccessUrl ? html`<a href="${config.earlyAccessUrl}">Request early access</a>` : html`Ask the person who runs this server to approve your email`;

  const forbidden = (c: C) =>
    h.view(c, "That request was refused", html`<div><p class="code">403</p><h1>That request was refused</h1><p>It did not come from this site. Reload the page and try again.</p><div class="actions"><a class="btn" href="/signin">Back to sign in</a></div></div>`, 403, "status");

  // ---------- the form ----------

  function emailForm(c: C, kind: "signin" | "signup", opts: { error?: Html | string; notice?: Html | string; email?: string; next?: string } = {}) {
    const isUp = kind === "signup";
    const next = opts.next ?? safeNext(c.req.query("next"));
    const connecting = next.startsWith("/oauth/");
    const enc = encodeURIComponent(next);
    return html`<div class="auth-box">
      ${mark(44)}
      <h1>${isUp ? "Create your account" : connecting ? "Sign in to connect" : `Sign in to ${config.productName}`}</h1>
      <p class="lead">${connecting
        ? "An app wants to connect to your account. Sign in first, then you can approve or deny it."
        : isUp
          ? gated
            ? `${config.productName} is opening to people in waves. If your email has been approved, create your account here.`
            : "Free, with no card and no trial. Your agents get one shared memory."
          : "Your projects, and every change your agents made."}</p>
      ${flash(opts.error ? { kind: "error", text: opts.error } : opts.notice ? { kind: "notice", text: opts.notice } : isUp && gated ? { kind: "notice", text: html`Not approved yet? ${requestLink}, and we will email you when your account is ready.` } : null)}
      <div class="card stack">
        ${github
          ? html`<a class="btn btn-wide secondary" href="/auth/github?next=${enc}">${GITHUB_MARK}Continue with GitHub</a>`
          : ""}
        <button type="button" class="btn-wide secondary" data-passkey="signin" data-next="${next}" hidden>Sign in with a passkey</button>
        ${github ? html`<p class="or"><span>or</span></p>` : html`<p class="or" data-passkey-or hidden><span>or</span></p>`}
        <form method="post" action="/signin" class="stack">
          <input type="hidden" name="next" value="${next}" />
          <input type="hidden" name="kind" value="${kind}" />
          <div class="field">
            <label for="email">Email</label>
            <input id="email" type="email" name="email" autocomplete="email" required maxlength="254" value="${opts.email ?? ""}" autofocus />
          </div>
          <div class="form-actions"><button type="submit" class="btn-wide">Continue with email</button></div>
          <p class="hint">We email you a six-digit code. There is no password.</p>
        </form>
        <p class="error-inline" data-passkey-error role="alert" hidden></p>
      </div>
      <p class="after">
        ${isUp
          ? html`Already have an account? <a href="/signin?next=${enc}">Sign in</a>`
          : config.disableSignups
            ? ""
            : gated && config.earlyAccessUrl
              ? html`New here? ${requestLink}. Approved already? Enter your email above.`
              : html`New here? Enter your email above and we will create your account.`}
      </p>
    </div>`;
  }

  const signupsClosed = (c: C) =>
    h.view(
      c,
      "Sign-ups are closed",
      html`<div class="auth-box">${mark(44)}<h1>This server is not taking new accounts</h1>
        <p class="lead">Its owner has turned sign-ups off. If you already have an account, sign in.</p>
        <a class="btn" href="/signin">Sign in</a></div>`,
      403,
      "auth",
    );

  app.get("/signin", (c) => {
    if (c.get("user")) return c.redirect(safeNext(c.req.query("next")), 302);
    const notice = { expired: "That code expired or was used. Ask for a new one.", denied: "GitHub sign-in was cancelled." }[c.req.query("m") ?? ""];
    return h.view(c, "Sign in", emailForm(c, "signin", notice ? { notice } : {}), 200, "auth");
  });
  app.get("/signup", (c) => {
    if (c.get("user")) return c.redirect(safeNext(c.req.query("next")), 302);
    if (config.disableSignups) return signupsClosed(c);
    const email = (c.req.query("email") ?? "").slice(0, 254);
    return h.view(c, "Create an account", emailForm(c, "signup", email ? { email } : {}), 200, "auth");
  });

  // ---------- email: send the code ----------

  app.post("/signin", async (c) => {
    if (!originOk(c, config)) return forbidden(c);
    const form = await c.req.parseBody();
    const kind = str(form.kind) === "signup" ? "signup" : "signin";
    const next = safeNext(form.next);
    const raw = str(form.email).slice(0, 320);
    const again = (status: Status, error: string) => h.view(c, kind === "signup" ? "Create an account" : "Sign in", emailForm(c, kind, { error, email: raw, next }), status, "auth");
    if ((await limiter.hit(`auth:${addr(c)}`, authRule)) !== null) return again(429, "Too many attempts. Wait a minute and try again.");
    let email: string;
    try {
      email = checkEmail(raw);
    } catch (err) {
      return again(422, (err as AppError).message);
    }
    const key = email.toLowerCase();
    if ((await limiter.hit(`email-send:${key}`, sendRule)) !== null) {
      return again(429, "We have sent several codes to this address in the last hour. Use the newest one, or wait a while and try again.");
    }
    const user = await findUserByEmail(db, email);
    const browser = browserId(c, config);
    const { code, link } = await startChallenge(db, { purpose: "signin", email, userId: user?.id ?? null, browser, next });
    const linkUrl = `${config.baseUrl}/signin/link?t=${link}`;
    // The page that follows is the same in every case; only the email differs.
    let mail;
    if (user) mail = codeEmail(deps.brand, email, "signin", code, linkUrl, CODE_MINUTES);
    else if (await mayCreate(email)) mail = codeEmail(deps.brand, email, "signup", code, linkUrl, CODE_MINUTES);
    else mail = config.disableSignups ? null : noAccountEmail(deps.brand, email, config.earlyAccessUrl);
    if (mail && !(await sendQuietly(deps, mail))) return again(500, "We could not send the email just now. Try again in a minute.");
    return c.redirect("/signin/code", 303);
  });

  // ---------- email: enter the code ----------

  async function codePage(c: C, opts: { error?: string; status?: Status } = {}) {
    c.header("Cache-Control", "no-store");
    const ch = await pendingChallenge(db, browserId(c, config), "signin");
    if (!ch) return c.redirect("/signin?m=expired", 302);
    return h.view(
      c,
      "Check your email",
      html`<div class="auth-box">
        ${mark(44)}
        <h1>Check your email</h1>
        <p class="lead">We sent a six-digit code to <strong>${ch.email}</strong>. It works for ${CODE_MINUTES} minutes, in this browser.</p>
        ${flash(opts.error ? { kind: "error", text: opts.error } : null)}
        <form method="post" action="/signin/code" class="card stack">
          <div class="field">
            <label for="code">Code</label>
            <input id="code" type="text" class="code-input" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required autofocus />
          </div>
          <div class="form-actions"><button type="submit" class="btn-wide">Continue</button></div>
          <p class="hint">On another device? The button in the email signs that device in instead.</p>
        </form>
        <p class="after">Wrong address or no email? <a href="/signin?next=${encodeURIComponent(ch.next)}">Start again</a>. Check your spam folder too.</p>
      </div>`,
      opts.status ?? 200,
      "auth",
    );
  }

  app.get("/signin/code", (c) => (c.get("user") ? c.redirect("/projects", 302) : codePage(c)));

  app.post("/signin/code", async (c) => {
    if (!originOk(c, config)) return forbidden(c);
    const form = await c.req.parseBody();
    if ((await limiter.hit(`auth:${addr(c)}`, authRule)) !== null) return codePage(c, { error: "Too many attempts. Wait a minute and try again.", status: 429 });
    const result = await checkCode(db, browserId(c, config), "signin", str(form.code).slice(0, 16));
    if (!result.ok) {
      if (result.reason === "none") return c.redirect("/signin?m=expired", 303);
      if (result.reason === "spent") return h.view(c, "Sign in", emailForm(c, "signin", { error: "Too many wrong codes. Ask for a new one." }), 400, "auth");
      return codePage(c, { error: `That code is not right. ${result.left} ${result.left === 1 ? "try" : "tries"} left.`, status: 400 });
    }
    return complete(c, result.challenge);
  });

  // ---------- email: the link ----------

  const linkGone = (c: C) =>
    h.view(
      c,
      "This link has expired",
      html`<div class="auth-box">${mark(44)}<h1>This link has expired</h1><p class="lead">Sign-in links work once, for ${CODE_MINUTES} minutes. Ask for a new one.</p><a class="btn" href="/signin">Sign in</a></div>`,
      400,
      "auth",
    );

  // Opening the link only shows a button: mail scanners open links, and must not use them up.
  app.get("/signin/link", async (c) => {
    c.header("Cache-Control", "no-store");
    const token = c.req.query("t") ?? "";
    const ch = await peekLink(db, token);
    if (!ch || ch.purpose !== "signin") return linkGone(c);
    return h.view(
      c,
      "Sign in",
      html`<div class="auth-box">${mark(44)}
        <h1>Sign in as ${ch.email}?</h1>
        <p class="lead">Continue to sign in to ${config.productName} in this browser.</p>
        <form method="post" action="/signin/link" class="card">
          <input type="hidden" name="t" value="${token}" />
          <div class="form-actions"><button type="submit" class="btn-wide">Continue</button></div>
        </form>
        <p class="after">Not you? Close this page. Nothing happens unless you continue.</p>
      </div>`,
      200,
      "auth",
    );
  });

  app.post("/signin/link", async (c) => {
    if (!originOk(c, config)) return forbidden(c);
    const form = await c.req.parseBody();
    if ((await limiter.hit(`auth:${addr(c)}`, authRule)) !== null) return linkGone(c);
    const ch = await useLink(db, str(form.t));
    return ch ? complete(c, ch) : linkGone(c);
  });

  /** A code or link was right: sign in, or create the account if sign-ups allow it. */
  async function complete(c: C, ch: Challenge) {
    const existing = await findUserByEmail(db, ch.email);
    if (existing) {
      await markEmailVerified(db, existing.id);
      await notify(deps, c, existing, "signin", "an email code", { email: false });
      return h.startSession(c, existing.id, ch.next, "email");
    }
    if (!(await mayCreate(ch.email))) return notApproved(c, ch.email);
    let user: User;
    try {
      user = await createUser(db, ch.email, { verified: true });
    } catch (err) {
      if (err instanceof AppError && err.status === 409) return linkGone(c);
      throw err;
    }
    await notify(deps, c, user, "account_created", "", { email: false });
    return h.startSession(c, user.id, welcomeOr(ch.next), "email");
  }

  const welcomeOr = (next: string) => (next === "/projects" || next === "/" ? "/welcome" : next);

  const notApproved = (c: C, email: string) =>
    h.view(
      c,
      "Not approved yet",
      html`<div class="auth-box">${mark(44)}<h1>${config.disableSignups ? "This server is not taking new accounts" : "That email is not approved yet"}</h1>
        <p class="lead">${config.disableSignups ? "Its owner has turned sign-ups off." : html`There is no account for ${email} yet. ${requestLink}, and we will email you when your account is ready.`}</p>
        <a class="btn" href="/signin">Back to sign in</a></div>`,
      403,
      "auth",
    );

  // ---------- GitHub ----------

  const githubCookie = config.baseUrl.startsWith("https://") ? "__Host-anywr_github" : "anywr_github";
  const secure = config.baseUrl.startsWith("https://");

  app.get("/auth/github", (c) => {
    if (!github) return h.view(c, "Not found", html`<div><p class="code">404</p><h1>Not found</h1><p>Sign-in with GitHub is not set up on this server.</p></div>`, 404, "status");
    const linking = c.req.query("link") === "1";
    if (linking) {
      if (!c.get("user")) return c.redirect("/signin", 302);
      // Linking adds a way into the account, so it needs a recent sign-in, like removing one does.
      const s = c.get("session");
      if (!s || Date.now() - s.reauthAt.getTime() > 10 * 60 * 1000) return c.redirect(`/account/confirm?next=${encodeURIComponent("/auth/github?link=1")}`, 302);
    }
    const start = githubStart(github, githubRedirect);
    const value = Buffer.from(JSON.stringify({ s: start.state, v: start.verifier, n: safeNext(c.req.query("next")), l: linking ? 1 : 0 })).toString("base64url");
    setCookie(c, githubCookie, value, { httpOnly: true, secure, sameSite: "Lax", path: "/", maxAge: 600 });
    return c.redirect(start.url, 302);
  });

  app.get("/auth/github/callback", async (c) => {
    if (!github) return c.redirect("/signin", 302);
    const raw = getCookie(c, githubCookie) ?? "";
    deleteCookie(c, githubCookie, { path: "/", secure });
    let saved: { s?: unknown; v?: unknown; n?: unknown; l?: unknown } = {};
    try {
      saved = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as typeof saved;
    } catch {
      /* no cookie: refused below */
    }
    const state = c.req.query("state") ?? "";
    if (typeof saved.s !== "string" || typeof saved.v !== "string" || !safeEqual(saved.s, state)) {
      return githubProblem(c, "This sign-in started somewhere else or took too long. Start again from this site.");
    }
    if (c.req.query("error")) return c.redirect("/signin?m=denied", 302);
    if ((await limiter.hit(`auth:${addr(c)}`, authRule)) !== null) return githubProblem(c, "Too many attempts. Wait a minute and try again.", 429);
    let account;
    try {
      account = await githubAccount(deps.fetch ?? fetch, github, c.req.query("code") ?? "", saved.v, githubRedirect);
    } catch (err) {
      if (!(err instanceof GithubError)) console.error("github sign-in failed:", (err as Error).message);
      return githubProblem(c, "GitHub did not complete the sign-in. Try again.");
    }
    const next = safeNext(saved.n);
    const current = c.get("user");

    if (saved.l === 1) {
      if (!current) return c.redirect("/signin", 302);
      try {
        await linkGithub(db, current.id, account.id, account.login);
      } catch (err) {
        if (err instanceof AppError) return githubProblem(c, err.message, 409);
        throw err;
      }
      await notify(deps, c, current, "github_linked", `@${account.login}`);
      return c.redirect("/account/security?done=github", 302);
    }

    const byGithub = await findUserByGithub(db, account.id);
    if (byGithub) {
      await notify(deps, c, byGithub, "signin", "GitHub");
      return h.startSession(c, byGithub.id, next, "github");
    }
    if (!account.email) {
      return githubProblem(c, "Your GitHub account has no verified primary email, so Anywhere cannot tell which account is yours. Verify an email on GitHub, or sign in with email.");
    }
    const byEmail = await findUserByEmail(db, account.email);
    if (byEmail) {
      // GitHub has verified this address, so the account is the person's: link it, and tell them.
      await linkGithub(db, byEmail.id, account.id, account.login);
      await notify(deps, c, byEmail, "github_linked", `@${account.login}`);
      await notify(deps, c, byEmail, "signin", "GitHub", { email: false });
      return h.startSession(c, byEmail.id, next, "github");
    }
    if (!(await mayCreate(account.email))) return notApproved(c, account.email);
    const user = await createUser(db, account.email, { verified: true, githubId: account.id, githubLogin: account.login });
    await notify(deps, c, user, "account_created", "", { email: false });
    return h.startSession(c, user.id, welcomeOr(next), "github");
  });

  const githubProblem = (c: C, text: string, status: Status = 400) =>
    h.view(c, "Sign in with GitHub", html`<div class="auth-box">${mark(44)}<h1>That did not work</h1><p class="lead">${text}</p><a class="btn" href="/signin">Back to sign in</a></div>`, status, "auth");

  // ---------- passkeys ----------

  async function jsonBody(c: C): Promise<Record<string, unknown> | null> {
    try {
      const v = (await c.req.json()) as unknown;
      return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  app.post("/passkeys/signin/options", async (c) => {
    if (!originOk(c, config)) return c.json({ error: "That request did not come from this site." }, 403);
    if ((await limiter.hit(`auth:${addr(c)}`, authRule)) !== null) return c.json({ error: "Too many attempts. Wait a minute and try again." }, 429);
    const body = (await jsonBody(c)) ?? {};
    return c.json(await authenticationOptions(db, deps.rp, browserId(c, config), { next: safeNext(body.next) }));
  });

  app.post("/passkeys/signin/verify", async (c) => {
    if (!originOk(c, config)) return c.json({ error: "That request did not come from this site." }, 403);
    if ((await limiter.hit(`auth:${addr(c)}`, authRule)) !== null) return c.json({ error: "Too many attempts. Wait a minute and try again." }, 429);
    const body = await jsonBody(c);
    const result = await finishAuthentication(db, deps.rp, browserId(c, config), "signin", body);
    if (!result.ok) return c.json({ error: result.error }, 400);
    const user = (await db.query<User>("SELECT id, email FROM users WHERE id = $1", [result.userId]))[0];
    if (!user) return c.json({ error: "That account no longer exists." }, 400);
    await notify(deps, c, user, "signin", "a passkey", { email: false });
    // startSession sets the cookie on this context; the browser follows the redirect itself.
    const res = await h.startSession(c, user.id, result.next, "passkey");
    return c.json({ redirect: res.headers.get("location") ?? "/projects" });
  });
}
