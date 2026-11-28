import type { Mail } from "./mailer.js";

/*
 * Every email Anywhere sends. Each has a plain-text body and an HTML body built from one layout:
 * inline styles only (mail clients drop style sheets), and a footer saying why it was sent.
 *
 * The only image is the mark beside the name at the top, loaded from this server's own
 * /assets/mark.png. It is the same file for every message, with nothing in its address about the
 * recipient, so it cannot tell anyone a message was opened; when a client blocks images, the name
 * still reads as text.
 */

export interface Brand {
  productName: string;
  appUrl: string;
  siteUrl: string;
  supportEmail: string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const INK = "#15181e";
const MUTED = "#5b6270";
const ACCENT = "#2a47d1";
const BORDER = "#dfe2e7";
const PAGE = "#f5f6f7";
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

interface Body {
  /** The line inbox previews show. */
  preheader: string;
  heading: string;
  paragraphs: string[];
  code?: string;
  /** Label and value rows shown in a box, such as when and where a change came from. */
  details?: [string, string][];
  button?: { label: string; url: string };
  /** Small print after the button: why this was sent, what to do if it was not you. */
  after: string[];
}

const host = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

function render(brand: Brand, to: string, subject: string, tag: string, b: Body): Mail {
  const help = brand.supportEmail ? ` Questions? Write to ${brand.supportEmail}.` : "";
  const footer = `This email was sent to ${to} by ${brand.productName} (${host(brand.appUrl)}).${help}`;
  const a = (href: string, label: string) => `<a href="${esc(href)}" style="color:${MUTED};text-decoration:underline">${esc(label)}</a>`;
  const links = [
    ...(brand.siteUrl && brand.siteUrl !== brand.appUrl ? [a(brand.siteUrl, host(brand.siteUrl))] : []),
    a(`${brand.appUrl}/account/security`, "Account security"),
    ...(brand.supportEmail ? [a(`mailto:${brand.supportEmail}`, brand.supportEmail)] : []),
  ].join(`<span style="color:${BORDER}">&nbsp;&nbsp;|&nbsp;&nbsp;</span>`);

  const text = [
    b.heading,
    "",
    ...b.paragraphs.flatMap((p) => [p, ""]),
    ...(b.code ? [b.code, ""] : []),
    ...(b.details?.length ? [...b.details.map(([k, v]) => `${k}: ${v}`), ""] : []),
    ...(b.button ? [`${b.button.label}: ${b.button.url}`, ""] : []),
    ...b.after.flatMap((p) => [p, ""]),
    "--",
    footer,
    `Account security: ${brand.appUrl}/account/security`,
  ].join("\n");

  const p = (s: string, color = INK, size = 16) => `<p style="margin:0 0 16px;font:${size}px/1.55 ${FONT};color:${color}">${esc(s)}</p>`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${PAGE}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(b.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAGE}"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px">
<tr><td style="padding:0 4px 20px"><a href="${esc(brand.siteUrl || brand.appUrl)}" style="text-decoration:none;color:${INK}"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="padding-right:10px;vertical-align:middle"><img src="${esc(brand.appUrl)}/assets/mark.png" width="26" height="26" alt="" style="display:block;border:0;width:26px;height:26px"></td><td style="vertical-align:middle;font:600 18px/1 ${FONT};letter-spacing:-0.01em;color:${INK}">${esc(brand.productName)}</td></tr></table></a></td></tr>
<tr><td style="background:#ffffff;border:1px solid ${BORDER};border-radius:12px;padding:32px 28px">
<h1 style="margin:0 0 16px;font:600 22px/1.3 ${FONT};color:${INK}">${esc(b.heading)}</h1>
${b.paragraphs.map((x) => p(x)).join("\n")}
${b.code ? `<p style="margin:8px 0 24px;font:600 34px/1 ui-monospace, SFMono-Regular, Menlo, monospace;letter-spacing:8px;color:${INK}">${esc(b.code)}</p>` : ""}
${b.details?.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 24px;background:${PAGE};border-radius:8px">${b.details.map(([k, v], i) => `<tr><td style="padding:${i ? 0 : 12}px 14px ${i === b.details!.length - 1 ? 12 : 6}px;width:84px;font:13px/1.5 ${FONT};color:${MUTED};vertical-align:top">${esc(k)}</td><td style="padding:${i ? 0 : 12}px 14px ${i === b.details!.length - 1 ? 12 : 6}px 0;font:14px/1.5 ${FONT};color:${INK}">${esc(v)}</td></tr>`).join("")}</table>` : ""}
${b.button ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px"><tr><td style="border-radius:8px;background:${ACCENT}"><a href="${esc(b.button.url)}" style="display:inline-block;padding:12px 20px;font:600 15px/1 ${FONT};color:#ffffff;text-decoration:none;border-radius:8px">${esc(b.button.label)}</a></td></tr></table>` : ""}
${b.after.map((x) => p(x, MUTED, 14)).join("\n")}
</td></tr>
<tr><td style="padding:20px 4px 0;font:12px/1.6 ${FONT};color:${MUTED}"><p style="margin:0 0 8px">${links}</p><p style="margin:0">${esc(footer)}</p></td></tr>
</table></td></tr></table>
</body></html>`;
  return { to, subject, text, html, tag };
}

export type CodePurpose = "signin" | "signup" | "reauth" | "change_email";

/** The six-digit code, and a link that does the same on any device. */
export function codeEmail(brand: Brand, to: string, purpose: CodePurpose, code: string, link: string, minutes: number): Mail {
  const n = brand.productName;
  const what = {
    signin: { subject: `Your ${n} sign-in code: ${code}`, heading: `Sign in to ${n}`, lead: "Enter this code in the browser where you asked to sign in.", button: `Sign in to ${n}` },
    signup: { subject: `Your ${n} code: ${code}`, heading: `Create your ${n} account`, lead: "Enter this code in the browser where you started, to confirm this is your email.", button: "Create my account" },
    reauth: { subject: `Your ${n} confirmation code: ${code}`, heading: "Confirm it's you", lead: "Enter this code to confirm a change to your account.", button: "" },
    change_email: { subject: `Confirm your new ${n} email: ${code}`, heading: "Confirm your new email", lead: `Enter this code in ${n} to use this address for your account.`, button: "" },
  }[purpose];
  return render(brand, to, what.subject, `code-${purpose}`, {
    preheader: `${code} is your code. It works for ${minutes} minutes.`,
    heading: what.heading,
    paragraphs: [what.lead],
    code,
    ...(what.button ? { button: { label: what.button, url: link } } : {}),
    after: [
      `The code works once, for ${minutes} minutes.${what.button ? " The button does the same on any device." : ""}`,
      "If you did not ask for this, you can ignore this email: nothing happens without the code.",
      `${n} will never ask for this code by phone, chat or in an agent.`,
    ],
  });
}

/** Someone asked to sign in with an address that has no account, while sign-ups are not open. */
export function noAccountEmail(brand: Brand, to: string, requestUrl: string): Mail {
  return render(brand, to, `About signing in to ${brand.productName}`, "no-account", {
    preheader: `There is no ${brand.productName} account for this address yet.`,
    heading: "There is no account for this email yet",
    paragraphs: [
      `Someone, probably you, asked to sign in to ${brand.productName} with this address, but it does not have an account.`,
      requestUrl ? `${brand.productName} is opening to people in waves. Request access and we will email you when your account is ready.` : "Ask the person who runs this server to approve your email.",
    ],
    ...(requestUrl ? { button: { label: "Request early access", url: requestUrl } } : {}),
    after: ["If this was not you, you can ignore this email."],
  });
}

export interface NoticeContext {
  when: Date;
  device: string;
  ip: string;
}

/** A change to the account its owner should know about, with where it came from and what to do. */
export function securityEmail(brand: Brand, to: string, subject: string, heading: string, lines: string[], ctx: NoticeContext | null, tag: string): Mail {
  const details: [string, string][] = ctx
    ? [["When", ctx.when.toUTCString()], ...(ctx.device ? [["Browser", ctx.device] as [string, string]] : []), ...(ctx.ip ? [["Network", ctx.ip] as [string, string]] : [])]
    : [];
  return render(brand, to, subject, tag, {
    preheader: lines[0] ?? heading,
    heading,
    paragraphs: lines,
    details,
    button: { label: "Review your account security", url: `${brand.appUrl}/account/security` },
    after: [
      "If this was you, there is nothing to do.",
      `If it was not, open the security page now: sign out every browser, disconnect apps you do not recognise and remove passkeys you did not add.${brand.supportEmail ? ` Then write to ${brand.supportEmail}.` : ""}`,
    ],
  });
}

/** The last email to an account: it is gone, and so is everything in it. */
export function deletedEmail(brand: Brand, to: string): Mail {
  return render(brand, to, `Your ${brand.productName} account was deleted`, "account-deleted", {
    preheader: "Your account and everything in it were deleted.",
    heading: "Your account is deleted",
    paragraphs: [
      `Your ${brand.productName} account, every project and page in it, their history, your tokens, passkeys and connected apps were deleted just now.`,
      "Agents that were connected can no longer read or write anything.",
    ],
    after: [`If you did not do this, write to ${brand.supportEmail || "the person who runs this server"} straight away.`],
  });
}
