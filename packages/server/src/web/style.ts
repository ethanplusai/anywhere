/**
 * The app's stylesheet. It uses the anywr.ai website's design: one palette shared with the
 * website's drawings (ink, a cool neutral ramp and a single cobalt), Geist and Geist Mono, a ruled
 * frame of two vertical hairlines, pill actions, 20px surfaces and 12px fields and code. Light and
 * dark follow the system theme. Keep the values in step with the website's home.css.
 */
import { ISO_CSS } from "./drawings.generated.js";

export const STYLE = `
@font-face { font-family: "Geist"; src: url("/assets/geist.woff2") format("woff2"); font-weight: 100 900; font-display: swap; }
@font-face { font-family: "Geist Mono"; src: url("/assets/geist-mono.woff2") format("woff2"); font-weight: 100 900; font-display: swap; }
:root {
  color-scheme: light dark;
  --color-page: #f5f6f7;
  --color-bg-surface: #fcfcfd;
  --color-bg-inset: #eceef1;
  --color-text: #15181e;
  --color-text-secondary: #5b6270;
  --color-border: #dfe2e7;
  --color-border-strong: #c4c9d2;
  --color-accent-solid: #2a47d1;
  --color-accent-solid-hover: #1f37ad;
  --color-accent-text: #2a47d1;
  --color-accent-wash: #e3e8ff;
  --color-on-accent: #fcfcfd;
  --color-code-bg: #15181e;
  --color-code-text: #eceef1;
  --color-danger: #b4233a;
  --color-danger-wash: #fbe9ec;
  --cobalt-400: #8ea4ff;
  --cobalt-800: #162a8a;
  --i-ink-top: #3a404c;
  --i-ink-left: #22262e;
  --i-ink-right: #15181e;
  --i-on-ink: #eceef1;
  --color-added: #e3e8ff;
  --color-removed: #fbe9ec;
  --shadow-raised: 0 1px 2px rgb(21 24 30 / 0.04), 0 12px 32px -12px rgb(21 24 30 / 0.14);
  --font: "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
  --mono: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --radius-surface: 20px;
  --radius-field: 12px;
  --gutter: clamp(0.75rem, 3vw, 3.5rem);
  --pad: clamp(1.25rem, 3vw, 2.5rem);
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
}
@media (prefers-color-scheme: dark) {
  :root {
    --color-page: #14161b;
    --color-bg-surface: #1c1f26;
    --color-bg-inset: #23272f;
    --color-text: #e7ebf3;
    --color-text-secondary: #9aa2b1;
    --color-border: #343a46;
    --color-border-strong: #4a5160;
    --color-accent-solid: #3553e0;
    --color-accent-solid-hover: #4563ee;
    --color-accent-text: #8ea4ff;
    --color-accent-wash: #1d2a63;
    --color-code-bg: #0e1014;
    --color-code-text: #e7ebf3;
    --color-danger: #ff8f9c;
    --color-danger-wash: #3a1d24;
    --i-ink-top: #343a46;
    --i-ink-left: #0e1014;
    --i-ink-right: #07080a;
    --i-on-ink: #e7ebf3;
    --color-added: #1d2a63;
    --color-removed: #3a1d24;
    --shadow-raised: 0 1px 2px rgb(0 0 0 / 0.3), 0 12px 32px -12px rgb(0 0 0 / 0.5);
  }
}

*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; min-height: 100dvh; background: var(--color-page); color: var(--color-text);
  font-family: var(--font); font-size: 1rem; line-height: 1.55;
  -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
}
:focus-visible { outline: 2px solid var(--color-accent-text); outline-offset: 2px; border-radius: 6px; }
h1, h2, h3, h4, p, ol, ul, pre, form, table, figure, blockquote, dl, dd { margin: 0; }
h1, h2, h3 { font-weight: 550; text-wrap: balance; }
p, li { text-wrap: pretty; }
a { color: var(--color-accent-text); text-decoration-thickness: from-font; text-underline-offset: 0.18em; }
strong { font-weight: 600; }
svg.i { width: 1.125rem; height: 1.125rem; flex: none; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.skip { position: absolute; inset-inline-start: 1rem; top: -4rem; z-index: 10; padding: 0.6rem 1rem; border-radius: 999px; background: var(--color-text); color: var(--color-page); }
.skip:focus { top: 1rem; }

/* ---------- frame ---------- */
.frame {
  display: flex; flex-direction: column; min-height: 100dvh;
  width: min(84rem, 100% - 2 * var(--gutter)); margin-inline: auto;
  border-inline: 1px solid var(--color-border);
}
.bar {
  position: sticky; top: 0; z-index: 5;
  display: flex; align-items: center; gap: 1.5rem; min-height: 4rem; padding-inline: var(--pad);
  border-block-end: 1px solid var(--color-border);
  background: color-mix(in srgb, var(--color-page) 88%, transparent);
  backdrop-filter: saturate(1.4) blur(12px); -webkit-backdrop-filter: saturate(1.4) blur(12px);
}
.brand {
  display: inline-flex; align-items: center; gap: 0.55rem; flex: none;
  font-size: 1.0625rem; font-weight: 600; letter-spacing: -0.02em; color: var(--color-text); text-decoration: none;
}
.mark { flex: none; color: var(--color-text); }
.bar nav { display: flex; align-items: center; gap: 0.25rem; min-width: 0; font-size: 0.9375rem; }
.bar nav a {
  padding: 0.45rem 0.8rem; border-radius: 999px; color: var(--color-text-secondary); text-decoration: none; white-space: nowrap;
  transition: color 0.15s, background-color 0.15s;
}
.bar nav a:hover { color: var(--color-text); }
.bar nav a[aria-current="page"] { color: var(--color-text); background: var(--color-bg-inset); font-weight: 550; }
.bar-end { display: flex; align-items: center; gap: 0.75rem; margin-inline-start: auto; }
.bar-search { position: relative; display: flex; align-items: center; }
.bar-search svg { position: absolute; inset-inline-start: 0.75rem; color: var(--color-text-secondary); pointer-events: none; }
.bar-search input[type=search] {
  width: 15rem; min-height: 2.375rem; padding: 0.4rem 0.9rem 0.4rem 2.3rem;
  font: inherit; font-size: 1rem; color: var(--color-text);
  background: var(--color-bg-surface); border: 1px solid var(--color-border); border-radius: 999px;
  transition: border-color 0.15s, box-shadow 0.15s, width 0.2s var(--ease-out);
}
.bar-search input::placeholder { color: var(--color-text-secondary); }
.bar-search input[type=search]:focus { outline: none; width: 19rem; border-color: var(--color-accent-solid); box-shadow: 0 0 0 3px var(--color-accent-wash); }
.bar-search-link { display: none; place-items: center; width: 2.5rem; height: 2.5rem; border-radius: 999px; color: var(--color-text-secondary); }
.bar-search-link:hover { color: var(--color-text); background: var(--color-bg-inset); }
.bar-link { color: var(--color-text-secondary); font-size: 0.9375rem; text-decoration: none; white-space: nowrap; }
.bar-link:hover { color: var(--color-text); }

main { flex: 1; min-width: 0; padding: clamp(2rem, 4.5vw, 3.5rem) var(--pad) clamp(3rem, 6vw, 5rem); }
main.flush { padding: 0; display: flex; }

.foot {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.75rem 1.5rem;
  padding: 1.25rem var(--pad); border-block-start: 1px solid var(--color-border);
  font-size: 0.875rem; color: var(--color-text-secondary);
}
.foot nav { display: flex; flex-wrap: wrap; gap: 1.25rem; }
.foot a { color: inherit; text-decoration: none; }
.foot a:hover { color: var(--color-text); }

/* ---------- type ---------- */
h1 { font-size: clamp(1.875rem, 3.2vw, 2.5rem); line-height: 1.08; letter-spacing: -0.035em; }
h2 { font-size: 1.25rem; line-height: 1.25; letter-spacing: -0.02em; }
h3 { font-size: 1rem; line-height: 1.35; letter-spacing: -0.01em; }
.muted { color: var(--color-text-secondary); }
.small { font-size: 0.875rem; }
.mono { font-family: var(--mono); font-size: 0.875em; }
code, pre, kbd { font-family: var(--mono); font-size: 0.875em; }
code { padding: 0.1em 0.4em; background: var(--color-bg-inset); border-radius: 6px; overflow-wrap: anywhere; }
pre { padding: 1rem 1.25rem; background: var(--color-code-bg); color: var(--color-code-text); border-radius: var(--radius-field); overflow-x: auto; line-height: 1.65; }
pre code { padding: 0; background: none; color: inherit; font-size: inherit; overflow-wrap: normal; }
kbd { padding: 0.1em 0.45em; border: 1px solid var(--color-border); border-block-end-width: 2px; border-radius: 6px; font-size: 0.8125em; color: var(--color-text-secondary); }
time { font-variant-numeric: tabular-nums; }

/* ---------- page header ---------- */
.head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 1rem 2rem; margin-block-end: 2rem; }
.head > div:first-child { min-width: 0; max-width: 46rem; }
.head p { margin-block-start: 0.6rem; color: var(--color-text-secondary); font-size: 1.0625rem; }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
.crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; margin-block-end: 0.75rem; font-size: 0.875rem; color: var(--color-text-secondary); }
.crumbs a { color: inherit; text-decoration: none; }
.crumbs a:hover { color: var(--color-text); }
.section + .section { margin-block-start: 3rem; }
.section > h2 { margin-block-end: 0.4rem; }
.section > h2 + p { margin-block-end: 1.25rem; color: var(--color-text-secondary); max-width: 44rem; }
.section > h2:only-child, .section > h2 + :not(p) { margin-block-end: 1rem; }

/* ---------- buttons ---------- */
button, .btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 0.45rem;
  min-height: 2.75rem; padding-inline: 1.25rem;
  font: inherit; font-size: 0.9375rem; font-weight: 550; line-height: 1; white-space: nowrap; text-decoration: none; cursor: pointer;
  border: 1px solid transparent; border-radius: 999px; background: var(--color-accent-solid); color: var(--color-on-accent);
  transition: background-color 0.15s, color 0.15s, border-color 0.15s, transform 0.15s var(--ease-out);
}
button:hover, .btn:hover { background: var(--color-accent-solid-hover); }
button:active, .btn:active { transform: scale(0.96); }
.btn-quiet, button.secondary { background: var(--color-bg-inset); color: var(--color-text); }
.btn-quiet:hover, button.secondary:hover { background: var(--color-border); }
.btn-ghost { background: transparent; color: var(--color-text-secondary); }
.btn-ghost:hover { background: var(--color-bg-inset); color: var(--color-text); }
.btn-danger, button.danger { background: transparent; color: var(--color-danger); border-color: var(--color-border); }
.btn-danger:hover, button.danger:hover { background: var(--color-danger-wash); border-color: var(--color-danger); }
.btn-solid-danger { background: var(--color-danger); color: var(--color-page); }
.btn-solid-danger:hover { background: var(--color-danger); filter: brightness(0.92); }
.btn-sm { min-height: 2.25rem; padding-inline: 0.9rem; font-size: 0.875rem; }
.btn-wide { width: 100%; }
.btn-icon { width: 2.25rem; min-height: 2.25rem; padding: 0; }
button.link { min-height: 0; padding: 0; border: 0; background: none; color: inherit; font-weight: inherit; font-size: inherit; text-decoration: underline; text-decoration-thickness: from-font; text-underline-offset: 0.18em; }
button.link:active { transform: none; }

/* ---------- surfaces ---------- */
.card { padding: clamp(1.25rem, 3vw, 1.75rem); background: var(--color-bg-surface); border: 1px solid var(--color-border); border-radius: var(--radius-surface); }
.card > * + * { margin-block-start: 1rem; }
.card-raised { box-shadow: var(--shadow-raised); }
.stack > * + * { margin-block-start: 1rem; }
.notice, .error, .ok {
  display: flex; gap: 0.7rem; align-items: flex-start; padding: 0.85rem 1rem; border-radius: var(--radius-field); font-size: 0.9375rem;
}
.notice svg, .error svg, .ok svg { margin-block-start: 0.15rem; }
.notice { background: var(--color-accent-wash); }
.ok { background: var(--color-accent-wash); }
.error { color: var(--color-danger); background: var(--color-danger-wash); }
.notice > div > * + *, .error > div > * + * { margin-block-start: 0.6rem; }
.flash { margin-block-end: 1.5rem; }

/* ---------- forms ---------- */
.field + .field { margin-block-start: 1.1rem; }
.field label, .label { display: block; margin-block-end: 0.4rem; font-size: 0.875rem; font-weight: 550; }
.field .hint { margin-block-start: 0.4rem; font-size: 0.8125rem; color: var(--color-text-secondary); }
.check { display: flex; align-items: flex-start; gap: 0.6rem; font-size: 0.9375rem; }
.check input { inline-size: 1.05rem; block-size: 1.05rem; margin: 0.2rem 0 0; accent-color: var(--color-accent-solid); flex: none; }
input[type=text], input[type=email], input[type=password], input[type=search], select, textarea {
  display: block; width: 100%; min-height: 2.75rem; padding: 0.6rem 0.9rem;
  font: inherit; font-size: 1rem; color: var(--color-text);
  background: var(--color-page); border: 1px solid var(--color-border); border-radius: var(--radius-field);
  transition: border-color 0.15s, box-shadow 0.15s;
}
input:hover, select:hover, textarea:hover { border-color: var(--color-border-strong); }
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--color-accent-solid); box-shadow: 0 0 0 3px var(--color-accent-wash); }
.form-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.6rem; margin-block-start: 1.5rem; }
.inline-form { display: flex; gap: 0.6rem; align-items: flex-end; }
.inline-form .field { flex: 1; margin: 0; }
.prefixed { display: flex; align-items: stretch; }
.prefixed span { display: flex; align-items: center; padding-inline: 0.9rem; border: 1px solid var(--color-border); border-inline-end: 0; border-radius: var(--radius-field) 0 0 var(--radius-field); background: var(--color-bg-inset); color: var(--color-text-secondary); font-family: var(--mono); font-size: 0.875rem; white-space: nowrap; }
.prefixed input { border-start-start-radius: 0; border-end-start-radius: 0; font-family: var(--mono); font-size: 0.9375rem; }

/* ---------- copyable values ---------- */
.copy { display: flex; align-items: center; gap: 0.5rem; padding: 0.4rem 0.4rem 0.4rem 1rem; background: var(--color-code-bg); color: var(--color-code-text); border-radius: var(--radius-field); }
.copy code { flex: 1; min-width: 0; padding: 0; background: none; color: inherit; font-size: 0.875rem; white-space: nowrap; overflow-x: auto; scrollbar-width: none; }
.copy button { flex: none; min-height: 2.25rem; padding-inline: 0.8rem; font-size: 0.8125rem; background: rgb(255 255 255 / 0.1); color: var(--color-code-text); }
.copy button:hover { background: rgb(255 255 255 / 0.18); }
.copy button[data-copied] { background: var(--color-accent-solid); color: var(--color-on-accent); }

/* ---------- actor chip ---------- */
.who { display: inline-flex; align-items: center; gap: 0.35rem; color: var(--color-text); font-weight: 500; white-space: nowrap; }
.who svg { width: 0.95rem; height: 0.95rem; flex: none; }
.who svg path { fill: currentColor; }
.who .dot { display: inline-grid; place-items: center; width: 1rem; height: 1rem; border-radius: 999px; background: var(--color-bg-inset); font-size: 0.625rem; font-weight: 650; color: var(--color-text-secondary); }
.who.you .dot { background: var(--color-accent-solid); color: var(--color-on-accent); }

.app-badge { display: inline-grid; place-items: center; width: 2.25rem; height: 2.25rem; flex: none; border-radius: 10px; background: var(--color-bg-inset); font-weight: 650; font-size: 0.9375rem; color: var(--color-text); }
.app-badge svg { width: 1.15rem; height: 1.15rem; }
.app-badge svg path { fill: currentColor; }

/* ---------- lists ---------- */
.list { padding: 0; list-style: none; background: var(--color-bg-surface); border: 1px solid var(--color-border); border-radius: var(--radius-surface); overflow: hidden; }
.list > li { margin: 0; border-block-end: 1px solid var(--color-border); }
.list > li:last-child { border-block-end: 0; }
.item { display: flex; align-items: center; gap: 1rem; padding: 1rem 1.25rem; color: inherit; text-decoration: none; }
a.item { transition: background-color 0.15s; }
a.item:hover { background: color-mix(in srgb, var(--color-bg-inset) 55%, transparent); }
.item-main { flex: 1; min-width: 0; }
.item-main > * + * { margin-block-start: 0.2rem; }
.item-title { font-weight: 550; overflow-wrap: anywhere; }
.item-sub { font-size: 0.875rem; color: var(--color-text-secondary); }
.item-end { flex: none; text-align: end; font-size: 0.875rem; color: var(--color-text-secondary); }
.item-end form { margin: 0; }
.meta { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem 0.5rem; font-size: 0.875rem; color: var(--color-text-secondary); }
.meta > * + *::before { content: ""; display: inline-block; width: 3px; height: 3px; margin-inline-end: 0.5rem; border-radius: 999px; background: currentColor; opacity: 0.5; vertical-align: middle; }

/* projects index */
.projects { display: grid; grid-template-columns: minmax(0, 1fr) 22rem; gap: 2.5rem; align-items: start; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr)); gap: 1rem; padding: 0; list-style: none; }
.tile {
  display: flex; flex-direction: column; gap: 0.6rem; height: 100%; padding: 1.25rem 1.35rem;
  background: var(--color-bg-surface); border: 1px solid var(--color-border); border-radius: var(--radius-surface);
  color: inherit; text-decoration: none; transition: border-color 0.15s, box-shadow 0.2s, transform 0.2s var(--ease-out);
}
.tile:hover { border-color: var(--color-border-strong); box-shadow: var(--shadow-raised); }
.tile:active { transform: scale(0.99); }
.tile h2 { font-size: 1.0625rem; }
.tile p { flex: 1; font-size: 0.9375rem; color: var(--color-text-secondary); display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.tile .meta { padding-block-start: 0.6rem; border-block-start: 1px solid var(--color-border); }
.tile-new { align-items: center; justify-content: center; min-height: 9.5rem; border-style: dashed; color: var(--color-text-secondary); font-weight: 550; }
.tile-new:hover { color: var(--color-text); box-shadow: none; }
.feed { padding: 0; list-style: none; }
.feed li { position: relative; display: flex; gap: 0.75rem; padding-block: 0.7rem; font-size: 0.9375rem; }
.feed li + li { border-block-start: 1px solid var(--color-border); }
.feed a { color: var(--color-text); text-decoration: none; font-weight: 500; overflow-wrap: anywhere; }
.feed a:hover { color: var(--color-accent-text); }
.feed .item-sub { margin-block-start: 0.15rem; }
.aside-title { display: flex; align-items: baseline; justify-content: space-between; margin-block-end: 0.5rem; }
.aside-title h2 { font-size: 1rem; }

/* empty states */
.empty { padding: clamp(2rem, 5vw, 3.5rem) clamp(1.5rem, 4vw, 3rem); text-align: center; background: var(--color-bg-surface); border: 1px solid var(--color-border); border-radius: var(--radius-surface); background-image: radial-gradient(var(--color-border) 1px, transparent 1.2px); background-size: 22px 22px; }
.empty h2 { font-size: 1.5rem; letter-spacing: -0.03em; }
.empty > p { max-width: 32rem; margin: 0.75rem auto 0; color: var(--color-text-secondary); }
.empty .actions { justify-content: center; margin-block-start: 1.5rem; }
.empty .mark { width: 3rem; height: 3rem; margin-block-end: 1.25rem; }
.steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1rem; max-width: 52rem; margin: 2rem auto 0; padding: 0; list-style: none; counter-reset: step; text-align: start; }
.steps li { counter-increment: step; padding: 1.1rem 1.2rem; background: var(--color-bg-surface); border: 1px solid var(--color-border); border-radius: 16px; font-size: 0.9375rem; color: var(--color-text-secondary); }
.steps li::before { content: counter(step); display: grid; place-items: center; width: 1.6rem; height: 1.6rem; margin-block-end: 0.7rem; border-radius: 999px; background: var(--color-text); color: var(--color-page); font-size: 0.8125rem; font-weight: 650; }
.steps strong { display: block; margin-block-end: 0.2rem; color: var(--color-text); }

/* ---------- project shell ---------- */
.shell { display: grid; grid-template-columns: 17.5rem minmax(0, 1fr); flex: 1; min-width: 0; }
.side {
  position: sticky; top: 4rem; align-self: start; max-height: calc(100dvh - 4rem); overflow-y: auto;
  padding: 1.75rem 1rem 2rem; border-inline-end: 1px solid var(--color-border);
}
.side-head { padding-inline: 0.75rem; margin-block-end: 1.25rem; }
.side-head a.back { display: inline-flex; align-items: center; gap: 0.3rem; margin-block-end: 0.75rem; font-size: 0.8125rem; color: var(--color-text-secondary); text-decoration: none; }
.side-head a.back:hover { color: var(--color-text); }
.side-head h1 { font-size: 1.25rem; letter-spacing: -0.025em; overflow-wrap: anywhere; }
.side-head p { margin-block-start: 0.35rem; font-size: 0.875rem; color: var(--color-text-secondary); }
.side h2 { padding-inline: 0.75rem; margin-block: 1.25rem 0.35rem; font-size: 0.75rem; font-weight: 550; color: var(--color-text-secondary); letter-spacing: 0.02em; }
.side ul { padding: 0; list-style: none; }
.side li + li { margin: 0; }
.side ul a {
  display: flex; align-items: center; gap: 0.6rem; padding: 0.45rem 0.75rem; border-radius: 10px;
  color: var(--color-text-secondary); text-decoration: none; font-size: 0.9375rem; transition: background-color 0.15s, color 0.15s;
}
.side ul a span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.side ul a:hover { color: var(--color-text); background: color-mix(in srgb, var(--color-bg-inset) 60%, transparent); }
.side ul a[aria-current="page"] { color: var(--color-text); background: var(--color-bg-inset); font-weight: 550; }
.side ul a[aria-current="page"] svg { color: var(--color-accent-text); }
.side-actions { display: grid; gap: 0.15rem; margin-block-start: 1.5rem; padding-block-start: 1rem; border-block-start: 1px solid var(--color-border); }
.side-actions a { display: flex; align-items: center; gap: 0.6rem; padding: 0.45rem 0.75rem; border-radius: 10px; color: var(--color-text-secondary); text-decoration: none; font-size: 0.875rem; }
.side-actions a:hover { color: var(--color-text); background: color-mix(in srgb, var(--color-bg-inset) 60%, transparent); }
.side-actions a.danger-link:hover { color: var(--color-danger); background: var(--color-danger-wash); }
.doc { min-width: 0; padding: clamp(1.75rem, 4vw, 3rem) clamp(1.25rem, 4vw, 3.5rem) 4rem; }
.doc-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.75rem 1.5rem; max-width: 46rem; margin-block-end: 2rem; padding-block-end: 1.25rem; border-block-end: 1px solid var(--color-border); }
.doc-head .path { font-family: var(--mono); font-size: 0.875rem; color: var(--color-text-secondary); margin-block-end: 0.3rem; }
.doc-wide .doc-head { max-width: 60rem; }

/* rendered markdown */
.prose { max-width: 46rem; font-size: 1.0313rem; line-height: 1.7; overflow-wrap: break-word; }
.prose > * + * { margin-block-start: 1rem; }
.prose h1 { font-size: 2rem; line-height: 1.12; }
.prose h2 { margin-block-start: 2.25rem; font-size: 1.375rem; }
.prose h3 { margin-block-start: 1.75rem; font-size: 1.0938rem; }
.prose h1 + *, .prose h2 + *, .prose h3 + * { margin-block-start: 0.6rem; }
.prose ul, .prose ol { padding-inline-start: 1.35rem; }
.prose li + li { margin-block-start: 0.3rem; }
.prose li > ul, .prose li > ol { margin-block-start: 0.3rem; }
.prose li:has(> input[type=checkbox]) { list-style: none; margin-inline-start: -1.35rem; }
.prose input[type=checkbox] { margin: 0 0.5rem 0 0; vertical-align: -0.1em; accent-color: var(--color-accent-solid); }
.prose blockquote { margin-inline: 0; padding-inline-start: 1rem; border-inline-start: 2px solid var(--color-border-strong); color: var(--color-text-secondary); }
.prose hr { border: 0; border-block-start: 1px solid var(--color-border); margin-block: 2rem; }
.prose table { display: block; overflow-x: auto; border-collapse: collapse; font-size: 0.9375rem; }
.prose th, .prose td { padding: 0.5rem 0.9rem; border: 1px solid var(--color-border); text-align: start; }
.prose th { background: var(--color-bg-inset); font-weight: 550; }
.prose a { overflow-wrap: anywhere; }
.prose pre { font-size: 0.875rem; }
.prose-empty { max-width: 46rem; padding: 2rem; text-align: center; border: 1px dashed var(--color-border-strong); border-radius: var(--radius-surface); color: var(--color-text-secondary); }

/* editor */
.editor { display: flex; flex-direction: column; gap: 1rem; max-width: 60rem; }
.editor textarea { min-height: min(68vh, 48rem); padding: 1.1rem 1.25rem; font-family: var(--mono); font-size: 0.9063rem; line-height: 1.7; resize: vertical; tab-size: 2; background: var(--color-bg-surface); }
.editor-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.75rem; }
.editor-bar .muted { font-size: 0.875rem; }

/* history and diff */
.timeline .item { padding-block: 0.85rem; }
.vnum { display: inline-grid; place-items: center; min-width: 2.25rem; height: 1.6rem; padding-inline: 0.45rem; border-radius: 999px; background: var(--color-bg-inset); font-family: var(--mono); font-size: 0.75rem; font-weight: 550; color: var(--color-text-secondary); }
.current .vnum { background: var(--color-accent-solid); color: var(--color-on-accent); }
.tag { display: inline-flex; align-items: center; padding: 0.1rem 0.55rem; border-radius: 999px; background: var(--color-bg-inset); font-size: 0.75rem; font-weight: 550; color: var(--color-text-secondary); }
.diff { max-width: 60rem; overflow-x: auto; background: var(--color-bg-surface); border: 1px solid var(--color-border); border-radius: var(--radius-field); font-family: var(--mono); font-size: 0.8438rem; line-height: 1.65; }
.diff div { display: grid; grid-template-columns: 1.75rem minmax(0, 1fr); padding-inline-end: 1rem; white-space: pre-wrap; overflow-wrap: anywhere; }
.diff div::before { content: attr(data-s); text-align: center; color: var(--color-text-secondary); user-select: none; }
.diff .add { background: var(--color-added); }
.diff .del { background: var(--color-removed); color: var(--color-danger); }
.diff .gap { display: block; padding: 0.3rem 1rem; color: var(--color-text-secondary); background: var(--color-bg-inset); font-family: var(--font); font-size: 0.8125rem; }
.diff .gap::before { content: none; }
.tabs-inline { display: inline-flex; gap: 0.25rem; padding: 0.25rem; background: var(--color-bg-inset); border-radius: 999px; }
.tabs-inline a { padding: 0.35rem 0.9rem; border-radius: 999px; color: var(--color-text-secondary); text-decoration: none; font-size: 0.875rem; font-weight: 550; }
.tabs-inline a[aria-current="page"] { background: var(--color-bg-surface); color: var(--color-text); box-shadow: 0 1px 2px rgb(21 24 30 / 0.08); }

/* search */
.search-big { display: flex; gap: 0.6rem; max-width: 40rem; margin-block-end: 2rem; }
.search-big input { min-height: 3rem; font-size: 1.0625rem; border-radius: 999px; padding-inline: 1.25rem; background: var(--color-bg-surface); }
.results .item { align-items: flex-start; }
.snippet { font-size: 0.9375rem; color: var(--color-text-secondary); line-height: 1.6; }
mark { padding: 0 0.15em; border-radius: 4px; background: var(--color-accent-wash); color: var(--color-text); }

/* settings */
.settings { display: grid; grid-template-columns: 13rem minmax(0, 1fr); gap: clamp(1.5rem, 4vw, 3.5rem); align-items: start; }
.settings-nav { position: sticky; top: 6rem; display: grid; gap: 0.15rem; }
.settings-nav a { padding: 0.5rem 0.85rem; border-radius: 10px; color: var(--color-text-secondary); text-decoration: none; font-size: 0.9375rem; }
.settings-nav a:hover { color: var(--color-text); background: color-mix(in srgb, var(--color-bg-inset) 60%, transparent); }
.settings-nav a[aria-current="page"] { color: var(--color-text); background: var(--color-bg-inset); font-weight: 550; }
.settings-body { max-width: 46rem; min-width: 0; }
.settings-body > h1 { margin-block-end: 2rem; }
.row-card { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 1rem; }
.row-card > div { min-width: 0; }
.meter { height: 0.5rem; margin-block: 0.9rem 0.6rem; border-radius: 999px; background: var(--color-bg-inset); overflow: hidden; }
.meter span { display: block; height: 100%; border-radius: inherit; background: var(--color-accent-solid); }
.stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
.stat .n { font-size: 1.5rem; font-weight: 550; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }
.stat .n small { font-size: 0.9375rem; color: var(--color-text-secondary); font-weight: 400; letter-spacing: 0; }
.danger-zone { border-color: color-mix(in srgb, var(--color-danger) 35%, var(--color-border)); }
.danger-zone h2 { color: var(--color-danger); }
details.reveal > summary { list-style: none; cursor: pointer; }
details.reveal > summary::-webkit-details-marker { display: none; }
details.reveal[open] > summary { display: none; }
details.reveal > div { margin-block-start: 0; }

/* connect tabs (no script: radio inputs) */
.agent-tabs { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-block-end: 1.25rem; }
.agent-tabs label { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.55rem 1rem; border: 1px solid var(--color-border); border-radius: 999px; background: var(--color-bg-surface); cursor: pointer; font-size: 0.9375rem; font-weight: 550; color: var(--color-text-secondary); transition: border-color 0.15s, color 0.15s, background-color 0.15s; }
.agent-tabs label:hover { color: var(--color-text); border-color: var(--color-border-strong); }
.agent-tabs svg { width: 1.05rem; height: 1.05rem; }
.agent-tabs svg path { fill: currentColor; }
.tab-radio { position: absolute; opacity: 0; pointer-events: none; }
.agent-panel { display: none; }
${["claude", "chatgpt", "claudecode", "codex", "other"]
  .map(
    (id) =>
      `#t-${id}:checked ~ .agent-tabs label[for="t-${id}"] { background: var(--color-text); color: var(--color-page); border-color: var(--color-text); }
