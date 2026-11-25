import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { Marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { AGENT_LOGOS } from "./logos.generated.js";
import { STYLE } from "./style.js";

export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

// ---------- icons (24 grid, stroked) ----------

const ICONS: Record<string, string> = {
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
  page: '<path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20Z"/><path d="M14 3.5V8h4"/><path d="M9.5 12.5h5M9.5 15.5h5"/>',
  topic: '<path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20Z"/><path d="M14 3.5V8h4"/><path d="M10 14h4M12 12v4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M4.5 19.5h4l10-10a2.1 2.1 0 0 0-4-4l-10 10Z"/><path d="m13.5 6.5 4 4"/>',
  history: '<path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5"/><path d="M4 4v4.5h4.5"/><path d="M12 8v4.2l2.8 1.8"/>',
  download: '<path d="M12 4v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M5 19.5h14"/>',
  trash: '<path d="M4.5 7h15"/><path d="M9.5 7V4.5h5V7"/><path d="M6.5 7l.8 12.2a1 1 0 0 0 1 .8h7.4a1 1 0 0 0 1-.8L17.5 7"/>',
  back: '<path d="M19 12H5"/><path d="m11 6-6 6 6 6"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
  alert: '<path d="M12 4 3 19.5h18Z"/><path d="M12 10v4.5M12 17h.01"/>',
  restore: '<path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5"/><path d="M4 4v4.5h4.5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  key: '<circle cx="8" cy="15" r="3.5"/><path d="m10.5 12.5 8-8M16 7l2.5 2.5"/>',
  read: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.5"/>',
  write: '<path d="M4.5 19.5h4l10-10a2.1 2.1 0 0 0-4-4l-10 10Z"/>',
  shield: '<path d="M12 3.5 5 6v5.5c0 4.2 3 7.6 7 9 4-1.4 7-4.8 7-9V6Z"/><path d="m9 12 2 2 4-4"/>',
};

export function icon(name: keyof typeof ICONS | string): HtmlEscapedString {
  return raw(`<svg class="i" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name] ?? ""}</svg>`) as HtmlEscapedString;
}

/** The Anywhere mark from the website: three stacked pages, the top one in cobalt. */
export function mark(size = 26): HtmlEscapedString {
  return raw(
    `<svg class="mark" width="${size}" height="${size}" viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false"><g stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M16 15.2 28 21.6 16 28 4 21.6Z" fill="var(--color-page)"/><path d="M16 9.6 28 16 16 22.4 4 16Z" fill="var(--color-page)"/><path d="M16 4 28 10.4 16 16.8 4 10.4Z" fill="var(--color-accent-solid)"/></g></svg>`,
  ) as HtmlEscapedString;
}

export function logo(id: string): HtmlEscapedString | "" {
  const paths = AGENT_LOGOS[id];
  if (!paths) return "";
  return raw(
    `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths.map((d) => `<path d="${d}" fill-rule="evenodd" clip-rule="evenodd"/>`).join("")}</svg>`,
  ) as HtmlEscapedString;
}

// ---------- who changed what ----------

/** Which known agent a recorded app or token name looks like, for its logo. */
function logoFor(name: string): string | null {
  const n = name.toLowerCase();
  if (n.includes("claude code") || n.includes("claude-code")) return "claudecode";
  if (n.includes("claude")) return "claude";
  if (n.includes("chatgpt") || n.includes("openai")) return "openai";
  if (n.includes("codex")) return "codex";
  if (n.includes("cursor")) return "cursor";
  return null;
}

export function actorName(actor: string | null): string {
  if (!actor) return "Unknown";
  if (actor === "web") return "You";
  if (actor === "anywhere") return "Anywhere";
  if (actor.startsWith("app:")) return actor.slice(4) || "Unnamed app";
  if (actor.startsWith("token:")) return `Token “${actor.slice(6)}”`;
  return actor;
}

/** A small label for who made a change: a logo for known agents, an initial otherwise. */
export function who(actor: string | null): HtmlEscapedString {
  const name = actorName(actor);
  if (actor === "web") return html`<span class="who you"><span class="dot">Y</span>You</span>` as HtmlEscapedString;
  const id = actor?.startsWith("app:") ? logoFor(name) : actor?.startsWith("token:") ? "mcp" : null;
  const badge = id ? logo(id) : html`<span class="dot">${name.slice(0, 1).toUpperCase()}</span>`;
  return html`<span class="who">${badge}${name}</span>` as HtmlEscapedString;
}

/** A square badge for a connected app: its logo when it is a known agent, its initial otherwise. */
export function appBadge(name: string | null): HtmlEscapedString {
  const label = name ?? "Unnamed app";
  const id = logoFor(label);
  return html`<span class="app-badge" aria-hidden="true">${id ? logo(id) : label.slice(0, 1).toUpperCase()}</span>` as HtmlEscapedString;
}

export function verb(via: string, deleted: boolean, version: number): string {
  if (deleted || via === "delete") return "deleted";
  if (via === "append") return "added to";
  return version === 1 ? "created" : "edited";
}

// ---------- time ----------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function dateLabel(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function agoText(iso: string, now = Date.now()): string {
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "yesterday";
  if (d < 14) return `${d} days ago`;
  return dateLabel(iso);
}

