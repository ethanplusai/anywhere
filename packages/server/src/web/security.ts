import type { Context, Hono } from "hono";
import { html } from "hono/html";
import { CODE_MINUTES, checkCode, pendingChallenge, startChallenge } from "../auth/email-codes.js";
import { eventLabel, listEvents } from "../auth/events.js";
import { authenticationOptions, deletePasskey, finishAuthentication, finishRegistration, listPasskeys, registrationOptions } from "../auth/passkeys.js";
import { deleteSessionByPublicId, isRecent, listSessions, markReauth } from "../auth/sessions.js";
import { changeEmail, checkEmail, findUserByEmail, getUserDetails, unlinkGithub } from "../auth/users.js";
import type { Deps } from "../deps.js";
import { exportZipStream } from "../export/zip.js";
import { codeEmail } from "../mail/templates.js";
import { AppError } from "../service/errors.js";
import type { Page } from "../service/projects.js";
import { notify, placeOf, sendQuietly } from "./notify.js";
import { ago, dateLabel, flash, icon, mark, type Flash, type Html } from "./render.js";
import { settingsPage, requireRecent } from "./account.js";
import { browserId, csrfOk, safeNext, type WebEnv } from "./session.js";
import { GITHUB_MARK } from "./signin.js";

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

const METHOD: Record<string, string> = { email: "Email code", github: "GitHub", passkey: "Passkey", local: "This computer" };

/**
 * The security page and everything behind it: passkeys, GitHub, signed-in browsers, recent account
 * activity, confirming it is you before a destructive change, changing the email address, and
 * downloading every project at once.
 */