#t-${id}:focus-visible ~ .agent-tabs label[for="t-${id}"] { outline: 2px solid var(--color-accent-text); outline-offset: 2px; }
#t-${id}:checked ~ .agent-panels #p-${id} { display: block; }`,
  )
  .join("\n")}
.how { padding: 0; list-style: none; counter-reset: how; }
.how > li { counter-increment: how; display: grid; grid-template-columns: 2rem minmax(0, 1fr); gap: 0.25rem 0.75rem; padding-block: 0.9rem; border-block-start: 1px solid var(--color-border); }
.how > li:first-child { border-block-start: 0; padding-block-start: 0.25rem; }
.how > li::before { content: counter(how); display: grid; place-items: center; width: 1.6rem; height: 1.6rem; border-radius: 999px; background: var(--color-bg-inset); font-size: 0.8125rem; font-weight: 650; color: var(--color-text-secondary); }
.how > li > * { grid-column: 2; }
.how > li > :first-child { grid-row: 1; }
.how .copy { margin-block-start: 0.6rem; }
.say { display: grid; gap: 0.5rem; padding: 0; list-style: none; }
.say li { padding: 0.75rem 1rem; border-radius: 14px 14px 14px 4px; background: var(--color-bg-inset); font-size: 0.9375rem; width: fit-content; max-width: 100%; }