/** A relative time with the exact UTC time on hover. */
export function ago(iso: string): HtmlEscapedString {
  const exact = `${iso.replace("T", " ").slice(0, 16)} UTC`;
  return html`<time datetime="${iso}" title="${exact}">${agoText(iso)}</time>` as HtmlEscapedString;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 102.4) / 10} KB`;
  return `${Math.round(n / (1024 * 102.4)) / 10} MB`;
}

// ---------- small components ----------

export function copyField(value: string, label = "Copy"): HtmlEscapedString {
  return html`<div class="copy"><code>${value}</code><button type="button" data-copy="${value}" aria-label="${label}: ${value}">Copy</button></div>` as HtmlEscapedString;
}

export type Flash = { kind: "ok" | "error" | "notice"; text: string | Html };

export function flash(f: Flash | null | undefined): HtmlEscapedString | "" {
  if (!f) return "";
  const ic = f.kind === "error" ? icon("alert") : f.kind === "ok" ? icon("check") : icon("info");
  return html`<div class="${f.kind} flash" role="${f.kind === "error" ? "alert" : "status"}">${ic}<div>${f.text}</div></div>` as HtmlEscapedString;
}

/** Search snippets mark matches with ** pairs; everything else is escaped. */
export function snippet(text: string): HtmlEscapedString {
  const parts = text.replace(/(^|\s)(#{1,6}|[-*]|\d+\.)\s/g, "$1").replace(/\s+/g, " ").split("**");
  return html`${parts.map((p, i) => (i % 2 ? html`<mark>${p}</mark>` : p))}` as HtmlEscapedString;
}

// ---------- line diff ----------

type Op = { s: " " | "+" | "-"; line: string };

/** A line diff by longest common subsequence. Null when the pages are too long to compare cheaply. */
export function lineDiff(before: string, after: string): Op[] | null {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  if (n * m > 4_000_000) return null;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[start + i] === b[start + j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: Op[] = a.slice(0, start).map((line) => ({ s: " ", line }));
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) {
      ops.push({ s: " ", line: a[start + i]! });
      i++;
      j++;
    } else if (j < m && (i >= n || dp[i]![j + 1]! >= dp[i + 1]![j]!)) {
      ops.push({ s: "+", line: b[start + j]! });
      j++;
    } else {
      ops.push({ s: "-", line: a[start + i]! });
      i++;
    }
  }
  for (const line of a.slice(endA)) ops.push({ s: " ", line });
  return ops;
}

export function renderDiff(ops: Op[], context = 3): HtmlEscapedString {
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, k) => {
    if (op.s === " ") return;
    for (let x = Math.max(0, k - context); x <= Math.min(ops.length - 1, k + context); x++) keep[x] = true;
  });
  const rows: (HtmlEscapedString | Promise<HtmlEscapedString>)[] = [];
  let hidden = 0;
  ops.forEach((op, k) => {
    if (!keep[k]) {
      hidden++;
      return;
    }
    if (hidden) rows.push(html`<div class="gap">${hidden} unchanged line${hidden === 1 ? "" : "s"}</div>`);
    hidden = 0;
    const cls = op.s === "+" ? "add" : op.s === "-" ? "del" : "";
    rows.push(html`<div class="${cls}" data-s="${op.s === " " ? "" : op.s}">${op.line || " "}</div>`);
  });
  if (hidden) rows.push(html`<div class="gap">${hidden} unchanged line${hidden === 1 ? "" : "s"}</div>`);
  return html`<div class="diff" role="table" aria-label="Changes">${rows}</div>` as HtmlEscapedString;
}

// ---------- the page shell ----------

const NAV = [
  ["/projects", "Projects"],
  ["/connect", "Connect"],
  ["/account", "Settings"],
] as const;

const SETTINGS_PATHS = ["/account", "/tokens"];

export interface LayoutOptions {
  user?: { email: string } | null;
  csrf?: string;
  path?: string;
  /** "app" (default) has padded main content, "flush" lets the body lay out its own columns, "auth" centres one form. */
  kind?: "app" | "flush" | "auth" | "status";
  query?: string;
  /** False when the server takes no new accounts, so no page offers to create one. */
  signups?: boolean;
  /** The public website, for the footer links. */
  siteUrl?: string;
}

export function layout(title: string, body: Html, opts: LayoutOptions = {}): Html {
  const here = opts.path ?? "";
  const isCurrent = (href: string) =>
    href === "/account" ? SETTINGS_PATHS.some((p) => here === p || here.startsWith(`${p}/`)) : here === href || here.startsWith(`${href}/`) || (href === "/projects" && here === "/search");
  const current = (href: string) => (isCurrent(href) ? raw(` aria-current="page"`) : "");
  const signedIn = !!opts.user;
  const nav = signedIn ? html`<nav aria-label="Main">${NAV.map(([href, label]) => html`<a href="${href}"${current(href)}>${label}</a>`)}</nav>` : "";
  const end = signedIn
    ? html`<form class="bar-search" role="search" action="/search" method="get">
          ${icon("search")}<label class="sr" for="bar-q">Search all projects</label>
          <input id="bar-q" type="search" name="q" placeholder="Search pages" value="${opts.query ?? ""}" autocomplete="off" />
        </form>
        <a class="bar-search-link" href="/search" aria-label="Search">${icon("search")}</a>`
    : here === "/signin"
      ? opts.signups === false
        ? ""
        : html`<a class="bar-link" href="/signup">Create an account</a>`
      : html`<a class="bar-link" href="/signin">Sign in</a>`;
  const kind = opts.kind ?? "app";
  const site = opts.siteUrl ?? "https://anywr.ai";
  const main =
    kind === "auth"
      ? html`<main id="main" class="flush"><div class="auth">${body}</div></main>`
      : kind === "status"
        ? html`<main id="main" class="flush"><div class="status">${body}</div></main>`
        : kind === "flush"
          ? html`<main id="main" class="flush">${body}</main>`
          : html`<main id="main">${body}</main>`;
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="referrer" content="same-origin" />
        <meta name="color-scheme" content="light dark" />
        <title>${title} · Anywhere</title>
        <link rel="preload" href="/assets/geist.woff2" as="font" type="font/woff2" crossorigin />
        <style>
          ${raw(STYLE)}
        </style>
        <script src="/assets/app.js" defer></script>
      </head>
      <body>
        <a class="skip" href="#main">Skip to content</a>
        <div class="frame">
          <header class="bar">
            <a class="brand" href="${signedIn ? "/projects" : "/"}">${mark()}<span>Anywhere</span></a>
            ${nav}
            <div class="bar-end">${end}</div>
          </header>
          ${main}
          <footer class="foot">
            <span>Anywhere is free and open source under the MIT licence.</span>
            <nav aria-label="Footer">
              ${signedIn ? html`<a href="/welcome">Get started</a><a href="/connect">Connect an agent</a>` : ""}
              <a href="${site}/docs" rel="noopener">Docs</a>
              <a href="${site}/security" rel="noopener">Security</a>
              <a href="${site}/privacy" rel="noopener">Privacy</a>
              <a href="${site}/terms" rel="noopener">Terms</a>
            </nav>
          </footer>
        </div>
      </body>
    </html>`;
}

