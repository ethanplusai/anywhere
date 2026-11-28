import type { Briefing } from "../service/projects.js";
import { actorLabel, clip, items, section } from "./briefing.js";

/*
 * The in-chat app: Anywhere's own interface, drawn inside the conversation (MCP Apps, extension
 * io.modelcontextprotocol/ui, 2026-01-26). A tool names a `ui://` page in its `_meta`; an app that
 * supports panels reads that page, puts it in a sandboxed frame and hands it the tool's
 * `structuredContent`. An app that does not simply shows the tool's text, so every panel tool
 * returns text that stands on its own.
 *
 * There is one page for every view (the projects board, a project, a page, the set-up checklist),
 * so moving between them happens in place: the page calls the same tools the agent does and draws
 * what comes back. It wears the web app's design (web/style.ts): the same palette, pill actions,
 * ruled sections and the mark. It is one self-contained document with no outside requests, which
 * is all the default sandbox allows; that is also why it cannot load the app's own typeface and
 * falls back to the same stack the web app does.
 *
 * What it draws comes from pages and folder names, which anyone's agent may have written, so it is
 * set as text, never as markup. The one exception is a page's body, which arrives already passed
 * through the same sanitiser the web app uses (web/render.ts) and is marked as such.
 */

export const PANEL_MIME = "text/html;profile=mcp-app";
export const APP_PANEL = "ui://anywhere/app.html";

/** The projects board: everything in Anywhere, and what changed lately. */
export interface BoardPanelData {
  kind: "board";
  url: string | null;
  projects: {
    name: string;
    slug: string;
    description: string;
    /** The business or group it belongs to; projects are listed under it. */
    group: string;
    status: "active" | "paused" | "archived";
    pages: number;
    updatedAt: string;
    lastBy: string;
  }[];
  recent: { project: string; projectName: string; path: string; who: string; action: string; at: string }[];
}

/** One page, formatted. `html` has been through the web app's sanitiser. */
export interface PagePanelData {
  kind: "page";
  project: { name: string; slug: string };
  path: string;
  version: number;
  updatedAt: string;
  html: string;
  url: string | null;
}

/** What the project card draws. Short on purpose: the pages themselves are one tool call away. */
export interface ProjectPanelData {
  kind: "project";
  project: { name: string; slug: string; description: string; url: string | null };
  plan: { filled: boolean; goal: string; done: number; total: number; now: string[]; next: string[]; blocked: string[] };
  decisions: string[];
  questions: string[];
  changes: { path: string; who: string; action: string; at: string }[];
  pages: { path: string; updatedAt: string; lastBy: string }[];
}

export const who = actorLabel;

const lines = (text: string | null, max: number) => (text ? items(text).slice(0, max).map((l) => clip(l, 180)) : []);

export function projectPanelData(
  b: Briefing,
  planTemplate: string,
  baseUrl: string | null,
  pages: { path: string; updatedAt: string; lastActor: string | null }[] = [],
): ProjectPanelData {
  const plan = b.pages["plan.md"]?.content ?? "";
  const filled = Boolean(plan.trim()) && plan.trim() !== planTemplate.trim();
  const phases = (filled && section(plan, "phases")) || "";
  const from = (name: string) => {
    const text = filled ? section(plan, name) : null;
    const list = lines(text, 6);
    // A section written as a sentence rather than a list still shows.
    return list.length || !text?.trim() ? list : [clip(text, 240)];
  };
  return {
    kind: "project",
    project: {
      name: b.project.name,
      slug: b.project.slug,
      description: b.project.description ?? "",
      url: baseUrl ? `${baseUrl}/projects/${b.project.slug}` : null,
    },
    plan: {
      filled,
      goal: clip((filled && section(plan, "goal")) || "", 220),
      done: (phases.match(/^\s*[-*]\s+\[x\]/gim) ?? []).length,
      total: (phases.match(/^\s*[-*]\s+\[[ x]\]/gim) ?? []).length,
      now: from("now"),
      next: from("next"),
      blocked: from("blocked"),
    },
    decisions: lines(b.pages["decisions.md"]?.content ?? "", 4),
    questions: lines(b.pages["open-questions.md"]?.content ?? "", 4),
    changes: b.recent.slice(0, 5).map((r) => ({
      path: r.path,
      who: actorLabel(r.actor),
      action: r.deleted ? "deleted" : r.via === "append" ? "added to" : "wrote",
      at: r.createdAt,
    })),
    pages: pages.map((p) => ({ path: p.path, updatedAt: p.updatedAt, lastBy: actorLabel(p.lastActor) })),
  };
}

