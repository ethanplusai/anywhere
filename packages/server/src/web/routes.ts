import { Hono, type Context } from "hono";
import { timingSafeEqual } from "node:crypto";
import { html, raw } from "hono/html";
import { createSession, deleteSession } from "../auth/sessions.js";
import { createPat, listPats, revokePat } from "../auth/tokens.js";
import { MIN_PASSWORD, createUser, verifyLogin } from "../auth/users.js";
import { isApproved } from "../auth/early-access.js";
import { mcpUrl, type Deps } from "../deps.js";
import { clientIp, ipKey } from "../http.js";
import { listGrants } from "../oauth/grants.js";
import { AppError } from "../service/errors.js";
import { registerAccountRoutes, settingsPage } from "./account.js";
import { registerPageRoutes } from "./pages.js";
import { registerOnboarding } from "./onboarding.js";
import { ago, appBadge, copyField, dateLabel, flash, icon, layout, logo, mark, type Html } from "./render.js";
import { clearSessionCookie, csrfOk, originOk, safeNext, sessionMiddleware, setSessionCookie, type WebEnv } from "./session.js";

type C = Context<WebEnv>;
type Status = 200 | 400 | 403 | 404 | 409 | 422 | 429 | 500;
type Kind = "app" | "flush" | "auth" | "status";

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function viewWith(signups: boolean, siteUrl: string, c: C, title: string, body: Html, status: Status = 200, kind: Kind = "app") {
  return c.html(
    layout(title, body, {
      user: c.get("user"),
      csrf: c.get("csrf"),
      path: c.req.path,
      kind,
      query: c.req.path === "/search" ? (c.req.query("q") ?? "") : "",
      signups,
      siteUrl,
    }),
    status,
  );
}

function statusPageWith(view: (c: C, title: string, body: Html, status?: Status, kind?: Kind) => Response | Promise<Response>, c: C, status: Status, title: string, text: Html | string, actions?: Html) {
  return view(
    c,
    title,
    html`<div>
      <p class="code">${status}</p>
      <h1>${title}</h1>
      <p>${text}</p>
      <div class="actions">${actions ?? html`<a class="btn" href="${c.get("user") ? "/projects" : "/"}">${c.get("user") ? "Go to your projects" : "Go home"}</a>`}</div>
    </div>`,
    status,
    "status",
  );
}

function csrfField(c: C) {
  return html`<input type="hidden" name="_csrf" value="${c.get("csrf")}" />`;
}