/* ---------- auth and consent ---------- */
.auth {
  flex: 1; display: grid; place-items: start center; padding: clamp(2.5rem, 8vh, 6rem) var(--pad) 4rem;
  background-color: var(--color-bg-surface);
  background-image: radial-gradient(var(--color-border) 1px, transparent 1.2px); background-size: 22px 22px;
}
.auth-box { width: min(26rem, 100%); }
.auth-box > .mark { width: 2.75rem; height: 2.75rem; margin-block-end: 1.5rem; }
.auth-box h1 { font-size: clamp(1.75rem, 3vw, 2.125rem); }
.auth-box .lead { margin-block: 0.6rem 1.75rem; color: var(--color-text-secondary); }
.auth-box .card { box-shadow: var(--shadow-raised); }
.auth-box .card .field + .field { margin-block-start: 1rem; }
.auth-box .after { margin-block-start: 1.25rem; font-size: 0.9375rem; color: var(--color-text-secondary); text-align: center; }
.consent-apps { display: flex; align-items: center; gap: 0.75rem; margin-block-end: 1.5rem; }
.consent-apps .app { display: grid; place-items: center; width: 3rem; height: 3rem; border-radius: 14px; background: var(--color-bg-surface); border: 1px solid var(--color-border); box-shadow: var(--shadow-raised); font-size: 1.25rem; font-weight: 650; }
.consent-apps .app svg { width: 1.6rem; height: 1.6rem; }
.consent-apps .app svg path { fill: currentColor; }
.consent-apps .link-line { width: 2.5rem; border-block-start: 2px dotted var(--color-border-strong); }
.perm { padding: 0; list-style: none; }
.perm li { display: flex; gap: 0.6rem; padding-block: 0.55rem; font-size: 0.9375rem; }
.perm li + li { border-block-start: 1px solid var(--color-border); }
.perm svg { margin-block-start: 0.15rem; color: var(--color-text-secondary); }
.consent-meta { display: grid; gap: 0.35rem; font-size: 0.875rem; color: var(--color-text-secondary); }
.consent-buttons { display: grid; grid-template-columns: 1fr 1fr; gap: 0.6rem; }