/** What the map of someone's work draws: the projects an agent found, and the ones already in Anywhere. */
export interface PickerCandidate {
  name: string;
  group?: string | undefined;
  description?: string | undefined;
  repos?: string[] | undefined;
  path?: string | undefined;
  checkouts?: number | undefined;
  last_active?: string | undefined;
  suggest?: "bring_in" | "brief" | "skip" | undefined;
  reason?: string | undefined;
  existing?: string | undefined;
  note?: string | undefined;
}
export interface PickerPanelData {
  kind: "picker";
  candidates: PickerCandidate[];
  existing: { slug: string; name: string }[];
}

// ---------------------------------------------------------------- the page

/** The web app's palette and shapes (web/style.ts), light and dark. Keep the values in step. */
const STYLE = `
:root {
  color-scheme: light;
  --page: #f5f6f7; --surface: #fcfcfd; --inset: #eceef1; --text: #15181e; --text2: #5b6270;
  --line: #dfe2e7; --line2: #c4c9d2; --accent: #2a47d1; --accent-hover: #1f37ad; --accent-text: #2a47d1;
  --wash: #e3e8ff; --on-accent: #fcfcfd; --code-bg: #15181e; --code-text: #eceef1;
  --font: "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
  --mono: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page: #14161b; --surface: #1c1f26; --inset: #23272f; --text: #e7ebf3; --text2: #9aa2b1;
  --line: #343a46; --line2: #4a5160; --accent: #3553e0; --accent-hover: #4563ee; --accent-text: #8ea4ff;
  --wash: #1d2a63; --on-accent: #fcfcfd; --code-bg: #0e1014; --code-text: #e7ebf3;
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; padding: 2px; background: transparent; color: var(--text); font: 15px/1.55 var(--font); -webkit-font-smoothing: antialiased; }
h1, h2, h3, p, ul, ol, dl, dd { margin: 0; }
ul { padding: 0; list-style: none; }
.app { border: 1px solid var(--line); border-radius: 20px; background: var(--surface); overflow: hidden; transition: opacity 0.15s; }
.app[aria-busy="true"] { opacity: 0.55; pointer-events: none; }
.bar { display: flex; align-items: center; gap: 0.75rem; padding: 0.7rem 1.1rem; border-block-end: 1px solid var(--line); min-height: 3.25rem; }
.brand { display: inline-flex; align-items: center; gap: 0.5rem; font-weight: 600; letter-spacing: -0.02em; background: none; border: 0; padding: 0; min-height: 0; color: var(--text); border-radius: 6px; }
.brand svg { flex: none; }
.crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem; min-width: 0; color: var(--text2); font-size: 0.875rem; }
.crumbs .sep { color: var(--line2); }
.crumbs button { background: none; border: 0; padding: 0.15rem 0.3rem; min-height: 0; border-radius: 6px; color: var(--text2); font-size: inherit; font-weight: 500; }
.crumbs button:hover { background: var(--inset); color: var(--text); }
.crumbs .here { color: var(--text); font-weight: 550; padding-inline: 0.3rem; overflow-wrap: anywhere; }
.bar .grow { flex: 1; }
.sec { padding: 1.1rem 1.25rem; border-block-end: 1px solid var(--line); }
.sec:last-child { border-block-end: 0; }
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(11.5rem, 1fr)); border-block-end: 1px solid var(--line); }
.cols > .sec { border-block-end: 0; min-width: 0; }
.cols > .sec + .sec { border-inline-start: 1px solid var(--line); }
h1 { font-size: 1.5rem; line-height: 1.15; letter-spacing: -0.035em; font-weight: 600; text-wrap: balance; }
.kicker { font-size: 0.8125rem; font-weight: 550; color: var(--accent-text); margin-block-end: 0.3rem; }
.lead { color: var(--text2); margin-block-start: 0.35rem; max-width: 40rem; text-wrap: pretty; }
h2 { font-size: 0.8125rem; font-weight: 550; color: var(--text2); margin-block-end: 0.5rem; }
.items { display: grid; gap: 0.4rem; }
.items li { overflow-wrap: anywhere; }
.now li { position: relative; padding-inline-start: 0.95rem; }
.now li::before { content: ""; position: absolute; inset-inline-start: 0; top: 0.6em; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
.empty { color: var(--text2); }
.meta { color: var(--text2); font-size: 0.875rem; font-variant-numeric: tabular-nums; }
.mono { font-family: var(--mono); font-size: 0.875rem; }
.bar-track { height: 4px; border-radius: 999px; background: var(--inset); margin-block-start: 0.6rem; overflow: hidden; max-width: 22rem; }
.bar-track i { display: block; height: 100%; border-radius: 999px; background: var(--accent); }
button { display: inline-flex; align-items: center; justify-content: center; gap: 0.45rem; min-height: 2.5rem; padding-inline: 1.1rem;
  font: inherit; font-size: 0.9375rem; font-weight: 550; line-height: 1; white-space: nowrap; cursor: pointer;
  border: 1px solid transparent; border-radius: 999px; background: var(--accent); color: var(--on-accent);
  transition: background-color 0.15s, color 0.15s, scale 0.15s var(--ease-out); }
button:hover { background: var(--accent-hover); }
button:active { scale: 0.96; }
button.quiet { background: var(--inset); color: var(--text); }
button.quiet:hover { background: var(--line); }
button.sm { min-height: 2.25rem; padding-inline: 0.9rem; font-size: 0.875rem; }
button:disabled { opacity: 0.5; cursor: default; scale: 1; }
button:focus-visible, input:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.rows { display: grid; }
.rows > * + * { border-block-start: 1px solid var(--line); }
button.row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.2rem 1rem; align-items: center; width: 100%; min-height: 3.25rem; padding: 0.75rem 1.25rem;
  background: none; color: var(--text); border: 0; border-radius: 0; text-align: start; white-space: normal; font-weight: 400; line-height: 1.45; }
button.row:hover { background: var(--inset); }
button.row + button.row { border-block-start: 1px solid var(--line); }
button.row:active { scale: 1; }
.row .name { font-weight: 550; overflow-wrap: anywhere; }
.row .desc { grid-column: 1; color: var(--text2); font-size: 0.875rem; overflow-wrap: anywhere; }
.row .meta { grid-row: 1 / span 2; grid-column: 2; text-align: end; white-space: nowrap; }
.pages { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.pages button { min-height: 2.25rem; padding-inline: 0.8rem; background: var(--inset); color: var(--text); font-family: var(--mono); font-size: 0.8125rem; font-weight: 500; }
.pages button:hover { background: var(--line); }
.foot { display: flex; flex-wrap: wrap; gap: 0.6rem; align-items: center; justify-content: space-between; padding: 0.9rem 1.25rem; }
.foot .acts { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.group { padding: 0.7rem 1.25rem 0.3rem; font-size: 0.8125rem; font-weight: 550; color: var(--text2); }
label.pick { display: grid; grid-template-columns: 1.25rem minmax(0, 1fr) auto; gap: 0.75rem; align-items: start; padding: 0.7rem 1.25rem; cursor: pointer; }
label.pick:hover { background: var(--inset); }
label.pick input { width: 1rem; height: 1rem; margin: 0.25rem 0 0; accent-color: var(--accent); }
.tag { display: inline-flex; align-items: center; padding: 0.15rem 0.6rem; border-radius: 999px; background: var(--wash); color: var(--accent-text); font-size: 0.8125rem; font-weight: 550; white-space: nowrap; }
.scroll { max-height: 26rem; overflow-y: auto; }
.map { max-height: 34rem; }
.maprow { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.25rem 1rem; align-items: start; padding: 0.75rem 1.25rem; }
.maprow .name { font-weight: 550; overflow-wrap: anywhere; }
.maprow .desc { color: var(--text2); font-size: 0.875rem; overflow-wrap: anywhere; }
.maprow .facts { color: var(--text2); font-size: 0.8125rem; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.maprow .facts .mono { font-size: 0.8125rem; }
.maprow.out .name, .maprow.out .desc { color: var(--text2); }
.maprow.out .name { font-weight: 500; }
.maprow .tag { justify-self: end; }
.seg { display: inline-flex; padding: 2px; border-radius: 999px; background: var(--inset); }
.seg label { position: relative; padding: 0.35rem 0.75rem; border-radius: 999px; font-size: 0.8125rem; font-weight: 550; color: var(--text2); cursor: pointer; white-space: nowrap; transition: background-color 0.15s, color 0.15s; }
.seg label:hover { color: var(--text); }
.seg input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
.seg label:has(input:checked) { background: var(--wash); color: var(--accent-text); }
.seg label:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: 1px; }
.seg input:disabled { cursor: default; }
.fix { display: grid; gap: 0.4rem; padding: 0.9rem 1.25rem; border-block-start: 1px solid var(--line); }
.fix label { font-size: 0.8125rem; font-weight: 550; color: var(--text2); }
textarea { width: 100%; min-height: 3.5rem; resize: vertical; padding: 0.6rem 0.75rem; border: 1px solid var(--line2); border-radius: 12px; background: var(--surface); color: var(--text); font: inherit; font-size: 1rem; line-height: 1.45; }
textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.paused .name::after { content: " \\00b7  paused"; color: var(--text2); font-weight: 400; }
details.archived summary { padding: 0.7rem 1.25rem; color: var(--text2); font-size: 0.875rem; cursor: pointer; }
details.archived summary:hover { background: var(--inset); }
.said { padding: 0.9rem 1.25rem; color: var(--text2); white-space: pre-wrap; border-block-start: 1px solid var(--line); }
.prose { max-width: 46rem; line-height: 1.7; overflow-wrap: break-word; }
.prose > * + * { margin-block-start: 0.9rem; }
.prose h1 { font-size: 1.5rem; }
.prose h2 { margin-block: 1.6rem 0; font-size: 1.1875rem; font-weight: 600; color: var(--text); letter-spacing: -0.02em; }
.prose h3 { margin-block-start: 1.3rem; font-size: 1rem; font-weight: 600; }
.prose h1 + *, .prose h2 + *, .prose h3 + * { margin-block-start: 0.5rem; }
.prose ul, .prose ol { padding-inline-start: 1.35rem; list-style: revert; }
.prose li + li { margin-block-start: 0.25rem; }
.prose li:has(> input[type=checkbox]) { list-style: none; margin-inline-start: -1.35rem; }
.prose input[type=checkbox] { margin: 0 0.5rem 0 0; vertical-align: -0.1em; accent-color: var(--accent); }
.prose blockquote { margin-inline: 0; padding-inline-start: 1rem; border-inline-start: 2px solid var(--line2); color: var(--text2); }
.prose a { color: var(--accent-text); overflow-wrap: anywhere; }
.prose code { font-family: var(--mono); font-size: 0.875em; padding: 0.1em 0.35em; border-radius: 6px; background: var(--inset); }
.prose pre { padding: 0.9rem 1rem; border-radius: 12px; background: var(--code-bg); color: var(--code-text); overflow-x: auto; font-size: 0.8125rem; }
.prose pre code { padding: 0; background: none; }
.prose table { display: block; overflow-x: auto; border-collapse: collapse; font-size: 0.9375rem; }
.prose th, .prose td { padding: 0.45rem 0.8rem; border: 1px solid var(--line); text-align: start; }
.prose hr { border: 0; border-block-start: 1px solid var(--line); margin-block: 1.5rem; }
@media (max-width: 30rem) { .maprow { grid-template-columns: minmax(0, 1fr); } .maprow .tag { justify-self: start; } .row .meta { grid-row: auto; grid-column: 1; text-align: start; } .cols > .sec + .sec { border-inline-start: 0; border-block-start: 1px solid var(--line); } }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

/** The mark: three stacked pages, the top one in cobalt. Fixed markup, as in the web app. */
const MARK =
  '<svg width="22" height="22" viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false"><g stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M16 15.2 28 21.6 16 28 4 21.6Z" fill="var(--surface)"/><path d="M16 9.6 28 16 16 22.4 4 16Z" fill="var(--surface)"/><path d="M16 4 28 10.4 16 16.8 4 10.4Z" fill="var(--accent)"/></g></svg>';

/**
 * The handshake with the app that frames the page, its theme and size, and the three things the
 * page may ask of it: call one of this server's tools, post a message as the person, open a link.
 */
export const RUNTIME = `
var pending = {}, nextId = 1, onData = function () {}, host = {};
function post(m) { window.parent.postMessage(m, "*"); }
function request(method, params) {
  return new Promise(function (resolve, reject) {
    var id = nextId++;
    pending[id] = [resolve, reject];
    post({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
  });
}
function notify(method, params) { post({ jsonrpc: "2.0", method: method, params: params || {} }); }
function applyContext(ctx) {
  if (ctx && (ctx.theme === "light" || ctx.theme === "dark")) document.documentElement.setAttribute("data-theme", ctx.theme);
}
if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) document.documentElement.setAttribute("data-theme", "dark");
window.addEventListener("message", function (e) {
  // Only the app that frames this page speaks to it.
  if (e.source !== window.parent) return;
  var m = e.data;
  if (!m || m.jsonrpc !== "2.0") return;
  if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
    var p = pending[m.id];
    if (p) { delete pending[m.id]; if (m.error) p[1](m.error); else p[0](m.result); }
    return;
  }
  if (m.method === "ui/notifications/tool-result") onData(m.params && m.params.structuredContent);
  else if (m.method === "ui/notifications/host-context-changed") applyContext(m.params);
  else if (m.method === "ui/resource-teardown" && m.id !== undefined) post({ jsonrpc: "2.0", id: m.id, result: {} });
});
function el(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}
function start(render) {
  onData = function (data) { if (data && typeof data === "object") render(data); };
  request("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "anywhere", version: "0.1.0" }, appCapabilities: {} })
    .then(function (r) { host = (r && r.hostCapabilities) || {}; applyContext(r && r.hostContext); }, function () {})
    .then(function () { notify("ui/notifications/initialized"); });
  if (window.ResizeObserver) {
    new ResizeObserver(function () {
      var b = document.documentElement.getBoundingClientRect();
      notify("ui/notifications/size-changed", { width: Math.ceil(b.width), height: Math.ceil(b.height) });
    }).observe(document.documentElement);
  }
}
// Posts a message into the chat as the person, so the agent acts on it at once. Content is a list
// of blocks (MCP Apps 2026-01-26); a host may also answer with isError instead of an error.
function say(text) {
  return request("ui/message", { role: "user", content: [{ type: "text", text: text }] }).then(function (r) {
    if (r && r.isError) throw new Error("not delivered");
    return r;
  });
}
// Where the app will not post messages, hand the words to the agent as context for its next turn
// instead. Resolves true when the host took them.
function remember(text) {
  if (!host.updateModelContext) return Promise.resolve(false);
  return request("ui/update-model-context", { content: [{ type: "text", text: text }] }).then(
    function (r) { return !(r && r.isError); },
    function () { return false; }
  );
}
function openLink(url) { return request("ui/open-link", { url: url }).catch(function () {}); }
function callTool(name, args) {
  return request("tools/call", { name: name, arguments: args || {} }).then(function (r) {
    if (!r || r.isError || !r.structuredContent) throw new Error("no view");
    return r.structuredContent;
  });
}
`;

const VIEW = `
var root = document.getElementById("root");
function ago(iso) {
  var d = new Date(iso);
  if (isNaN(d)) return iso || "";
  var mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + " min ago";
  if (mins < 1440) return Math.round(mins / 60) + " h ago";
  var days = Math.round(mins / 1440);
  if (days === 1) return "yesterday";
  if (days < 30) return days + " days ago";
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}
// Moving between views: ask the server through the app that frames us and draw what comes back.
// Where the app will not carry the call, say it in words instead and let the agent show it.
function go(tool, args, words) {
  var app = root.firstChild;
  if (app) app.setAttribute("aria-busy", "true");
  callTool(tool, args).then(render, function () {
    if (app) app.removeAttribute("aria-busy");
    say(words).catch(function () {});
  });
}
function shell(crumbs, url) {
  var app = el("div", "app");
  var bar = el("div", "bar");
  var brand = el("button", "brand");
  brand.insertAdjacentElement("afterbegin", document.getElementById("mark").content.firstElementChild.cloneNode(true));
  brand.appendChild(el("span", "", "Anywhere"));
  brand.title = "All projects";
  brand.onclick = function () { go("show_projects", {}, "Show me my projects in Anywhere."); };
  bar.appendChild(brand);
  if (crumbs && crumbs.length) {
    var c = el("div", "crumbs");
    crumbs.forEach(function (x) {
      c.appendChild(el("span", "sep", "/"));
      if (x.go) { var b = el("button", "", x.text); b.onclick = x.go; c.appendChild(b); }
      else c.appendChild(el("span", "here" + (x.mono ? " mono" : ""), x.text));
    });
    bar.appendChild(c);
  }
  bar.appendChild(el("span", "grow"));
  if (url) {
    var open = el("button", "quiet sm", "Open in browser");
    open.onclick = function () { openLink(url); };
    bar.appendChild(open);
  }
  app.appendChild(bar);
  return app;
}
function section(title, cls) {
  var s = el("div", "sec" + (cls ? " " + cls : ""));
  if (title) s.appendChild(el("h2", "", title));
  return s;
}
function list(title, rows, cls, empty) {
  var s = section(title, cls);
  if (!rows || !rows.length) { s.appendChild(el("p", "empty", empty)); return s; }
  var ul = el("ul", "items");
  rows.forEach(function (r) { ul.appendChild(el("li", "", r)); });
  s.appendChild(ul);
  return s;
}
function changes(rows, withProject) {
  var s = section("Recent changes");
  var ul = el("ul", "items");
  rows.forEach(function (c) {
    var li = el("li");
    li.appendChild(el("span", "", c.who + " " + c.action + " "));
    li.appendChild(el("span", "mono", c.path));
    if (withProject) li.appendChild(el("span", "", " in " + c.projectName));
    li.appendChild(el("span", "meta", "  " + ago(c.at)));
    ul.appendChild(li);
  });
  s.appendChild(ul);
  return s;
}
function showProject(slug, name) { go("show_project", { project: slug }, "Show me " + name + " in Anywhere."); }

function board(d) {
  var app = shell([], d.url);
  var head = section();
  head.appendChild(el("h1", "", "Your projects"));
  head.appendChild(el("p", "lead", d.projects.length
    ? "Every agent you connect reads and writes these pages. Open one, or just ask for it."
    : "Nothing here yet. Say \\u201cSet up Anywhere\\u201d and your agent brings your projects in."));
  app.appendChild(head);
  function projectRow(p) {
    var b = el("button", "row" + (p.status === "paused" ? " paused" : ""));
    b.appendChild(el("span", "name", p.name));
    b.appendChild(el("span", "meta", p.pages + (p.pages === 1 ? " page" : " pages") + " \\u00b7 " + ago(p.updatedAt)));
    b.appendChild(el("span", "desc", p.description || "No description yet"));
    b.onclick = function () { showProject(p.slug, p.name); };
    return b;
  }
  if (d.projects.length) {
    // Projects under the business they belong to, the most recently changed group first.
    var live = d.projects.filter(function (p) { return p.status !== "archived"; });
    var archived = d.projects.filter(function (p) { return p.status === "archived"; });
    var order = [], byGroup = {};
    live.forEach(function (p) {
      var g = p.group || "";
      if (!byGroup[g]) { byGroup[g] = []; order.push(g); }
      byGroup[g].push(p);
    });
    var grouped = order.length > 1 || (order.length === 1 && order[0] !== "");
    var rows = el("div", "rows");
    rows.style.borderBlockEnd = "1px solid var(--line)";
    order.forEach(function (g) {
      var block = el("div");
      if (grouped) block.appendChild(el("p", "group", g || "Other"));
      var inner = el("div", "rows");
      byGroup[g].sort(function (a, b) { return (a.status === "paused") - (b.status === "paused"); });
      byGroup[g].forEach(function (p) { inner.appendChild(projectRow(p)); });
      block.appendChild(inner);
      rows.appendChild(block);
    });
    if (archived.length) {
      var more = el("details", "archived");
      more.appendChild(el("summary", "", archived.length + " archived"));
      var inner2 = el("div", "rows");
      archived.forEach(function (p) { inner2.appendChild(projectRow(p)); });
      more.appendChild(inner2);
      rows.appendChild(more);
    }
    app.appendChild(rows);
  }
  if (d.recent && d.recent.length) app.appendChild(changes(d.recent, true));
  return app;
}

function project(d) {
  var app = shell([{ text: d.project.name }], d.project.url);
  var head = section();
  head.appendChild(el("h1", "", d.project.name));
  if (d.project.description) head.appendChild(el("p", "lead", d.project.description));
  if (d.plan.filled && (d.plan.goal || d.plan.total)) {
    if (d.plan.goal) { var g = el("p", "lead", d.plan.goal); g.style.color = "var(--text)"; head.appendChild(g); }
    if (d.plan.total) {
      head.appendChild(el("p", "meta", d.plan.done + " of " + d.plan.total + " phases done"));
      var track = el("div", "bar-track"), fill = el("i");
      fill.style.width = Math.round((d.plan.done / d.plan.total) * 100) + "%";
      track.appendChild(fill);
      head.appendChild(track);
    }
  }
  app.appendChild(head);
  if (d.plan.filled) {
    var plan = el("div", "cols");
    plan.appendChild(list("Now", d.plan.now, "now", "Nothing in progress"));
    plan.appendChild(list("Next", d.plan.next, "", "Nothing queued"));
    plan.appendChild(list("Blocked", d.plan.blocked, "", "Nothing blocked"));
    app.appendChild(plan);
  } else {
    var none = section("Plan");
    none.appendChild(el("p", "empty", "The plan has not been written yet. Ask your agent to fill it in."));
    app.appendChild(none);
  }
  var notes = el("div", "cols");
  notes.appendChild(list("Latest decisions", d.decisions, "", "None recorded"));
  notes.appendChild(list("Open questions", d.questions, "", "None open"));
  app.appendChild(notes);
  if (d.pages && d.pages.length) {
    var pg = section("Pages");
    var wrap = el("div", "pages");
    d.pages.forEach(function (p) {
      var b = el("button", "", p.path);
      b.title = "Changed " + ago(p.updatedAt) + " by " + p.lastBy;
      b.onclick = function () { go("show_page", { project: d.project.slug, path: p.path }, "Show me " + p.path + " from " + d.project.name + " in Anywhere."); };
      wrap.appendChild(b);
    });
    pg.appendChild(wrap);
    app.appendChild(pg);
  }
  if (d.changes && d.changes.length) app.appendChild(changes(d.changes, false));
  var foot = el("div", "foot");
  foot.style.borderBlockStart = "1px solid var(--line)";
  foot.appendChild(el("span", "meta", "Ask your agent to change anything here."));
  var acts = el("div", "acts");
  var carry = el("button", "sm", "Carry on with this");
  carry.onclick = function () { carry.disabled = true; say("Pick up where we left off on " + d.project.name + " in Anywhere.").catch(function () { carry.disabled = false; }); };
  acts.appendChild(carry);
  foot.appendChild(acts);
  app.appendChild(foot);
  return app;
}

function page(d) {
  var app = shell([
    { text: d.project.name, go: function () { showProject(d.project.slug, d.project.name); } },
    { text: d.path, mono: true },
  ], d.url);
  var meta = section();
  meta.appendChild(el("p", "meta", "Version " + d.version + " \\u00b7 changed " + ago(d.updatedAt)));
  app.appendChild(meta);
  var body = section("", "scroll");
  var prose = el("article", "prose");
  // The one place markup is set: the server has already passed this through the web app's
  // sanitiser (an allow-list of tags, no scripts or handlers, http, https and mailto links only).
  prose.innerHTML = d.html;
  prose.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a") : null;
    if (!a) return;
    e.preventDefault();
    if (/^https?:/.test(a.getAttribute("href") || "")) openLink(a.href);
  });
  if (!prose.textContent.trim()) prose.appendChild(el("p", "empty", "This page is empty."));
  body.appendChild(prose);
  app.appendChild(body);
  return app;
}