export function webRoutes(deps: Deps): Hono<WebEnv> {
  const { db, config, limiter } = deps;
  const authRule = { limit: config.authRateLimit, windowS: 60 };
  const emailRule = { limit: config.signinEmailLimit, windowS: 15 * 60 };
  const addr = (c: C) => ipKey(clientIp(c, config));
  const view = (c: C, title: string, body: Html, status: Status = 200, kind: Kind = "app") => viewWith(config.signups === "open", config.siteUrl, c, title, body, status, kind);
  const statusPage = (c: C, status: Status, title: string, text: Html | string, actions?: Html) => statusPageWith(view, c, status, title, text, actions);
  const app = new Hono<WebEnv>();
  app.use("*", sessionMiddleware(db, config));
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Frame-Options", "DENY");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "same-origin");
    if (config.baseUrl.startsWith("https://")) c.header("Strict-Transport-Security", "max-age=63072000"); // audit A9
    // Pages for a signed-in person hold their notes: never cache them anywhere (audit D9).
    if (c.get("user")) c.header("Cache-Control", "private, no-store");
    if (c.res.headers.get("content-type")?.startsWith("text/html")) {
      // No remote images: a page written by a misled agent must not be able to send data out when
      // its owner opens it (audit D6). The only script is this server's own /assets/app.js.
      c.header(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      );
    }
  });
  // Every web page is rate limited: per person when signed in, per address otherwise (audit A2, D3).
  app.use("*", async (c, next) => {
    const user = c.get("user");
    const wait = await limiter.hit(`web:${user ? user.id : addr(c)}`, { limit: config.webRateLimit, windowS: 60 });
    if (wait !== null) {
      c.header("Retry-After", String(wait));
      return statusPage(c, 429, "Slow down a little", `Too many requests in a minute. Try again in ${wait} seconds.`, html``);
    }
    await next();
  });

  /** Redirects signed-out visitors to the sign-in page, keeping where they were going. */
  function requireUser(c: C): Response | null {
    if (c.get("user")) return null;
    const url = new URL(c.req.url);
    return c.redirect(`/signin?next=${encodeURIComponent(url.pathname + url.search)}`, 302);
  }

  app.onError((err, c) => {
    if (err instanceof AppError && (err.status === 404 || err.status === 422)) {
      return statusPage(c as C, 404, "Not found", err.message);
    }
    console.error("web error:", err);
    return statusPage(c as C, 500, "Something went wrong", "The server hit an error and did not finish. Nothing was changed. Try again in a moment.");
  });
  app.notFound((c) => statusPage(c as C, 404, "Not found", "There is no page at this address. It may have been moved or deleted."));

  app.get("/", (c) => c.redirect(c.get("user") ? "/projects" : "/signin", 302));

  // ---------- sign up, sign in, sign out ----------

  const gated = config.signups === "approved";
  const requestLink = config.earlyAccessUrl
    ? html`<a href="${config.earlyAccessUrl}">Request early access</a>`
    : html`Ask the person who runs this server to approve your email`;

  function authForm(c: C, kind: "signin" | "signup", opts: { error?: Html | string; email?: string; next?: string } = {}) {
    const isUp = kind === "signup";
    const next = opts.next ?? safeNext(c.req.query("next"));
    const connecting = next.startsWith("/oauth/");
    return html`<div class="auth-box">
      ${mark(44)}
      <h1>${isUp ? "Create your account" : connecting ? "Sign in to connect" : "Sign in to Anywhere"}</h1>
      <p class="lead">${isUp
        ? gated
          ? "Anywhere is opening to people in waves. If your email has been approved, create your account here."
          : "Free, with no card and no trial. Your agents get one shared memory."
        : connecting
          ? "An app wants to connect to your Anywhere account. Sign in first, then you can approve or deny it."
          : "Your projects, and every change your agents made."}</p>
      ${flash(opts.error ? { kind: "error", text: opts.error } : isUp && gated ? { kind: "notice", text: html`Not approved yet? ${requestLink}, and we will email you when your account is ready.` } : null)}
      <form method="post" action="/${kind}" class="card">
        <input type="hidden" name="next" value="${next}" />
        <div class="field">
          <label for="email">Email</label>
          <input id="email" type="email" name="email" autocomplete="email" required value="${opts.email ?? ""}" ${opts.email ? "" : raw("autofocus")} />
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input id="password" type="password" name="password" autocomplete="${isUp ? "new-password" : "current-password"}" required ${isUp ? raw(`minlength="${MIN_PASSWORD}"`) : ""} ${opts.email ? raw("autofocus") : ""} />
          ${isUp ? html`<p class="hint">At least ${MIN_PASSWORD} characters.</p>` : ""}
        </div>
        <div class="form-actions"><button type="submit" class="btn-wide">${isUp ? "Create account" : "Sign in"}</button></div>
      </form>
      <p class="after">
        ${isUp
          ? html`Already have an account? <a href="/signin?next=${encodeURIComponent(next)}">Sign in</a>`
          : config.disableSignups
            ? ""
            : gated
              ? html`New to Anywhere? ${config.earlyAccessUrl ? requestLink : html`<a href="/signup">Create an account</a>`}. Approved already? <a href="/signup?next=${encodeURIComponent(next)}">Create your account</a>`
              : html`New to Anywhere? <a href="/signup?next=${encodeURIComponent(next)}">Create an account</a>`}
      </p>
    </div>`;
  }

  const signupsClosed = (c: C) =>
    view(
      c,
      "Sign-ups are closed",
      html`<div class="auth-box">${mark(44)}<h1>This server is not taking new accounts</h1>
        <p class="lead">Its owner has turned sign-ups off. If you already have an account, sign in.</p>
        <a class="btn" href="/signin">Sign in</a></div>`,
      403,
      "auth",
    );

  // ---------- local mode: no accounts, one owner, a one-time link unlocks the browser ----------

  const local = deps.local;
  if (local) {
    const unlockPage = (c: C, error?: string, status: 200 | 400 | 429 = 200) =>
      view(
        c,
        "Open Anywhere",
        html`<div class="auth-box" data-unlock>
          ${mark(44)}
          <h1>Open your Anywhere</h1>
          <p class="lead">This Anywhere runs on this computer only, with no account. Open the link it printed when it started, or paste the token from <code>${local.browserTokenPath}</code>.</p>
          ${flash(error ? { kind: "error", text: error } : null)}
          <form method="post" action="/local/unlock" class="card" id="unlock-form">
            <input type="hidden" name="next" value="${safeNext(c.req.query("next"))}" />
            <div class="field">
              <label for="token">Token</label>
              <input id="token" type="password" name="token" autocomplete="off" required />
            </div>
            <div class="form-actions"><button type="submit" class="btn-wide">Open</button></div>
          </form>
        </div>`,
        status,
        "auth",
      );
    app.get("/local/unlock", (c) => (c.get("user") ? c.redirect(safeNext(c.req.query("next")), 302) : unlockPage(c)));
    app.post("/local/unlock", async (c) => {
      const form = await c.req.parseBody();
      if ((await limiter.hit(`unlock:${addr(c)}`, authRule)) !== null) return unlockPage(c, "Too many attempts. Wait a minute and try again.", 429);
      const given = Buffer.from(str(form.token).trim());
      const bt = Buffer.from(local.browserToken);
      if (given.length !== bt.length || !timingSafeEqual(given, bt)) {
        return unlockPage(c, "That token does not match. A link opens a browser once; the current token is in the file below.", 400);
      }
      // Used: the link that carried this token, wherever it was seen or logged, opens nothing now.
      local.renewBrowserToken();
      const projects = await deps.service.listProjects(local.ownerId);
      const next = safeNext(form.next);
      return startSession(c, local.ownerId, next === "/projects" && !projects.length ? "/welcome" : next);
    });
    app.get("/signin", (c) => c.redirect(`/local/unlock${new URL(c.req.url).search}`, 302));
    app.get("/signup", (c) => c.redirect("/local/unlock", 302));
    app.post("/signin", (c) => c.redirect("/local/unlock", 303));
    app.post("/signup", (c) => c.redirect("/local/unlock", 303));
  }

  app.get("/signup", (c) => {
    if (c.get("user")) return c.redirect(safeNext(c.req.query("next")), 302);
    const email = (c.req.query("email") ?? "").slice(0, 254);
    return config.disableSignups ? signupsClosed(c) : view(c, "Create an account", authForm(c, "signup", email ? { email } : {}), 200, "auth");
  });
  app.get("/signin", (c) => {
    if (c.get("user")) return c.redirect(safeNext(c.req.query("next")), 302);
    return view(c, "Sign in", authForm(c, "signin"), 200, "auth");
  });

  async function startSession(c: C, userId: string, next: string) {
    // A session already in this browser (anyone's) ends at sign-in (audit A12).
    const old = c.get("sid");
    if (old) await deleteSession(db, old);
    const sid = await createSession(db, userId);
    setSessionCookie(c, config, sid);
    return c.redirect(safeNext(next), 302);
  }

  const forbidden = (c: C) => statusPage(c, 403, "That request was refused", "It did not come from this site. Reload the page and try again.");

  app.post("/signup", async (c) => {
    if (config.disableSignups) return signupsClosed(c);
    if (!originOk(c, config)) return forbidden(c);
    const form = await c.req.parseBody();
    const email = str(form.email);
    const rawNext = safeNext(form.next);
    // A new account goes to the connect page first, unless it was on its way to approve an app.
    const next = rawNext === "/projects" || rawNext === "/" ? "/welcome" : rawNext;
    if ((await limiter.hit(`auth:${addr(c)}`, authRule)) !== null) {
      return view(c, "Create an account", authForm(c, "signup", { error: "Too many attempts. Wait a minute and try again.", email, next: rawNext }), 429, "auth");
    }
    if (gated && !(await isApproved(db, email))) {
      return view(
        c,
        "Create an account",
        authForm(c, "signup", { error: html`That email is not approved yet. ${requestLink}, and we will email you when your account is ready.`, email, next: rawNext }),
        403,
        "auth",
      );
    }
    try {
      const user = await createUser(db, email, str(form.password));
      return startSession(c, user.id, next);
    } catch (err) {
      if (err instanceof AppError) {
        return view(c, "Create an account", authForm(c, "signup", { error: err.message, email, next: rawNext }), err.status === 409 ? 409 : 422, "auth");
      }
      throw err;
    }
  });

  app.post("/signin", async (c) => {
    if (!originOk(c, config)) return forbidden(c);
    const form = await c.req.parseBody();
    const email = str(form.email);
    const next = safeNext(form.next);
    if ((await limiter.hit(`auth:${addr(c)}`, authRule)) !== null) {
      return view(c, "Sign in", authForm(c, "signin", { error: "Too many attempts. Wait a minute and try again.", email, next }), 429, "auth");
    }
    // Failures are also counted per account, so rotating addresses does not help a password guesser.
    const accountKey = `signin-email:${email.trim().toLowerCase()}`;
    const locked = await limiter.peek(accountKey, emailRule);
    if (locked !== null) {
      const minutes = Math.ceil(locked / 60);
      return view(c, "Sign in", authForm(c, "signin", { error: `Too many failed attempts for this account. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`, email, next }), 429, "auth");
    }
    const user = await verifyLogin(db, email, str(form.password));
    if (!user) {
      await limiter.hit(accountKey, emailRule);
      return view(c, "Sign in", authForm(c, "signin", { error: "That email and password do not match.", email, next }), 400, "auth");
    }
    return startSession(c, user.id, next);
  });

  app.post("/signout", async (c) => {
    const form = await c.req.parseBody();
    const sid = c.get("sid");
    if (sid && csrfOk(c, form._csrf)) await deleteSession(db, sid);
    clearSessionCookie(c, config);
    return c.redirect("/signin", 302);
  });

  // ---------- projects, pages, history, search ----------

  registerPageRoutes(app, deps, { view, csrfField, requireUser });

  // ---------- personal access tokens ----------

  async function tokensPage(c: C, created?: { name: string; token: string }, notice?: string) {
    c.header("Cache-Control", "no-store");
    const tokens = await listPats(db, c.get("user")!.id);
    const now = Date.now();
    return settingsPage(
      c,
      view,
      "/tokens",
      "Tokens",
      html`${created
          ? html`<div class="notice flash" role="status">${icon("key")}<div>
              <p><strong>Copy your new token “${created.name}” now.</strong> It is shown once and cannot be shown again.</p>
              ${copyField(created.token, "Copy token")}
              <p>Sign the <code>anywr</code> command in with it:</p>
              ${copyField(`anywr login ${config.baseUrl}`, "Copy command")}
            </div></div>`
          : flash(notice ? { kind: "ok", text: notice } : null)}
        <section class="section">
          <h2>Personal access tokens</h2>
          <p>For the <code>anywr</code> command line tool, which keeps a project's pages as files in a repository. Agents connected through the Connect page do not need one.</p>
          ${tokens.length
            ? html`<ul class="list">
                ${tokens.map((t) => {
                  const expired = t.expiresAt !== null && new Date(t.expiresAt).getTime() < now;
                  return html`<li><div class="item">
                    ${icon("key")}
                    <div class="item-main">
                      <div class="item-title">${t.name} ${expired ? html`<span class="tag">Expired</span>` : ""}</div>
                      <div class="meta">
                        <span>Created ${ago(new Date(t.createdAt).toISOString())}</span>
                        <span>${t.lastUsedAt ? html`Used ${ago(new Date(t.lastUsedAt).toISOString())}` : "Never used"}</span>
                        <span>${t.expiresAt ? (expired ? html`Expired ${ago(new Date(t.expiresAt).toISOString())}` : `Expires ${dateLabel(new Date(t.expiresAt).toISOString())}`) : "Never expires"}</span>
                      </div>
                    </div>
                    <div class="item-end">
                      <form method="post" action="/tokens/${t.id}/revoke" data-confirm="Revoke “${t.name}”? Anything using it stops working.">
                        ${csrfField(c)}<button type="submit" class="btn-sm danger">Revoke</button>
                      </form>
                    </div>
                  </div></li>`;
                })}
              </ul>`
            : html`<p class="muted">You have no tokens.</p>`}
        </section>
        <section class="section">
          <h2>Create a token</h2>
          <form method="post" action="/tokens" class="card">
            ${csrfField(c)}
            <div class="field">
              <label for="name">Name</label>
              <input id="name" type="text" name="name" maxlength="100" placeholder="Work laptop" required />
              <p class="hint">Where you will use it, so you know which one to revoke later.</p>
            </div>
            <div class="field">
              <label for="expires">Expires</label>
              <select id="expires" name="expires">
                <option value="30">In 30 days</option>
                <option value="90" selected>In 90 days</option>
                <option value="365">In a year</option>
                <option value="never">Never</option>
              </select>
            </div>
            <div class="form-actions"><button type="submit">Create token</button></div>
          </form>
        </section>`,
    );
  }

  app.get("/tokens", async (c) => requireUser(c) ?? tokensPage(c, undefined, c.req.query("done") === "revoked" ? "Token revoked. Anything using it has stopped working." : undefined));

  app.post("/tokens", async (c) => {
    const gate = requireUser(c);
    if (gate) return gate;
    const form = await c.req.parseBody();
    if (!csrfOk(c, form._csrf)) return statusPage(c, 403, "This form expired", "Reload the page and try again.", html`<a class="btn" href="/tokens">Back to tokens</a>`);
    if ((await limiter.hit(`tokens:${c.get("user")!.id}`, authRule)) !== null) {
      return statusPage(c, 429, "Too many tokens at once", "Wait a minute and try again.", html`<a class="btn" href="/tokens">Back to tokens</a>`);
    }
    const name = str(form.name).trim() || "token";
    const days = { "30": 30, "90": 90, "365": 365, never: null }[str(form.expires)];
    const { token } = await createPat(db, c.get("user")!.id, name, days === undefined ? 90 : days);
    return tokensPage(c, { name, token });
  });

  app.post("/tokens/:id/revoke", async (c) => {
    const gate = requireUser(c);
    if (gate) return gate;
    const form = await c.req.parseBody();
    if (!csrfOk(c, form._csrf)) return statusPage(c, 403, "This form expired", "Reload the page and try again.", html`<a class="btn" href="/tokens">Back to tokens</a>`);
    await revokePat(db, c.get("user")!.id, c.req.param("id"));
    return c.redirect("/tokens?done=revoked", 302);
  });

  registerAccountRoutes(app, deps, { view, csrfField, requireUser });
  registerOnboarding(app, deps, { view, csrfField, requireUser });

  // ---------- connect an agent ----------

  app.get("/connect", async (c) => {
    const gate = requireUser(c);
    if (gate) return gate;
    const url = mcpUrl(config);
    if (deps.local) {
      const tokenPath = deps.local.agentTokenPath;
      return view(
        c,
        "Connect an agent",
        html`<div class="head"><div><h1>Connect an agent</h1><p>This Anywhere runs on this computer only. Agents on this computer connect with the agent token in <code>${tokenPath}</code>, sent as a header. There is nothing to sign in to.</p></div></div>
          <section class="section" style="max-width:46rem">
            <h2>Claude Code</h2>
            <p>Run once in a terminal, then start a new session.</p>
            ${copyField(`claude mcp add --scope user --transport http anywhere-local ${url} --header "Authorization: Bearer $(cat ${tokenPath})"`)}
          </section>
          <section class="section" style="max-width:46rem">
            <h2>Codex</h2>
            <p>Codex reads the token from an environment variable. Add the server, and set the variable in your shell profile (for example <code>~/.zshrc</code>).</p>
            ${copyField(`codex mcp add anywhere-local --url ${url} --bearer-token-env-var ANYWHERE_LOCAL_TOKEN`)}
            ${copyField(`export ANYWHERE_LOCAL_TOKEN="$(cat ${tokenPath})"`)}
          </section>
          <section class="section" style="max-width:46rem">
            <h2>Other apps on this computer</h2>
            <p>Anything that speaks MCP over Streamable HTTP can use <code>${url}</code> with the header <code>Authorization: Bearer &lt;the token in ${tokenPath}&gt;</code>.</p>
            <p class="muted">Claude chat and ChatGPT run in the cloud, so they cannot reach an Anywhere on your computer. To use them too, use the hosted Anywhere or run your own on a server.</p>
          </section>`,
      );
    }
    const welcome = c.req.query("welcome") === "1";
    const grants = await listGrants(db, c.get("user")!.id);
    const tab = (id: string, checked = false) =>
      html`<input class="tab-radio" type="radio" name="agent" id="t-${id}" ${checked ? raw("checked") : ""} />`;
    const label = (id: string, text: string, logoId: string) => html`<label for="t-${id}">${logo(logoId)}${text}</label>`;
    return view(
      c,
      "Connect an agent",
      html`${welcome
          ? html`<div class="ok flash" role="status">${icon("check")}<div><strong>Your account is ready.</strong> Connect the agents you use, then ask one to start a project.</div></div>`
          : ""}
        <div class="head">
          <div><h1>Connect an agent</h1><p>Every agent uses the same address. The first time, it sends you here to sign in and approve it.</p></div>
        </div>
        <div class="stack" style="max-width:46rem">
          ${copyField(url, "Copy the Anywhere address")}
        </div>

        <section class="section" style="max-width:46rem;margin-block-start:2.5rem">
          ${tab("claude", true)}${tab("chatgpt")}${tab("claudecode")}${tab("codex")}${tab("other")}
          <div class="agent-tabs" role="presentation">
            ${label("claude", "Claude", "claude")}${label("chatgpt", "ChatGPT", "openai")}${label("claudecode", "Claude Code", "claudecode")}${label("codex", "Codex", "codex")}${label("other", "Other apps", "mcp")}
          </div>
          <div class="agent-panels card">
            <div class="agent-panel" id="p-claude">
              <ol class="how">
                <li><strong>Open Settings, then Connectors</strong><span class="muted">On claude.ai or in the Claude desktop app. Connectors you add there also work in the mobile app.</span></li>
                <li><strong>Choose Add custom connector</strong><span class="muted">Name it Anywhere and paste the address. Leave the advanced settings empty.</span>${copyField(url)}</li>
                <li><strong>Press Connect, sign in here and approve</strong></li>
                <li><strong>Turn it on in a chat</strong><span class="muted">Open the tools menu in a chat and make sure Anywhere is on.</span></li>
              </ol>
            </div>
            <div class="agent-panel" id="p-chatgpt">
              <ol class="how">
                <li><strong>Turn on developer mode</strong><span class="muted">On chatgpt.com, open Settings, Apps &amp; Connectors, Advanced settings, and turn on Developer mode.</span></li>
                <li><strong>Create the connector</strong><span class="muted">In Apps &amp; Connectors choose Create, name it Anywhere, paste the address and pick OAuth.</span>${copyField(url)}</li>
                <li><strong>Sign in here and approve</strong></li>
                <li><strong>Add it to a chat</strong><span class="muted">Pick Anywhere from the tools menu. ChatGPT asks you to confirm each change it makes.</span></li>
              </ol>
            </div>
            <div class="agent-panel" id="p-claudecode">
              <ol class="how">
                <li><strong>Add the server</strong><span class="muted">Run this in a terminal. Add <code>--scope user</code> to use it in every project.</span>${copyField(`claude mcp add --transport http anywhere ${url}`)}</li>
                <li><strong>Sign in</strong><span class="muted">In Claude Code, run <code>/mcp</code>, choose anywhere, then Authenticate. Your browser opens here to approve it.</span></li>
                <li><strong>Keep pages in your repository too</strong><span class="muted">Optional. The <code>anywr</code> command mirrors a project into a git-ignored folder, so pages are plain files. It signs in with a <a href="/tokens">token</a>.</span>${copyField("anywr link <project-slug>")}</li>
              </ol>
            </div>
            <div class="agent-panel" id="p-codex">
              <ol class="how">
                <li><strong>Add the server</strong>${copyField(`codex mcp add anywhere --url ${url}`)}</li>
                <li><strong>Sign in</strong><span class="muted">Your browser opens here to approve it.</span>${copyField("codex mcp login anywhere")}</li>
                <li><strong>Use it</strong><span class="muted">Start Codex and ask it to check Anywhere before it begins.</span></li>
              </ol>
            </div>
            <div class="agent-panel" id="p-other">
              <ol class="how">
                <li><strong>Apps that support MCP with sign-in</strong><span class="muted">Anything that speaks MCP over Streamable HTTP with OAuth, such as Cursor, can use the address directly.</span>${copyField(url)}</li>
                <li><strong>Apps that only send a fixed header</strong><span class="muted">Create a <a href="/tokens">personal access token</a> and send it as <code>Authorization: Bearer &lt;token&gt;</code>.</span></li>
              </ol>
            </div>
          </div>
        </section>

        <section class="section" style="max-width:46rem">
          <h2>Then just talk</h2>
          <p>Agents learn how Anywhere is organised from the server itself. A few things to say:</p>
          <ul class="say">
            <li>Start a project called Acme rebrand in Anywhere.</li>
            <li>Add this decision to Anywhere, with the reason.</li>
            <li>Check Anywhere for what we decided about pricing.</li>
            <li>Read the Acme project before we start.</li>
          </ul>
        </section>

        <section class="section" style="max-width:46rem">
          <h2>Connected</h2>
          ${grants.length
            ? html`<ul class="list">${grants.slice(0, 6).map(
                (g) => html`<li><div class="item">${appBadge(g.clientName)}<div class="item-main"><div class="item-title">${g.clientName ?? "Unnamed app"}</div><div class="item-sub">Approved ${ago(new Date(g.createdAt).toISOString())}${g.lastUsedAt ? html`, last used ${ago(new Date(g.lastUsedAt).toISOString())}` : ""}</div></div></div></li>`,
              )}</ul>
              <p class="small muted" style="margin-block-start:0.75rem"><a href="/account/apps">Manage connected apps</a></p>`
            : html`<p class="muted">No agents yet. Apps you approve show up here.</p>`}
        </section>`,
    );
  });

  return app;
}
