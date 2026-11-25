#!/usr/bin/env node
/* global process, console */
// Lists the projects someone works on, for setting up Anywhere for the first time.
//
//   node find-projects.mjs [--days 120] [--limit 40] [--roots ~/Projects,~/code] [--json]
//
// It looks in three places and reads no conversation or file content:
//   - Claude Code: the folders under ~/.claude/projects, their session files' dates, and the
//     working-folder ("cwd") field in each folder's newest session;
//   - Codex: the first line (session_meta) of each recent session file under ~/.codex/sessions;
//   - git: folders containing .git under the roots (default ~/Projects, ~/code, ~/dev, ~/src,
//     ~/Developer, ~/work), two levels deep.
// For each project it reports whether README.md, CLAUDE.md, AGENTS.md, plan folders or a linked
// .anywhere/ exist, by name only. Run it only after the person has agreed.
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

const HOME = homedir();
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const DAYS = Number(opt("days", "180"));
const LIMIT = Number(opt("limit", "60"));
const ROOTS = opt("roots", "~/Projects,~/code,~/dev,~/src,~/Developer,~/work")
  .split(",")
  .map((r) => resolve(r.trim().replace(/^~(?=$|\/)/, HOME)));
const SINCE = Date.now() - DAYS * 86400_000;

/** Folders that are never a project of their own: temp space, app data, worktrees of another repo. */
function skip(path) {
  if (!path || path === "/" || path === HOME) return true;
  const p = path.toLowerCase();
  return (
    p.startsWith("/tmp") ||
    p.startsWith("/private/") ||
    p.startsWith("/var/") ||
    p.includes(`${sep}library${sep}`) ||
    p.includes(`${sep}node_modules${sep}`) ||
    p.includes(`${sep}.cache${sep}`) ||
    p === join(HOME, ".claude").toLowerCase() ||
    p === join(HOME, ".codex").toLowerCase()
  );
}

/** A worktree under <repo>/.claude/worktrees/<name> (or similar) belongs to <repo>. */
function canonical(path) {
  const m = /^(.*?)\/\.(?:claude|codex|agents)\/worktrees\/[^/]+/.exec(path);
  return m ? m[1] : path;
}

/** The first `bytes` of a file, as text. */
function head(file, bytes) {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function mtime(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

const found = new Map();
function note(rawPath, source, when, count = 1) {
  if (!rawPath || skip(rawPath)) return;
  const path = canonical(rawPath);
  if (skip(path) || !existsSync(path)) return;
  const entry = found.get(path) ?? { path, claudeSessions: 0, codexSessions: 0, git: false, lastActive: 0 };
  if (source === "claude") entry.claudeSessions += count;
  if (source === "codex") entry.codexSessions += count;
  if (source === "git") entry.git = true;
  entry.lastActive = Math.max(entry.lastActive, when);
  found.set(path, entry);
}

// Claude Code
const claudeRoot = join(HOME, ".claude", "projects");
if (existsSync(claudeRoot)) {
  for (const dir of readdirSync(claudeRoot)) {
    const full = join(claudeRoot, dir);
    let files;
    try {
      files = readdirSync(full).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    if (!files.length) continue;
    const dated = files.map((f) => ({ f, t: mtime(join(full, f)) })).sort((a, b) => b.t - a.t);
    if (dated[0].t < SINCE) continue;
    const cwd = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head(join(full, dated[0].f), 262144))?.[1]?.replace(/\\(.)/g, "$1");
    note(cwd, "claude", dated[0].t, files.length);
  }
}

// Codex
const codexRoot = join(HOME, ".codex", "sessions");
function walkCodex(dir, depth) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const full = join(dir, name);
    if (depth < 3) {
      walkCodex(full, depth + 1);
      continue;
    }
    if (!name.endsWith(".jsonl")) continue;
    const t = mtime(full);
    if (t < SINCE) continue;
    const first = head(full, 65536).split("\n")[0];
    try {
      const meta = JSON.parse(first);
      const p = meta.payload ?? meta;
      // Codex runs started by other programs (the SDK, `codex exec` from a tool) are not a person's project.
      if (p.source && p.source !== "cli" && p.source !== "vscode") continue;
      note(p.cwd, "codex", t);
    } catch {
      /* a line too long to parse from its head: skip */
    }
  }
}
if (existsSync(codexRoot)) walkCodex(codexRoot, 0);

// git
for (const root of ROOTS) {
  if (!existsSync(root)) continue;
  const level = (dir, depth) => {
    let names;
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (names.some((d) => d.name === ".git")) {
      note(dir, "git", Math.max(mtime(join(dir, ".git", "logs", "HEAD")), mtime(join(dir, ".git", "index"))));
      return;
    }
    if (depth >= 2) return;
    for (const d of names) {
      if (d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules") level(join(dir, d.name), depth + 1);
    }
  };
  level(root, 0);
}

const PLAN_DIRS = ["docs/superpowers/plans", "docs/plans", "plans", ".agents/plans", "docs/planning"];
const active = [...found.values()].filter((p) => p.lastActive >= SINCE);
const projects = active
  .sort((a, b) => b.lastActive - a.lastActive)
  .slice(0, LIMIT)
  .map((p) => ({
    name: basename(p.path),
    path: p.path,
    lastActive: new Date(p.lastActive).toISOString().slice(0, 10),
    claudeSessions: p.claudeSessions,
    codexSessions: p.codexSessions,
    git: p.git || existsSync(join(p.path, ".git")),
    linked: existsSync(join(p.path, ".anywhere")),
    has: ["README.md", "CLAUDE.md", "AGENTS.md", ".agents/memory.md", ".agents/sessions"].filter((f) => existsSync(join(p.path, f))),
    plans: PLAN_DIRS.filter((d) => existsSync(join(p.path, d))),
  }));

if (args.includes("--json")) {
  console.log(JSON.stringify({ since: new Date(SINCE).toISOString().slice(0, 10), active: active.length, projects }, null, 2));
} else {
  console.log(`Projects active in the last ${DAYS} days (${projects.length} shown of ${active.length}), most recent first:\n`);
  projects.forEach((p, i) => {
    const sessions = [p.claudeSessions && `${p.claudeSessions} Claude Code`, p.codexSessions && `${p.codexSessions} Codex`].filter(Boolean).join(", ");
    console.log(`${String(i + 1).padStart(2)}. ${p.name}  ${p.lastActive}  ${p.path}`);
    console.log(`    ${[sessions && `sessions: ${sessions}`, p.git && "git", p.linked && "linked to Anywhere", p.has.length && `has ${p.has.join(", ")}`, p.plans.length && `plans in ${p.plans.join(", ")}`].filter(Boolean).join(" · ")}`);
  });
}