// The map of someone's work, for setting up: what the agent found, grouped by business, with
// what it suggests for each. The person confirms or changes each choice and can add corrections.
function picker(d) {
  var app = shell([{ text: "Set up" }], null);
  var head = section();
  head.appendChild(el("h1", "", "Here is the work I found. Is this right?"));
  head.appendChild(el("p", "lead", "Grouped by business, with copies of the same code counted as one project. Choose what Anywhere keeps. Nothing is read until you confirm."));
  app.appendChild(head);
  var have = {};
  (d.existing || []).forEach(function (p) { have[String(p.name).toLowerCase()] = p.slug; have[String(p.slug).toLowerCase()] = p.slug; });
  var CHOICES = [["bring_in", "Bring in"], ["brief", "One line"], ["skip", "Skip"]];
  var box = el("div", "rows scroll map");
  var picks = [], lastGroup = null, n = 0;
  (d.candidates || []).forEach(function (c) {
    var g = c.group || "";
    if (g !== lastGroup && (g || lastGroup !== null)) box.appendChild(el("p", "group", g || "Other"));
    lastGroup = g;
    var already = c.existing || have[String(c.name).toLowerCase()];
    var row = el("div", "maprow");
    var mid = el("div");
    mid.appendChild(el("div", "name", c.name));
    if (c.description) mid.appendChild(el("div", "desc", c.description));
    var facts = el("div", "facts");
    var bits = [];
    if (c.repos && c.repos.length) {
      var r = el("span", "mono", c.repos.slice(0, 2).join(", ") + (c.repos.length > 2 ? " +" + (c.repos.length - 2) : ""));
      facts.appendChild(r);
    } else if (c.path) facts.appendChild(el("span", "mono", c.path));
    if (c.checkouts && c.checkouts > 1) bits.push(c.checkouts + " copies here");
    if (c.last_active) bits.push(ago(c.last_active));
    if (c.reason) bits.push(c.reason);
    if (c.note) bits.push(c.note);
    if (bits.length) facts.appendChild(document.createTextNode((facts.firstChild ? "  ·  " : "") + bits.join("  ·  ")));
    if (facts.firstChild) mid.appendChild(facts);
    row.appendChild(mid);
    if (already) {
      row.appendChild(el("span", "tag", "Already in"));
      box.appendChild(row);
      return;
    }
    var seg = el("div", "seg");
    seg.setAttribute("role", "radiogroup");
    seg.setAttribute("aria-label", c.name);
    var name = "pick" + (n++);
    var chosen = c.suggest || "skip";
    var item = { c: c, row: row, value: chosen, inputs: [] };
    CHOICES.forEach(function (choice) {
      var lab = el("label");
      var input = document.createElement("input");
      input.type = "radio";
      input.name = name;
      input.value = choice[0];
      input.checked = choice[0] === chosen;
      input.onchange = function () { item.value = choice[0]; update(); };
      lab.appendChild(input);
      lab.appendChild(document.createTextNode(choice[1]));
      seg.appendChild(lab);
      item.inputs.push(input);
    });
    row.appendChild(seg);
    box.appendChild(row);
    picks.push(item);
  });
  app.appendChild(box);
  var fix = el("div", "fix");
  var fixLabel = el("label", "", "Anything to correct? Two projects that are one, a wrong name, something missing.");
  var notes = document.createElement("textarea");
  notes.id = "map-notes";
  fixLabel.setAttribute("for", "map-notes");
  notes.placeholder = "Optional";
  fix.appendChild(fixLabel);
  fix.appendChild(notes);
  app.appendChild(fix);
  var foot = el("div", "foot");
  foot.style.borderBlockStart = "1px solid var(--line)";
  var count = el("span", "meta", "");
  var confirm = el("button", "", "Confirm");
  function update() {
    var t = { bring_in: 0, brief: 0, skip: 0 };
    picks.forEach(function (p) { t[p.value]++; p.row.classList.toggle("out", p.value === "skip"); });
    count.textContent = t.bring_in + " to bring in · " + t.brief + " as one line · " + t.skip + " skipped";
    confirm.disabled = !(t.bring_in + t.brief) && !notes.value.trim();
  }
  notes.oninput = update;
  function label(c) { return (c.group ? c.group + " / " : "") + c.name + (c.repos && c.repos.length ? " (" + c.repos.join(", ") + ")" : c.path ? " (" + c.path + ")" : ""); }
  confirm.onclick = function () {
    var parts = ["Set up Anywhere with this map of my work."];
    [["bring_in", "Bring in fully:"], ["brief", "One line each, marked paused:"], ["skip", "Leave out:"]].forEach(function (k) {
      var these = picks.filter(function (p) { return p.value === k[0]; });
      if (these.length) parts.push(k[1] + "\\n" + these.map(function (p) { return "- " + label(p.c); }).join("\\n"));
    });
    if (notes.value.trim()) parts.push("Corrections: " + notes.value.trim());
    var text = parts.join("\\n\\n");
    confirm.disabled = true;
    notes.disabled = true;
    picks.forEach(function (p) { p.inputs.forEach(function (i) { i.disabled = true; }); });
    say(text).then(
      function () { count.textContent = "Sent. Your agent takes it from here."; },
      function () {
        remember(text).then(function (kept) {
          if (kept) {
            // The agent has the choices; one short message from the person starts it.
            count.textContent = "Your agent has your choices. Send it \\u201cgo\\u201d to set them up.";
            return;
          }
          // Neither: show the words so the person can send them.
          app.insertBefore(el("p", "said", text), foot);
          count.textContent = "Send this message to your agent:";
        });
      }
    );
  };
  update();
  foot.appendChild(count);
  foot.appendChild(confirm);
  app.appendChild(foot);
  return app;
}

var VIEWS = { board: board, project: project, page: page, picker: picker };
function render(d) {
  var view = VIEWS[d && d.kind];
  if (!view) return;
  root.textContent = "";
  root.appendChild(view(d));
}
start(render);
`;

/** The one page every view is drawn in. */
export const APP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Anywhere</title>
<style>${STYLE}</style>
</head>
<body>
<template id="mark">${MARK}</template>
<div id="root"></div>
<script>(function () {${RUNTIME}${VIEW}})();</script>
</body>
</html>`;