/* onboarding */
.ob { max-width: 76rem; }
.ob-intro { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr); gap: clamp(1.5rem, 4vw, 3.5rem); align-items: center; margin-block-end: clamp(2rem, 5vw, 3.5rem); }
.ob-intro-copy > * + * { margin-block-start: 1rem; }
.ob-kicker { font-size: 0.875rem; font-weight: 550; color: var(--color-accent-text); }
.ob-intro h1 { font-size: clamp(2.25rem, 4.2vw, 3.4rem); line-height: 1.02; letter-spacing: -0.04em; }
.ob-intro p:not(.ob-kicker) { font-size: 1.0625rem; color: var(--color-text-secondary); max-width: 34rem; }
.ob-art {
  padding: clamp(0.5rem, 2vw, 1.25rem); border: 1px solid var(--color-border); border-radius: var(--radius-surface); overflow: hidden;
  background-color: var(--color-bg-surface); background-image: radial-gradient(var(--color-border) 1px, transparent 1.2px); background-size: 22px 22px;
}
.ob-art svg { display: block; width: 100%; height: auto; }
.ob-steps { display: grid; gap: 1.25rem; padding: 0; list-style: none; }
.ob-step {
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.05fr); gap: clamp(1.25rem, 3.5vw, 3rem); align-items: center;
  margin: 0; padding: clamp(0.75rem, 1.6vw, 1rem); background: var(--color-bg-surface); border: 1px solid var(--color-border); border-radius: 26px;
}
.ob-step .ob-art { border-radius: 18px; background-color: var(--color-page); }
.ob-step:nth-child(even) .ob-art { order: 2; }
.ob-copy { padding: clamp(0.25rem, 2vw, 1.25rem); }
.ob-copy > * + * { margin-block-start: 0.85rem; }
.ob-copy h2 { font-size: clamp(1.375rem, 2.2vw, 1.75rem); letter-spacing: -0.03em; }
.ob-copy p { color: var(--color-text-secondary); }
.ob-copy p strong, .ob-copy p code { color: var(--color-text); }
.ob-step-head { display: flex; align-items: center; gap: 0.75rem; }
.ob-n { display: grid; place-items: center; width: 1.9rem; height: 1.9rem; border-radius: 999px; background: var(--color-text); color: var(--color-page); font-size: 0.875rem; font-weight: 650; font-variant-numeric: tabular-nums; }
.ob-badge { display: inline-flex; align-items: center; gap: 0.3rem; padding: 0.2rem 0.65rem; border-radius: 999px; font-size: 0.8125rem; font-weight: 550; }
.ob-badge svg.i { width: 0.9rem; height: 0.9rem; }
.ob-done { background: var(--color-accent-wash); color: var(--color-accent-text); }
.ob-todo, .ob-optional { background: var(--color-bg-inset); color: var(--color-text-secondary); }
.ob-label { font-size: 0.8125rem; font-weight: 550; color: var(--color-text) !important; margin-block-end: -0.35rem; }
.ob-more { font-size: 0.875rem; }
.ob-copy .copy { align-items: flex-start; padding-block: 0.55rem; }
.ob-copy .copy code { white-space: pre-wrap; overflow-wrap: anywhere; overflow: visible; line-height: 1.6; padding-block: 0.2rem; }
.ob-agents { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr)); gap: 1.25rem; padding: 0; margin-block: 1.25rem; list-style: none; }
.ob-agent, .ob-say { display: flex; flex-direction: column; }
.ob-agent > form { margin-block-start: auto; padding-block-start: 0.5rem; }
.ob-agent-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.75rem; }
.ob-agent-head h2 { font-size: 1.375rem; letter-spacing: -0.03em; }
.ob-agent p, .ob-say p, .ob-terminal p { color: var(--color-text-secondary); }
.ob-agent p strong { color: var(--color-text); }
.ob-lines { display: grid; grid-template-columns: minmax(0, 14rem) minmax(0, 1fr); gap: 0.75rem 1.5rem; align-items: center; }
.ob-lines dt { font-weight: 550; }
.ob-lines dd { margin: 0; min-width: 0; }
.ob-terminal { margin-block-start: 1.25rem; }
.ob-terminal summary { cursor: pointer; font-weight: 550; padding-block: 0.5rem; }
.ob-terminal > * + * { margin-block-start: 0.75rem; }
.ob-terminal .copy code { white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 40rem) { .ob-lines { grid-template-columns: minmax(0, 1fr); gap: 0.35rem; } .ob-lines dd { margin-block-end: 0.6rem; } }
.ob-end { display: flex; flex-wrap: wrap; gap: 0.6rem; margin-block-start: 2.5rem; }