/** The one script: copy buttons and Cmd/Ctrl+S to save in the editor. Served from /assets/app.js. */
export const APP_JS = `
document.addEventListener("click", function (e) {
  var b = e.target.closest("[data-copy]");
  if (!b) return;
  navigator.clipboard.writeText(b.getAttribute("data-copy")).then(function () {
    var t = b.textContent; b.textContent = "Copied"; b.setAttribute("data-copied", "");
    setTimeout(function () { b.textContent = t; b.removeAttribute("data-copied"); }, 1600);
  });
});
document.addEventListener("keydown", function (e) {
  if ((e.metaKey || e.ctrlKey) && e.key === "s") {
    var f = document.querySelector("form[data-save]");
    if (f) { e.preventDefault(); f.requestSubmit(); }
  }
  if (e.key === "/" && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
    var q = document.getElementById("bar-q");
    if (q && q.offsetParent) { e.preventDefault(); q.focus(); }
  }
});
(function () {
  var box = document.querySelector("[data-unlock]");
  var m = /^#token=([A-Za-z0-9_-]+)$/.exec(location.hash);
  if (!box || !m) return;
  history.replaceState(null, "", location.pathname + location.search);
  var form = document.getElementById("unlock-form");
  form.querySelector("#token").value = m[1];
  form.submit();
})();
document.addEventListener("submit", function (e) {
  var m = e.target.getAttribute("data-confirm");
  if (m && !window.confirm(m)) e.preventDefault();
});
`;