export function registerSecurityRoutes(app: Hono<WebEnv>, deps: Deps, h: Helpers): void {
  const { db, config, limiter, service } = deps;
  if (deps.local) return;
  const authRule = { limit: config.authRateLimit, windowS: 60 };
  const sendRule = { limit: config.signinEmailLimit, windowS: 60 * 60 };

  const expired = (c: C, back: string) =>
    h.view(c, "This form expired", html`<div><p class="code">403</p><h1>This form expired</h1><p>Reload the page and try again.</p><div class="actions"><a class="btn" href="${back}">Go back</a></div></div>`, 403, "status");

  const DONE: Record<string, Flash> = {
    passkey: { kind: "ok", text: "Passkey added. You can use it to sign in and to confirm changes." },
    "passkey-removed": { kind: "ok", text: "Passkey removed." },
    github: { kind: "ok", text: "GitHub linked. You can sign in with it now." },
    "github-removed": { kind: "ok", text: "GitHub unlinked." },
    session: { kind: "ok", text: "That browser was signed out." },
    email: { kind: "ok", text: "Email changed. Codes and notices go to the new address from now on; the old one was told." },
  };

  // ---------- the page ----------

  app.get("/account/security", async (c) => {
    const gate = h.requireUser(c);
    if (gate) return gate;
    const user = c.get("user")!;
    const [details, passkeys, sessions, events] = await Promise.all([getUserDetails(db, user.id), listPasskeys(db, user.id), listSessions(db, user.id), listEvents(db, user.id, 30)]);
    const here = c.get("session")?.publicId;
    const csrf = c.get("csrf");
    return settingsPage(
      c,
      h.view,
      "/account/security",
      "Security",
      html`${flash(DONE[c.req.query("done") ?? ""] ?? null)}
        <section class="section">
          <h2>Ways to sign in</h2>
          <ul class="list">
            <li><div class="item">${icon("mail")}<div class="item-main"><div class="item-title">Email code</div><div class="item-sub">${user.email}</div></div>
              <div class="item-end"><a class="btn btn-sm btn-quiet" href="/account/email">Change email</a></div></div></li>
            ${config.github
              ? html`<li><div class="item">${GITHUB_MARK}<div class="item-main"><div class="item-title">GitHub</div><div class="item-sub">${details?.githubLogin ? `@${details.githubLogin}` : "Not linked"}</div></div>
                  <div class="item-end">${details?.githubId
                    ? html`<form method="post" action="/account/security/github/unlink" data-confirm="Unlink GitHub? You can still sign in with email.">${h.csrfField(c)}<button type="submit" class="btn-sm danger">Unlink</button></form>`
                    : html`<a class="btn btn-sm btn-quiet" href="/auth/github?link=1">Link GitHub</a>`}</div></div></li>`
              : ""}
          </ul>
        </section>

        <section class="section">
          <h2>Passkeys</h2>
          <p class="muted" style="max-width:40rem">A passkey signs you in with your fingerprint, face or device PIN, with no email to wait for. It is also how you confirm changes like deleting a project.</p>
          ${passkeys.length
            ? html`<ul class="list">${passkeys.map(
                (p) => html`<li><div class="item">${icon("key")}<div class="item-main"><div class="item-title">${p.name}</div>
                  <div class="meta"><span>Added ${ago(new Date(p.createdAt).toISOString())}</span><span>${p.lastUsedAt ? html`Used ${ago(new Date(p.lastUsedAt).toISOString())}` : "Not used yet"}</span></div></div>
                  <div class="item-end"><form method="post" action="/account/security/passkeys/${p.id}/delete" data-confirm="Remove the passkey “${p.name}”?">${h.csrfField(c)}<button type="submit" class="btn-sm danger">Remove</button></form></div></div></li>`,
              )}</ul>`
            : ""}
          <div class="form-actions" style="margin-block-start:1rem">
            <button type="button" class="secondary" data-passkey="register" data-csrf="${csrf}">Add a passkey</button>
          </div>
          <p class="error-inline" data-passkey-error role="alert" hidden></p>
          <p class="hint" data-passkey-unsupported hidden>This browser cannot make passkeys.</p>
        </section>

        <section class="section">
          <h2>Signed-in browsers</h2>
          <ul class="list">${sessions.map(
            (s) => html`<li><div class="item">${icon("monitor")}<div class="item-main"><div class="item-title">${s.device || "Unknown browser"} ${s.publicId === here ? html`<span class="tag">This browser</span>` : ""}</div>
              <div class="meta"><span>${METHOD[s.method] ?? s.method}</span>${s.ip ? html`<span>${s.ip}</span>` : ""}<span>Signed in ${ago(new Date(s.createdAt).toISOString())}</span><span>Active ${ago(new Date(s.lastSeenAt).toISOString())}</span></div></div>
              <div class="item-end">${s.publicId === here ? "" : html`<form method="post" action="/account/security/sessions/${s.publicId}/revoke">${h.csrfField(c)}<button type="submit" class="btn-sm danger">Sign out</button></form>`}</div></div></li>`,
          )}</ul>
          <form method="post" action="/account/signout-everywhere" class="form-actions" style="margin-block-start:1rem" data-confirm="Sign out every browser, this one too?">${h.csrfField(c)}<button type="submit" class="btn-sm secondary">Sign out everywhere</button></form>
        </section>

        <section class="section">
          <h2>Recent activity</h2>
          ${events.length
            ? html`<ul class="list compact">${events.map(
                (e) => html`<li><div class="item"><div class="item-main"><div class="item-title">${eventLabel(e)}</div>
                  <div class="meta"><span>${dateLabel(new Date(e.createdAt).toISOString())}, ${new Date(e.createdAt).toISOString().slice(11, 16)} UTC</span>${e.device ? html`<span>${e.device}</span>` : ""}${e.ip ? html`<span>${e.ip}</span>` : ""}</div></div></div></li>`,
              )}</ul>`
            : html`<p class="muted">Nothing yet.</p>`}
          <p class="small muted" style="margin-block-start:0.75rem">Something here that was not you? Sign out every browser, remove passkeys and apps you do not recognise${deps.brand.supportEmail ? `, and write to ${deps.brand.supportEmail}` : ""}.</p>
        </section>

        <section class="section">
          <h2>Your data</h2>
          <div class="card row-card">
            <p class="muted" style="max-width:28rem">Every project as markdown files in one zip.</p>
            <a class="btn btn-sm btn-quiet" href="/account/export.zip">${icon("download")} Download everything</a>
          </div>
        </section>`,
    );
  });

  // ---------- confirm it is you ----------

  app.get("/account/confirm", async (c) => {
    const gate = h.requireUser(c);
    if (gate) return gate;
    const next = safeNext(c.req.query("next"));
    if (isRecent(c.get("session"))) return c.redirect(next, 302);
    return confirmPage(c, next);
  });

  async function confirmPage(c: C, next: string, opts: { error?: string; sent?: boolean; status?: Status } = {}) {
    c.header("Cache-Control", "no-store");
    const user = c.get("user")!;
    const passkeys = await listPasskeys(db, user.id);
    const pending = opts.sent || (await pendingChallenge(db, browserId(c, config), "reauth"));
    return h.view(
      c,
      "Confirm it's you",
      html`<div class="auth-box">${mark(44)}
        <h1>Confirm it's you</h1>
        <p class="lead">This change needs you to have signed in in the last ten minutes.</p>
        ${flash(opts.error ? { kind: "error", text: opts.error } : null)}
        <div class="card stack">
          ${passkeys.length ? html`<button type="button" class="btn-wide" data-passkey="reauth" data-csrf="${c.get("csrf")}" data-next="${next}">Use a passkey</button><p class="or"><span>or</span></p>` : ""}
          ${pending
            ? html`<form method="post" action="/account/confirm/code" class="stack">${h.csrfField(c)}<input type="hidden" name="next" value="${next}" />
                <div class="field"><label for="code">Code sent to ${user.email}</label><input id="code" type="text" class="code-input" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required autofocus /></div>
                <div class="form-actions"><button type="submit" class="btn-wide">Confirm</button></div></form>`
            : html`<form method="post" action="/account/confirm/send">${h.csrfField(c)}<input type="hidden" name="next" value="${next}" />
                <div class="form-actions"><button type="submit" class="btn-wide ${passkeys.length ? "secondary" : ""}">Email me a code</button></div></form>`}
          <p class="error-inline" data-passkey-error role="alert" hidden></p>
        </div>
        <p class="after"><a href="${next.startsWith("/account") ? "/account" : "/projects"}">Cancel</a></p>
      </div>`,
      opts.status ?? 200,
      "auth",
    );
  }

  app.post("/account/confirm/send", async (c) => {
    const gate = h.requireUser(c);
    if (gate) return gate;
    const form = await c.req.parseBody();
    const next = safeNext(form.next);
    if (!csrfOk(c, form._csrf)) return expired(c, "/account");
    const user = c.get("user")!;
    if ((await limiter.hit(`email-send:${user.email.toLowerCase()}`, sendRule)) !== null) return confirmPage(c, next, { error: "We have sent several codes in the last hour. Use the newest one, or wait a while.", status: 429 });
    const { code, link } = await startChallenge(db, { purpose: "reauth", email: user.email, userId: user.id, browser: browserId(c, config), next });
    if (!(await sendQuietly(deps, codeEmail(deps.brand, user.email, "reauth", code, link, CODE_MINUTES)))) return confirmPage(c, next, { error: "We could not send the email just now. Try again in a minute.", status: 400 });
    return confirmPage(c, next, { sent: true });
  });

  app.post("/account/confirm/code", async (c) => {
    const gate = h.requireUser(c);
    if (gate) return gate;
    const form = await c.req.parseBody();
    const next = safeNext(form.next);
    if (!csrfOk(c, form._csrf)) return expired(c, "/account");
    if ((await limiter.hit(`auth:${c.get("user")!.id}`, authRule)) !== null) return confirmPage(c, next, { error: "Too many attempts. Wait a minute.", sent: true, status: 429 });
    const result = await checkCode(db, browserId(c, config), "reauth", str(form.code).slice(0, 16));
    if (!result.ok || result.challenge.userId !== c.get("user")!.id) {
      const error = !result.ok && result.reason === "wrong" ? `That code is not right. ${result.left} ${result.left === 1 ? "try" : "tries"} left.` : "That code expired. Ask for a new one.";
      return confirmPage(c, next, { error, sent: !result.ok && result.reason === "wrong", status: 400 });
    }
    await markReauth(db, c.get("sid")!);
    return c.redirect(next, 302);
  });

  // ---------- passkeys: JSON endpoints for /assets/app.js ----------

  const jsonCsrf = (c: C) => csrfOk(c, c.req.header("x-csrf-token"));
  async function jsonBody(c: C): Promise<Record<string, unknown> | null> {
    try {
      const v = (await c.req.json()) as unknown;
      return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  const signedOut = (c: C) => c.json({ error: "You are signed out. Reload the page." }, 403);

  app.post("/passkeys/register/options", async (c) => {
    const user = c.get("user");
    if (!user || !jsonCsrf(c)) return signedOut(c);
    if (!isRecent(c.get("session"))) return c.json({ confirm: `/account/confirm?next=${encodeURIComponent("/account/security")}` }, 403);
    return c.json(await registrationOptions(db, deps.rp, user, browserId(c, config)));
  });

  app.post("/passkeys/register/verify", async (c) => {
    const user = c.get("user");
    if (!user || !jsonCsrf(c)) return signedOut(c);
    if (!isRecent(c.get("session"))) return c.json({ error: "Confirm it is you first." }, 403);
    const result = await finishRegistration(db, deps.rp, user.id, browserId(c, config), await jsonBody(c), placeOf(c, deps).device);
    if (!result.ok) return c.json({ error: result.error }, 400);
    await notify(deps, c, user, "passkey_added", result.name);
    return c.json({ redirect: "/account/security?done=passkey" });
  });

  app.post("/passkeys/reauth/options", async (c) => {
    const user = c.get("user");
    if (!user || !jsonCsrf(c)) return signedOut(c);
    const body = (await jsonBody(c)) ?? {};
    return c.json(await authenticationOptions(db, deps.rp, browserId(c, config), { userId: user.id, next: safeNext(body.next) }));
  });

  app.post("/passkeys/reauth/verify", async (c) => {
    const user = c.get("user");
    if (!user || !jsonCsrf(c)) return signedOut(c);
    const result = await finishAuthentication(db, deps.rp, browserId(c, config), "reauth", await jsonBody(c));
    if (!result.ok || result.userId !== user.id) return c.json({ error: result.ok ? "That passkey is not on this account." : result.error }, 400);
    await markReauth(db, c.get("sid")!);
    return c.json({ redirect: result.next });
  });

  app.post("/account/security/passkeys/:id/delete", async (c) => {
    const gate = h.requireUser(c);
    if (gate) return gate;
    const form = await c.req.parseBody();
    if (!csrfOk(c, form._csrf)) return expired(c, "/account/security");
    const stale = requireRecent(c, deps, "/account/security");
    if (stale) return stale;
    const name = await deletePasskey(db, c.get("user")!.id, c.req.param("id"));
    if (name !== null) await notify(deps, c, c.get("user")!, "passkey_removed", name);
    return c.redirect("/account/security?done=passkey-removed", 302);
  });

  app.post("/account/security/github/unlink", async (c) => {
    const gate = h.requireUser(c);
    if (gate) return gate;
    const form = await c.req.parseBody();
    if (!csrfOk(c, form._csrf)) return expired(c, "/account/security");
    const stale = requireRecent(c, deps, "/account/security");
    if (stale) return stale;
    await unlinkGithub(db, c.get("user")!.id);
    await notify(deps, c, c.get("user")!, "github_unlinked");
    return c.redirect("/account/security?done=github-removed", 302);
  });

  app.post("/account/security/sessions/:id/revoke", async (c) => {
    const gate = h.requireUser(c);
    if (gate) return gate;
    const form = await c.req.parseBody();
    if (!csrfOk(c, form._csrf)) return expired(c, "/account/security");
    const sessions = await listSessions(db, c.get("user")!.id);
    const target = sessions.find((s) => s.publicId === c.req.param("id"));
    if (target && (await deleteSessionByPublicId(db, c.get("user")!.id, target.publicId))) {
      await notify(deps, c, c.get("user")!, "session_ended", target.device, { email: false });
    }
    return c.redirect("/account/security?done=session", 302);
  });

  // ---------- change email ----------

  async function emailPage(c: C, opts: { error?: string; email?: string; status?: Status } = {}) {
    c.header("Cache-Control", "no-store");
    const pending = await pendingChallenge(db, browserId(c, config), "change_email");
    return settingsPage(
      c,
      h.view,
      "/account/security",
      "Change email",
      html`${flash(opts.error ? { kind: "error", text: opts.error } : null)}
        ${pending
          ? html`<form method="post" action="/account/email/code" class="card" style="max-width:28rem">${h.csrfField(c)}
              <p>We sent a code to <strong>${pending.email}</strong>. Enter it to switch to that address.</p>
              <div class="field"><label for="code">Code</label><input id="code" type="text" class="code-input" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required autofocus /></div>
              <div class="form-actions"><button type="submit">Change email</button><a class="btn btn-ghost" href="/account/security">Cancel</a></div></form>`
          : html`<form method="post" action="/account/email" class="card" style="max-width:28rem">${h.csrfField(c)}
              <p class="muted">Now: ${c.get("user")!.email}. We send a code to the new address to make sure it is yours, and tell the old one.</p>
              <div class="field"><label for="email">New email</label><input id="email" type="email" name="email" autocomplete="email" required maxlength="254" value="${opts.email ?? ""}" autofocus /></div>
              <div class="form-actions"><button type="submit">Send code</button><a class="btn btn-ghost" href="/account/security">Cancel</a></div></form>`}`,
      opts.status ?? 200,
    );
  }

  app.get("/account/email", async (c) => h.requireUser(c) ?? requireRecent(c, deps, "/account/email") ?? emailPage(c));

  app.post("/account/email", async (c) => {
    const gate = h.requireUser(c);
    if (gate) return gate;
    const form = await c.req.parseBody();
    if (!csrfOk(c, form._csrf)) return expired(c, "/account/email");
    const stale = requireRecent(c, deps, "/account/email");
    if (stale) return stale;
    const user = c.get("user")!;
    let email: string;
    try {
      email = checkEmail(str(form.email).slice(0, 320));
    } catch (err) {
      return emailPage(c, { error: (err as AppError).message, email: str(form.email), status: 422 });
    }
    if (email.toLowerCase() === user.email.toLowerCase()) return emailPage(c, { error: "That is already your email.", email, status: 422 });
    if (await findUserByEmail(db, email)) return emailPage(c, { error: "Another account already uses that email.", email, status: 409 });
    if ((await limiter.hit(`email-send:${email.toLowerCase()}`, sendRule)) !== null) return emailPage(c, { error: "We have sent several codes to that address. Wait a while and try again.", email, status: 429 });
    const { code, link } = await startChallenge(db, { purpose: "change_email", email, userId: user.id, browser: browserId(c, config), next: "/account/security" });
    if (!(await sendQuietly(deps, codeEmail(deps.brand, email, "change_email", code, link, CODE_MINUTES)))) return emailPage(c, { error: "We could not send the email just now. Try again in a minute.", email, status: 400 });
    return c.redirect("/account/email", 303);
  });

  app.post("/account/email/code", async (c) => {
    const gate = h.requireUser(c);
    if (gate) return gate;
    const form = await c.req.parseBody();
    if (!csrfOk(c, form._csrf)) return expired(c, "/account/email");
    const user = c.get("user")!;
    if ((await limiter.hit(`auth:${user.id}`, authRule)) !== null) return emailPage(c, { error: "Too many attempts. Wait a minute.", status: 429 });
    const result = await checkCode(db, browserId(c, config), "change_email", str(form.code).slice(0, 16));
    if (!result.ok || result.challenge.userId !== user.id) {
      return emailPage(c, { error: !result.ok && result.reason === "wrong" ? `That code is not right. ${result.left} ${result.left === 1 ? "try" : "tries"} left.` : "That code expired. Start again.", status: 400 });
    }
    try {
      await changeEmail(db, user.id, result.challenge.email);
    } catch (err) {
      if (err instanceof AppError) return emailPage(c, { error: err.message, status: 409 });
      throw err;
    }
    // The old address hears about it: if this was not its owner, that is how they find out.
    await notify(deps, c, user, "email_changed", result.challenge.email, { to: user.email });
    return c.redirect("/account/security?done=email", 302);
  });

  // ---------- everything as one zip ----------

  app.get("/account/export.zip", async (c) => {
    const gate = h.requireUser(c);
    if (gate) return gate;
    const stale = requireRecent(c, deps, "/account/export.zip");
    if (stale) return stale;
    const user = c.get("user")!;
    const projects = await service.listProjects(user.id);
    let total = 0;
    for (const p of projects) total += (await service.exportSize(user.id, p.slug)).bytes;
    if (total > config.limits.maxExportBytes) {
      return h.view(c, "Too large to download at once", html`<div><h1>Too large to download at once</h1><p>Your projects hold more than ${Math.round(config.limits.maxExportBytes / 1048576)} MB. Download them one at a time from each project page.</p><div class="actions"><a class="btn" href="/projects">Your projects</a></div></div>`, 422, "status");
    }
    await notify(deps, c, user, "export", "", { email: false });
    async function* all(): AsyncGenerator<Page> {
      for (const p of projects) for await (const page of service.iteratePages(user.id, p.slug)) yield { ...page, path: `${p.slug}/${page.path}` };
    }
    const day = new Date().toISOString().slice(0, 10);
    return c.body(exportZipStream(`anywhere-${day}`, all()), 200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="anywhere-${day}.zip"`,
      "Cache-Control": "private, no-store",
    });
  });
}
