import type { Context, Hono } from "hono";
import { html, raw } from "hono/html";
import { createSession, deleteUserSessions } from "../auth/sessions.js";
import { revokeAllPats } from "../auth/tokens.js";
import { checkPassword, deleteUser, MIN_PASSWORD, setPassword } from "../auth/users.js";
import { unlimited } from "../config.js";
import type { Deps } from "../deps.js";
import { listGrants, revokeAllGrants, revokeGrant } from "../oauth/grants.js";
import { AppError } from "../service/errors.js";
import { ago, appBadge, bytes, dateLabel, flash, icon, mark, type Flash, type Html } from "./render.js";
import { clearSessionCookie, csrfOk, setSessionCookie, type WebEnv } from "./session.js";

type C = Context<WebEnv>;
type Status = 200 | 400 | 403 | 404 | 409 | 422 | 429;
type Kind = "app" | "flush" | "auth" | "status";
type View = (c: C, title: string, body: Html, status?: Status, kind?: Kind) => Response | Promise<Response>;

interface Helpers {
  view: View;
  csrfField: (c: C) => Html;
  requireUser: (c: C) => Response | null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Where a connected app sends people back to. */
function appTarget(redirectUris: string[]): string {
  const first = redirectUris[0];
  if (!first) return "unknown";
  try {
    const u = new URL(first);
    return u.host ? u.host : first.slice(0, 80);
  } catch {
    return first.slice(0, 80);
  }
}

const SECTIONS = [
  ["/account", "Account"],
  ["/account/apps", "Connected apps"],
  ["/tokens", "Tokens"],
] as const;

/** A settings page: the section list on the left, the page on the right. */
export function settingsPage(c: C, view: View, here: string, title: string, body: Html, status: Status = 200) {
  return view(
    c,
    title,
    html`<div class="settings">
      <nav class="settings-nav" aria-label="Settings">
        ${SECTIONS.map(([href, label]) => html`<a href="${href}"${href === here ? raw(' aria-current="page"') : ""}>${label}</a>`)}
      </nav>
      <div class="settings-body"><h1>${title}</h1>${body}</div>
    </div>`,
    status,
  );
}

/**
 * Account pages (audit A3, D5): connected apps with revoke, password change, sign out everywhere,
 * delete project and delete account. Every form carries the CSRF token; destructive ones also need the
 * current password, and failed passwords count against the same per-account limit as sign-in.
 */
export function registerAccountRoutes(app: Hono<WebEnv>, deps: Deps, h: Helpers): void {
  const { db, config, service, limiter } = deps;
  const emailRule = { limit: config.signinEmailLimit, windowS: 15 * 60 };

  /** Returns an error message, or null when the password is right. */
  async function reauth(c: C, password: string): Promise<string | null> {
    const user = c.get("user")!;
    const key = `signin-email:${user.email.toLowerCase()}`;
    if ((await limiter.peek(key, emailRule)) !== null) return "Too many failed attempts. Wait a few minutes and try again.";
    if (await checkPassword(db, user.id, password)) return null;
    await limiter.hit(key, emailRule);
    return "That password is not right.";
  }

  const expired = (c: C, back: string) =>
    h.view(
      c,
      "This form expired",
      html`<div><p class="code">403</p><h1>This form expired</h1><p>Reload the page and try again.</p><div class="actions"><a class="btn" href="${back}">Go back</a></div></div>`,
      403,
      "status",
    );

  const DONE: Record<string, Flash> = {
    password: { kind: "ok", text: "Password changed. Every other browser was signed out." },
    "password-all": { kind: "ok", text: "Password changed. Every other browser was signed out, and every app and token was disconnected." },
    disconnected: { kind: "ok", text: "App disconnected. It has to be approved again to use your account." },
    "disconnected-all": { kind: "ok", text: "Every app was disconnected." },
  };

  async function accountPage(c: C, notice?: Flash, status: Status = 200) {
    const user = c.get("user")!;
    const usage = await service.usage(user.id);
    const pct = Math.min(100, Math.round((usage.bytes / usage.limits.maxBytesPerUser) * 100));
    return settingsPage(
      c,
      h.view,
      "/account",
      "Account",
      html`${flash(notice ?? DONE[c.req.query("done") ?? ""])}
        <section class="section">
          <div class="card row-card">
            ${deps.local
              ? html`<div>
                  <div class="label muted">Runs on this computer only</div>
                  <div class="item-title">No account. Your pages and tokens are in <code>${config.home}</code></div>
                </div>`
              : html`<div>
                  <div class="label muted">Signed in as</div>
                  <div class="item-title">${user.email}</div>
                </div>`}
            <form method="post" action="/signout">${h.csrfField(c)}<button type="submit" class="secondary btn-sm">${deps.local ? "Lock this browser" : "Sign out"}</button></form>
          </div>
        </section>

        <section class="section">
          <h2>Usage</h2>
          ${unlimited(usage.limits.maxBytesPerUser)
            ? html`<p>Nothing is limited on your own computer. This is what Anywhere is keeping.</p>
                <div class="card">
                  <div class="stats">
                    <div class="stat"><div class="label muted">Storage</div><div class="n">${bytes(usage.bytes)}</div></div>
                    <div class="stat"><div class="label muted">Projects</div><div class="n">${usage.projects}</div></div>
                  </div>
                  <p class="small muted">Storage counts every page plus the last ${usage.limits.revisionsKept} versions of each.</p>
                </div>`
            : html`          <p>Anywhere is free. These limits keep it that way for everyone.</p>
          <div class="card">
            <div class="stats">
              <div class="stat"><div class="label muted">Storage</div><div class="n">${bytes(usage.bytes)} <small>of ${bytes(usage.limits.maxBytesPerUser)}</small></div></div>
              <div class="stat"><div class="label muted">Projects</div><div class="n">${usage.projects} <small>of ${usage.limits.maxProjectsPerUser}</small></div></div>
            </div>
            <div class="meter" role="meter" aria-label="Storage used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${Math.max(pct, usage.bytes ? 1 : 0)}%"></span></div>
            <p class="small muted">Storage counts every page plus the last ${usage.limits.revisionsKept} versions of each. Each project can hold ${usage.limits.maxPagesPerProject} pages.</p>
          </div>`}
        </section>

        ${deps.local ? "" : html`<section class="section">
          <h2>Password</h2>
          <p>Changing it signs out every other browser.</p>
          <form method="post" action="/account/password" class="card">
            ${h.csrfField(c)}
            <div class="field"><label for="current">Current password</label><input id="current" type="password" name="current" autocomplete="current-password" required /></div>
            <div class="field"><label for="password">New password</label><input id="password" type="password" name="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required /><p class="hint">At least ${MIN_PASSWORD} characters.</p></div>
            <div class="field"><label for="confirm">New password again</label><input id="confirm" type="password" name="confirm" autocomplete="new-password" minlength="${MIN_PASSWORD}" required /></div>
            <div class="field"><label class="check"><input type="checkbox" name="disconnect" value="1" /> Also disconnect every app and revoke every token</label></div>
            <div class="form-actions"><button type="submit">Change password</button></div>
          </form>
        </section>`}

        <section class="section">
          <h2>Other browsers</h2>
          <div class="card row-card">
            <p class="muted" style="max-width:28rem">Signs out every browser where you are signed in, this one too. Connected apps and tokens keep working.</p>
            <form method="post" action="/account/signout-everywhere">${h.csrfField(c)}<button type="submit" class="secondary btn-sm">Sign out everywhere</button></form>
          </div>
        </section>

        ${deps.local ? html`<section class="section">
          <h2>Start over</h2>
          <div class="card"><p class="muted">Everything lives in <code>${config.home}</code>. Stop Anywhere and delete that folder to start from nothing. Download any project you want to keep first.</p></div>
        </section>` : html`<section class="section">
          <h2>Delete account</h2>
          <details class="reveal card danger-zone">
            <summary class="row-card">
              <p class="muted" style="max-width:28rem">Deletes your account, every project and page, their history, your tokens and connected apps. This cannot be undone.</p>
              <span class="btn btn-sm btn-danger">Delete account…</span>
            </summary>
            <form method="post" action="/account/delete" class="stack">
              ${h.csrfField(c)}
              <p>Everything goes, for you and every connected agent. Download any project you want to keep first.</p>
              <div class="field"><label for="del-email">Type your email to confirm</label><input id="del-email" type="email" name="email" autocomplete="off" required /></div>
              <div class="field"><label for="del-password">Password</label><input id="del-password" type="password" name="password" autocomplete="current-password" required /></div>
              <div class="form-actions"><button type="submit" class="btn-solid-danger">Delete my account</button></div>
            </form>
          </details>
        </section>`}`,
      status,
    );
  }

  async function appsPage(c: C) {
    const user = c.get("user")!;
    const grants = await listGrants(db, user.id);
    return settingsPage(
      c,
      h.view,
      "/account/apps",
      "Connected apps",
      html`${flash(DONE[c.req.query("done") ?? ""])}
        <p class="muted" style="margin-block-end:1.5rem;max-width:40rem">Apps you approved through sign-in. Each one can read, create, change and delete pages in all your projects. A connection ends by itself ${config.grantLifetimeDays} days after you approve it.</p>
        ${grants.length
          ? html`<ul class="list">
              ${grants.map(
                (g) => html`<li><div class="item">
                  ${appBadge(g.clientName)}
                  <div class="item-main">
                    <div class="item-title">${g.clientName ?? "Unnamed app"}</div>
                    <div class="meta">
                      <span>Returns to ${appTarget(g.redirectUris)}</span>
                      <span>Approved ${ago(new Date(g.createdAt).toISOString())}</span>
                      <span>${g.lastUsedAt ? html`Used ${ago(new Date(g.lastUsedAt).toISOString())}` : "Not used yet"}</span>
                      <span>Ends ${dateLabel(new Date(g.expiresAt).toISOString())}</span>
                    </div>
                  </div>
                  <div class="item-end">
                    <form method="post" action="/account/apps/${g.familyId}/revoke" data-confirm="Disconnect ${g.clientName ?? "this app"}?">
                      ${h.csrfField(c)}<button type="submit" class="btn-sm danger">Disconnect</button>
                    </form>
                  </div>
                </div></li>`,
              )}
            </ul>
            ${grants.length > 1
              ? html`<form method="post" action="/account/apps/revoke-all" class="form-actions" data-confirm="Disconnect every app?">${h.csrfField(c)}<button type="submit" class="btn-sm danger">Disconnect all</button></form>`
              : ""}`
          : html`<div class="empty"><h2>No connected apps</h2><p>Connect Claude, ChatGPT, Claude Code or Codex and it shows up here.</p><div class="actions"><a class="btn" href="/connect">Connect an agent</a></div></div>`}`,
    );
  }

  app.get("/account", async (c) => h.requireUser(c) ?? accountPage(c));
  app.get("/account/apps", async (c) => h.requireUser(c) ?? appsPage(c));

  app.post("/account/apps/revoke-all", async (c) => {
    const gate = h.requireUser(c);
    if (gate) return gate;
    const form = await c.req.parseBody();
    if (!csrfOk(c, form._csrf)) return expired(c, "/account/apps");
    await revokeAllGrants(db, c.get("user")!.id);
    return c.redirect("/account/apps?done=disconnected-all", 302);
  });

  app.post("/account/apps/:family/revoke", async (c) => {
    const gate = h.requireUser(c);
    if (gate) return gate;
    const form = await c.req.parseBody();
    if (!csrfOk(c, form._csrf)) return expired(c, "/account/apps");
    await revokeGrant(db, c.get("user")!.id, c.req.param("family"));
    return c.redirect("/account/apps?done=disconnected", 302);
  });

  app.post("/account/password", async (c) => {
    const gate = h.requireUser(c);
    if (gate) return gate;
    const form = await c.req.parseBody();
    if (!csrfOk(c, form._csrf)) return accountPage(c, { kind: "error", text: "This form expired. Try again." }, 403);
    const user = c.get("user")!;
    const error = await reauth(c, str(form.current));
    if (error) return accountPage(c, { kind: "error", text: error }, 400);
    const next = str(form.password);
    if (next !== str(form.confirm)) return accountPage(c, { kind: "error", text: "The two new passwords are different." }, 422);
    try {
      await setPassword(db, user.id, next);
    } catch (err) {
      if (err instanceof AppError) return accountPage(c, { kind: "error", text: err.message }, 422);
      throw err;
    }
    // Every session ends, this one included; this browser gets a fresh one.
    await deleteUserSessions(db, user.id);
    const all = str(form.disconnect) === "1";
    if (all) {
      await revokeAllGrants(db, user.id);
      await revokeAllPats(db, user.id);
    }
    const sid = await createSession(db, user.id);
    setSessionCookie(c, config, sid);
    return c.redirect(`/account?done=${all ? "password-all" : "password"}`, 302);
  });

  app.post("/account/signout-everywhere", async (c) => {
    const gate = h.requireUser(c);
    if (gate) return gate;
    const form = await c.req.parseBody();
    if (!csrfOk(c, form._csrf)) return expired(c, "/account");
    await deleteUserSessions(db, c.get("user")!.id);
    clearSessionCookie(c, config);
    return c.redirect("/signin", 302);
  });

  app.post("/account/delete", async (c) => {
    const gate = h.requireUser(c);
    if (gate) return gate;
    const form = await c.req.parseBody();
    if (!csrfOk(c, form._csrf)) return accountPage(c, { kind: "error", text: "This form expired. Try again." }, 403);
    const user = c.get("user")!;
    if (str(form.email).trim().toLowerCase() !== user.email.toLowerCase()) {
      return accountPage(c, { kind: "error", text: "Type your email exactly to delete the account." }, 422);
    }
    const error = await reauth(c, str(form.password));
    if (error) return accountPage(c, { kind: "error", text: error }, 400);
    await deleteUser(db, user.id);
    clearSessionCookie(c, config);
    c.set("user", null);
    return h.view(
      c,
      "Account deleted",
      html`<div class="auth-box">${mark(44)}<h1>Your account is deleted</h1><p class="lead">Every project, page, token and connection in it is gone.</p><a class="btn" href="/signup">Create a new account</a></div>`,
      200,
      "auth",
    );
  });

  // ---------- delete a project ----------

  async function deleteProjectPage(c: C, slug: string, error?: string, status: Status = 200) {
    const { project, pages } = await service.getProject(c.get("user")!.id, slug);
    return h.view(
      c,
      `Delete ${project.name}`,
      html`<div class="settings-body">
        <div class="crumbs"><a href="/projects">Projects</a> / <a href="/projects/${slug}">${project.name}</a> /</div>
        <div class="head"><div><h1>Delete ${project.name}?</h1><p>All ${pages.length} pages and their history are removed for you and every connected agent. This cannot be undone.</p></div></div>
        ${flash(error ? { kind: "error", text: error } : null)}
        <div class="card row-card" style="margin-block-end:1rem">
          <p class="muted">Want a copy first? The zip has every page as a markdown file.</p>
          <a class="btn btn-sm btn-quiet" href="/projects/${slug}/export.zip">${icon("download")} Download as zip</a>
        </div>
        <form method="post" action="/projects/${slug}/delete" class="card danger-zone">
          ${h.csrfField(c)}
          <div class="field"><label for="confirm">Type <span class="mono">${slug}</span> to confirm</label><input id="confirm" type="text" name="confirm" autocomplete="off" required /></div>
          ${deps.local ? "" : html`<div class="field"><label for="password">Your password</label><input id="password" type="password" name="password" autocomplete="current-password" required /></div>`}
          <div class="form-actions"><button type="submit" class="btn-solid-danger">Delete project</button><a class="btn btn-ghost" href="/projects/${slug}">Cancel</a></div>
        </form>
      </div>`,
      status,
    );
  }

  app.get("/projects/:slug/delete", async (c) => h.requireUser(c) ?? deleteProjectPage(c, c.req.param("slug")));

  app.post("/projects/:slug/delete", async (c) => {
    const gate = h.requireUser(c);
    if (gate) return gate;
    const form = await c.req.parseBody();
    const slug = c.req.param("slug");
    if (!csrfOk(c, form._csrf)) return deleteProjectPage(c, slug, "This form expired. Try again.", 403);
    const userId = c.get("user")!.id;
    const { project } = await service.getProject(userId, slug);
    if (str(form.confirm).trim() !== project.slug) return deleteProjectPage(c, slug, "Type the slug exactly to delete the project.", 422);
    // A local server has no password to ask for: the unlocked browser and the typed slug are the check.
    const error = deps.local ? null : await reauth(c, str(form.password));
    if (error) return deleteProjectPage(c, slug, error, 400);
    await service.deleteProject(userId, project.slug);
    return c.redirect("/projects", 302);
  });
}