/* status pages */
.status { flex: 1; display: grid; place-items: center; padding: 4rem var(--pad); text-align: center; }
.status .code { font-family: var(--mono); font-size: 0.875rem; color: var(--color-text-secondary); margin-block-end: 0.75rem; }
.status p { max-width: 30rem; margin: 0.75rem auto 0; color: var(--color-text-secondary); }
.status .actions { justify-content: center; margin-block-start: 1.75rem; }

/* ---------- smaller screens ---------- */
@media (max-width: 68rem) {
  .projects { grid-template-columns: minmax(0, 1fr); }
  .bar-search input, .bar-search input[type=search]:focus { width: 12rem; }
}
@media (max-width: 52rem) {
  .ob-intro, .ob-step { grid-template-columns: minmax(0, 1fr); }
  .ob-step:nth-child(even) .ob-art { order: 0; }
  .bar { flex-wrap: wrap; gap: 0.5rem 1rem; padding-block: 0.6rem; }
  .bar nav { order: 3; width: 100%; margin-inline: -0.8rem; overflow-x: auto; scrollbar-width: none; }
  .bar-search { display: none; }
  .shell { grid-template-columns: minmax(0, 1fr); }
  .side { position: static; max-height: none; padding: 1.25rem var(--pad) 0.5rem; border-inline-end: 0; border-block-end: 1px solid var(--color-border); }
  .side-head { padding-inline: 0; }
  .side h2 { padding-inline: 0; }
  .side nav { display: flex; overflow-x: auto; scrollbar-width: none; margin-inline: -0.75rem; padding-block-end: 0.75rem; }
  .side ul { display: flex; gap: 0.25rem; flex: none; }
  .side ul a { white-space: nowrap; }
  .bar-search-link { display: inline-grid; }
  .side ul a span { overflow: visible; }
  .side h2, .side-actions { display: none; }
  .side .side-mobile { display: flex; }
  .settings { grid-template-columns: minmax(0, 1fr); }
  .settings-nav { position: static; display: flex; overflow-x: auto; scrollbar-width: none; }
  .settings-nav a { white-space: nowrap; }
  .steps { grid-template-columns: minmax(0, 1fr); }
  .item { flex-wrap: wrap; }
  .item-end { text-align: start; }
}
.side-mobile { display: none; gap: 0.5rem; padding-block: 0.75rem 0.5rem; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; }
}

${ISO_CSS}
`;