// ---------- markdown ----------

const marked = new Marked({ gfm: true, breaks: false });

/** How long the parser may spend on one page. A full 256 KiB page of ordinary markdown needs under half of this. */
const RENDER_MS = 1000;
/** Formatted pages kept by content hash, most recently used last; `null` marks a page that ran out of time. */
const rendered = new Map<string, string | null>();
const RENDERED_MAX = 200;
const RENDERED_MAX_CHARS = 128 * 1024;

const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const asWritten = (markdown: string) =>
  `<p><em>This page is too complex to format, so it is shown as written.</em></p><pre><code>${escapeText(markdown)}</code></pre>`;

/**
 * Markdown to HTML that is safe to embed. Formatting is given a time limit: some inputs make the
 * markdown parser take minutes, and this server has one thread, so a page anyone can write must not
 * be able to hold it. A page that runs out of time is shown as its source, and remembered, so
 * opening it again costs nothing.
 */
export function renderMarkdown(markdown: string): string {
  const key = createHash("sha256").update(markdown).digest("hex");
  if (rendered.has(key)) {
    const hit = rendered.get(key) ?? null;
    rendered.delete(key);
    rendered.set(key, hit);
    return hit ?? asWritten(markdown);
  }
  let out: string | null;
  try {
    const parse = (m: string) => marked.parse(m, { async: false });
    out = toSafeHtml(runInNewContext("parse(markdown)", { parse, markdown }, { timeout: RENDER_MS }) as string);
  } catch (e) {
    const timedOut = (e as NodeJS.ErrnoException).code === "ERR_SCRIPT_EXECUTION_TIMEOUT";
    if (!timedOut && !(e instanceof RangeError)) throw e; // RangeError: nesting too deep for the parser's stack
    out = null;
  }
  if (out === null || out.length <= RENDERED_MAX_CHARS) {
    rendered.set(key, out);
    if (rendered.size > RENDERED_MAX) rendered.delete(rendered.keys().next().value as string);
  }
  return out ?? asWritten(markdown);
}

/** Raw HTML is escaped by the sanitiser's allow-list and unsafe URLs dropped. */
function toSafeHtml(unsafe: string): string {
  return sanitizeHtml(unsafe, {
    allowedTags: [
      "h1", "h2", "h3", "h4", "h5", "h6", "p", "br", "hr", "blockquote", "pre", "code", "em", "strong", "del", "s",
      "ul", "ol", "li", "a", "table", "thead", "tbody", "tr", "th", "td", "input",
    ],
    allowedAttributes: {
      a: ["href", "title", "rel"],
      input: ["type", "checked", "disabled"],
      th: ["align"],
      td: ["align"],
      code: ["class"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { rel: "nofollow noopener noreferrer" }),
      // Images become links: loading them would tell a remote server when the page is opened, and a
      // URL can carry data out (audit D6). The CSP blocks remote images as well.
      img: (_tag, attribs) => ({
        tagName: "a",
        attribs: { href: attribs.src?.startsWith("https://") ? attribs.src : "", rel: "nofollow noopener noreferrer" },
        text: `Image: ${attribs.alt || attribs.src || ""}`,
      }),
    },
    exclusiveFilter: (frame) => frame.tag === "input" && frame.attribs.type !== "checkbox",
  });
}
