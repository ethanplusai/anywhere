#!/usr/bin/env node
/* global process, console */
// Maps the work someone already has on this computer into likely projects, for setting up Anywhere.
//
//   node map-work.mjs [--days 365] [--roots ~/Projects,~/code] [--json] [--no-titles]
//
// It reads, and never changes:
//   - Claude Code and Codex session files: each session's working folder, its date, and a short
//     title (the session's own title, or the first line the person typed, cut to 90 characters);
//     --no-titles leaves titles out. Claude Code is read from every config folder: CLAUDE_CONFIG_DIR
//     and any ~/.claude* folder with a projects/ folder in it;
//   - how many notes Claude Code's own memory keeps for each project (<config>/projects/<folder>/memory/),
//     counted, not read;
//   - git: folders containing .git under the roots, and each repository's remote from .git/config;
//   - the names of a few files in each repository (README.md, CLAUDE.md, AGENTS.md, plan folders)
//     and where it is hosted (from .vercel/project.json, wrangler, netlify, fly, supabase, Dockerfile).
// It reads no other file contents.
//
// Then it groups what it found: every checkout, copy and worktree of one repository becomes one
// entry; repositories are grouped by owner (usually a business) and by product name; temporary
// folders, test runs, generated sites and copies of other people's projects are set aside. The
// result is a draft for the person to confirm, not a decision.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

const HOME = (() => {
  try {
    return realpathSync(homedir());
  } catch {
    return homedir();
  }
})();
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const DAYS = Number(opt("days", "365"));
const ROOTS = opt("roots", "~/Projects,~/code,~/Code,~/dev,~/src,~/Developer,~/work,~/Work,~/Desktop,~/Documents")
  .split(",")
  .map((r) => resolve(r.trim().replace(/^~(?=$|\/)/, HOME)));
const TITLES = !args.includes("--no-titles");
const NOW = Date.now();
const SINCE = NOW - DAYS * 86400_000;
const DAY = 86400_000;

// ------------------------------------------------------------------ small helpers

function head(file, bytes) {
  let fd;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
function mtime(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
const tilde = (p) => (p === HOME ? "~" : p.startsWith(HOME + sep) ? "~" + p.slice(HOME.length) : p);
const day = (t) => (t ? new Date(t).toISOString().slice(0, 10) : null);

/** The same normalisation the server uses: "host/owner/name" in lowercase, or null. */
export function normalizeRepo(input) {
  if (typeof input !== "string") return null;
  let s = input.trim();
  if (!s || s.length > 300) return null;
  s = s.replace(/^[a-z+]+:\/\//i, "").replace(/^[^@/]+@/, "");
  s = s.replace(/^([^/:]+):(?!\d+\/)/, "$1/");
  s = s.replace(/^([^/:]+):\d+\//, "$1/");
  s = s.replace(/\.git\/?$/i, "").replace(/\/+$/, "").toLowerCase();
  return /^[a-z0-9.-]+\.[a-z]{2,}(\/[a-z0-9._-]+){2,3}$/.test(s) ? s : null;
}

/** A session title worth showing: one line, no markup or pasted instructions, nothing that looks like a key. */
function cleanTitle(text) {
  if (typeof text !== "string") return null;
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length < 12) return null;
  if (/^(<|#|\[|Base directory|You are |Caveat:|This session is being continued|Background \(from)/i.test(t)) return null;
  const safe = t.replace(/[A-Za-z0-9_\-+/=]{32,}/g, "…").replace(/\b(sk|pk|ghp|gho|xox[a-z])[-_][A-Za-z0-9_-]{8,}/g, "…");
  return safe.length > 90 ? safe.slice(0, 89).trimEnd() + "…" : safe;
}

// ------------------------------------------------------------------ what a folder is

/** Folders that are never anyone's project: temp space, app data, agents' own folders. */
function scratch(path) {
  const p = path.toLowerCase();
  const inHome = path === HOME || path.startsWith(HOME + sep);
  if (!inHome && (p.startsWith("/tmp") || p.startsWith("/private/") || p.startsWith("/var/") || p.startsWith("/applications/"))) return true;
  if (p.includes(`${sep}library${sep}`) || p.includes(`${sep}node_modules${sep}`)) return true;
  // A hidden folder right under home (~/.something) is an app's, except a repo's own worktrees, handled below.
  const rel = path.startsWith(HOME + sep) ? path.slice(HOME.length + 1) : null;
  if (rel && rel.startsWith(".") && !/\/\.(claude|codex|agents)\/worktrees\//.test(path)) return true;
  return false;
}
/** Folders that hold work but are not a project themselves. */
function container(path) {
  const roots = new Set([HOME, "/", ...ROOTS, join(HOME, "Downloads"), join(HOME, "Documents"), join(HOME, "Desktop")]);
  return roots.has(path);
}
/** Codex's desktop app makes a dated folder per conversation. */
const chatFolder = (path) => /\/Documents\/Codex\/\d{4}-\d{2}-\d{2}\//.test(path + "/") || /\/Documents\/Codex\/\d{4}-\d{2}-\d{2}$/.test(path);
/** A test or factory run: runs/<id>, pairs/<id>, task-workspaces/<id>. */
const runFolder = (path) => /\/(runs|pairs|task-workspaces|workspaces)\/[^/]*[0-9a-f]{6,}/i.test(path) || /\/runs\/[^/]+\/(pairs|repo)\b/.test(path);
/** A worktree under <repo>/.claude/worktrees/<name> (or similar) belongs to <repo>. */
function canonical(path) {
  const m = /^(.*?)\/\.(?:claude|codex|agents)\/worktrees\/[^/]+/.exec(path);
  return m ? m[1] : path;
}

/** The repository a folder is in: its top folder and the config file that names its remotes. */
function repoOf(path) {
  let dir = path;
  for (let i = 0; i < 6 && dir && dir !== HOME && dir !== dirname(dir); i++) {
    const dotgit = join(dir, ".git");
    let st;
    try {
      st = statSync(dotgit);
    } catch {
      dir = dirname(dir);
      continue;
    }
    if (st.isDirectory()) return { top: dir, config: join(dotgit, "config"), gitDir: dotgit };
    // A worktree or submodule: ".git" is a file pointing at the real git folder.
    const pointer = /^gitdir:\s*(.+)$/m.exec(readText(dotgit))?.[1]?.trim();
    if (pointer) {
      const gitDir = resolve(dir, pointer);
      const common = readText(join(gitDir, "commondir")).trim();
      const base = common ? resolve(gitDir, common) : gitDir;
      return { top: dir, config: join(base, "config"), gitDir };
    }
    return { top: dir, config: null, gitDir: null };
  }
  return null;
}
function remoteOf(configPath) {
  if (!configPath) return null;
  const text = readText(configPath);
  const remotes = [...text.matchAll(/\[remote "([^"]+)"\]([^[]*)/g)].map((m) => ({ name: m[1], url: /url\s*=\s*(\S+)/.exec(m[2])?.[1] }));
  const pick = remotes.find((r) => r.name === "origin") ?? remotes[0];
  return pick?.url ? normalizeRepo(pick.url) : null;
}

/** Where it runs, from files that name it. Names only, never keys or tokens. */
function hosting(dir) {
  const out = [];
  const vercel = readText(join(dir, ".vercel", "project.json"));
  if (vercel) {
    const name = /"projectName"\s*:\s*"([^"]+)"/.exec(vercel)?.[1];
    out.push(name ? `Vercel (${name})` : "Vercel");
  } else if (existsSync(join(dir, "vercel.json"))) out.push("Vercel");
  for (const f of ["wrangler.toml", "wrangler.jsonc", "wrangler.json"]) {
    const t = readText(join(dir, f));
    if (t) {
      const name = /^\s*"?name"?\s*[=:]\s*"([^"]+)"/m.exec(t)?.[1];
      out.push(name ? `Cloudflare (${name})` : "Cloudflare");
      break;
    }
  }
  if (existsSync(join(dir, "netlify.toml"))) out.push("Netlify");
  const fly = /^app\s*=\s*"([^"]+)"/m.exec(readText(join(dir, "fly.toml")))?.[1];
  if (fly) out.push(`Fly (${fly})`);
  if (existsSync(join(dir, "supabase", "config.toml")) || existsSync(join(dir, "supabase", "migrations"))) out.push("Supabase");
  if (existsSync(join(dir, "Dockerfile")) || existsSync(join(dir, "docker-compose.yml"))) out.push("Docker");
  return out;
}
const DOCS = ["README.md", "CLAUDE.md", "AGENTS.md", ".agents/memory.md", ".agents/sessions"];
const PLAN_DIRS = ["docs/superpowers/plans", "docs/plans", "plans", ".agents/plans", "docs/planning"];

// ------------------------------------------------------------------ gather folders

/** Every folder seen, before grouping: sessions, dates and titles. */
const folders = new Map();
const setAside = { scratch: 0, chats: 0, loose: 0, runs: 0 };
function see(rawPath, source, when, title) {
  if (!rawPath || typeof rawPath !== "string") return;
  const path = canonical(rawPath.replace(/\/+$/, "") || "/");
  if (scratch(path)) return void (source !== "git" && setAside.scratch++);
  if (chatFolder(path)) return void (source !== "git" && setAside.chats++);
  if (container(path)) return void (source !== "git" && setAside.loose++);
  if (runFolder(path)) return void (source !== "git" && setAside.runs++);
  const f = folders.get(path) ?? { path, claude: 0, codex: 0, last: 0, titles: [], memory: [] };
  if (source === "claude") f.claude++;
  if (source === "codex") f.codex++;
  f.last = Math.max(f.last, when || 0);
  if (title && TITLES && f.titles.length < 12 && !f.titles.includes(title)) f.titles.push(title);
  folders.set(path, f);
  return f;
}

/**
 * Every Claude Code config folder: the one CLAUDE_CONFIG_DIR names, and any folder in the home
 * folder whose name starts with ".claude" and holds a projects/ folder. People keep more than one
 * (a work and a personal account, or a tool that runs its own), and each has its own sessions.
 */
function claudeRoots() {
  const found = new Map();
  const add = (dir) => {
    const projects = join(dir, "projects");
    if (!existsSync(projects)) return;
    try {
      found.set(realpathSync(projects), projects);
    } catch {
      /* unreadable */
    }
  };
  if (process.env.CLAUDE_CONFIG_DIR) add(resolve(process.env.CLAUDE_CONFIG_DIR));
  let names = [];
  try {
    names = readdirSync(HOME, { withFileTypes: true });
  } catch {
    /* no home listing */
  }
  for (const d of names) if (d.isDirectory() && /^\.claude(?:$|[-_.])/.test(d.name)) add(join(HOME, d.name));
  return [...found.values()];
}
const CLAUDE_ROOTS = claudeRoots();

/** Claude Code's own saved memory for a project: markdown notes in <config>/projects/<folder>/memory/. */
function memoryNotes(dir) {
  try {
    return readdirSync(join(dir, "memory")).filter((n) => n.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

/** The working folder a Claude Code session ran in, from the start of its file. */
function sessionCwd(file) {
  for (const line of head(file, 65536).split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const d = JSON.parse(line);
      if (typeof d.cwd === "string") return d.cwd;
    } catch {
      /* skip */
    }
  }
  return null;
}

// Claude Code: one file per session, under a folder named after the working folder.
for (const claudeRoot of CLAUDE_ROOTS) {
  for (const dir of readdirSync(claudeRoot)) {
    const full = join(claudeRoot, dir);
    let files;
    try {
      files = readdirSync(full).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    let folderCwd = null;
    for (const f of files) {
      const file = join(full, f);
      const t = mtime(file);
      if (t < SINCE) continue;
      const text = head(file, 131072);
      let cwd = null,
        title = null,
        first = null;
      for (const line of text.split("\n")) {
        if (!line.startsWith("{")) continue;
        let d;
        try {
          d = JSON.parse(line);
        } catch {
          continue;
        }
        cwd ??= typeof d.cwd === "string" ? d.cwd : null;
        if (!title && (d.type === "ai-title" || d.type === "summary")) title = cleanTitle(d.aiTitle ?? d.title ?? d.summary);
        if (!first && d.type === "user" && !d.isMeta) {
          const c = d.message?.content;
          const s = typeof c === "string" ? c : Array.isArray(c) ? c.find((b) => b?.type === "text")?.text : null;
          first = cleanTitle(s);
        }
        if (cwd && title) break;
      }
      folderCwd ??= cwd;
      see(cwd, "claude", t, title ?? first);
    }
    // Saved memory belongs to the project however old its sessions are.
    const notes = memoryNotes(full);
    if (notes) {
      folderCwd ??= files.map((f) => sessionCwd(join(full, f))).find(Boolean) ?? null;
      const f = see(folderCwd, "memory", 0, null);
      if (f) f.memory.push({ path: tilde(join(full, "memory")), notes });
    }
  }
}

// Codex: sessions under ~/.codex/sessions/YYYY/MM/DD.
const codexRoot = join(process.env.CODEX_HOME || join(HOME, ".codex"), "sessions");
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
    let cwd = null,
      first = null,
      skipIt = false;
    for (const line of head(full, 131072).split("\n")) {
      if (!line.startsWith("{")) continue;
      let d;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      const p = d.payload ?? {};
      if (d.type === "session_meta") {
        cwd = p.cwd ?? null;
        // Runs started by other programs (the SDK, `codex exec` from a tool) are not a person's own.
        if (p.source && !["cli", "vscode", "desktop", "app"].includes(p.source)) skipIt = true;
      }
      if (!first && d.type === "response_item" && p.role === "user") {
        for (const c of p.content ?? []) {
          first = cleanTitle(c?.text);
          if (first) break;
        }
      }
      if (cwd && first) break;
    }
    if (!skipIt) see(cwd, "codex", t, first);
  }
}
if (existsSync(codexRoot)) walkCodex(codexRoot, 0);

/**
 * When someone last committed or switched branch here, from the last line of the reflog. The
 * folder's own dates move whenever any tool looks at the repository, so they are not used.
 */
const clonedOnly = new Set();
function lastCommit(gitDir) {
  let logs = join(gitDir, "logs", "HEAD");
  if (!existsSync(logs)) {
    const pointer = /^gitdir:\s*(.+)$/m.exec(readText(gitDir))?.[1]?.trim();
    if (!pointer) return 0;
    logs = join(resolve(dirname(gitDir), pointer), "logs", "HEAD");
  }
  const size = (() => {
    try {
      return statSync(logs).size;
    } catch {
      return 0;
    }
  })();
  if (!size) return 0;
  let fd;
  try {
    fd = openSync(logs, "r");
    const n = Math.min(size, 4096);
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, size - n);
    const last = buf.toString("utf8").trimEnd().split("\n").pop() ?? "";
    const seconds = Number(/> (\d{9,11}) [+-]\d{4}\t/.exec(last)?.[1]);
    // Only ever cloned: the reflog has one entry and it is the clone.
    if (/\tclone: /.test(last) && !buf.toString("utf8").trimEnd().includes("\n")) clonedOnly.add(dirname(gitDir));
    return Number.isFinite(seconds) ? seconds * 1000 : 0;
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// git: repositories under the roots, two levels down, and repositories nested one level inside one.
for (const root of ROOTS) {
  if (!existsSync(root)) continue;
  const level = (dir, depth) => {
    let names;
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const folders = names.filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules");
    if (names.some((d) => d.name === ".git")) {
      see(dir, "git", lastCommit(join(dir, ".git")));
      // A repository that holds other repositories (a workspace): take those too, one level down.
      if (depth < 3) for (const d of folders) if (existsSync(join(dir, d.name, ".git"))) level(join(dir, d.name), 3);
      return;
    }
    if (depth >= 2) return;
    for (const d of folders) level(join(dir, d.name), depth + 1);
  };
  level(root, 0);
}

// ------------------------------------------------------------------ group into repositories

/** One entry per repository (or per folder, when it is not in git). */
const repos = new Map();
/** Folders that had sessions but no longer exist: moved, renamed or deleted. Their names still say what the work was. */
const gone = [];
for (const f of folders.values()) {
  if (!existsSync(f.path)) {
    if (f.claude + f.codex) gone.push({ path: tilde(f.path), sessions: f.claude + f.codex, lastActive: day(f.last), titles: f.titles.slice(0, 3) });
    continue;
  }
  const r = repoOf(f.path);
  let top = r?.top ?? f.path;
  try {
    top = realpathSync(top);
  } catch {
    /* keep as is */
  }
  const remote = r ? remoteOf(r.config) : null;
  const key = remote ?? `local:${top}`;
  const e = repos.get(key) ?? { key, repo: remote, folders: new Map(), claude: 0, codex: 0, last: 0, titles: [], memory: [] };
  for (const m of f.memory) if (!e.memory.some((x) => x.path === m.path)) e.memory.push(m);
  const c = e.folders.get(top) ?? { path: top, sessions: 0, last: 0 };
  c.sessions += f.claude + f.codex;
  c.last = Math.max(c.last, f.last);
  e.folders.set(top, c);
  e.claude += f.claude;
  e.codex += f.codex;
  e.last = Math.max(e.last, f.last);
  for (const t of f.titles) if (e.titles.length < 12 && !e.titles.includes(t)) e.titles.push(t);
  repos.set(key, e);
}

// Whose repositories are these? An owner counts as the person's own when they worked in one of its
// repositories or keep several of them; a lone clone with no sessions is someone else's project.
const owners = new Map();
for (const e of repos.values()) {
  if (!e.repo) continue;
  const owner = e.repo.split("/").slice(0, -1).join("/");
  const o = owners.get(owner) ?? { repos: 0, sessions: 0 };
  o.repos++;
  o.sessions += e.claude + e.codex;
  owners.set(owner, o);
}
const ownOwner = (owner) => {
  const o = owners.get(owner);
  return Boolean(o && (o.sessions > 0 || o.repos >= 2));
};

/** A product name from a repository name: the same stem groups an app with its website and admin. */
const SUFFIXES =
  /[-_.](website|site|web|www|landing|admin|dashboard|app|apps|cloud|hosted|api|server|backend|frontend|front|desktop|cli|sdk|docs|private|public|oss|release|redesign|rebuild|staging|dev|beta|v\d+|creators|portal|launch-kit|kit|plugin|worker|workers|ui|mobile|ios|android|marketing|wt-[a-z0-9-]+)$/;
function stem(name) {
  let s = name.toLowerCase().replace(/\.(com|ai|io|dev|app|co|net|org|wtf|rent)$/, "");
  for (let i = 0; i < 4; i++) {
    const next = s.replace(SUFFIXES, "");
    if (next === s || next.length < 3) break;
    s = next;
  }
  return s.replace(/[-_.]/g, "");
}

const entries = [...repos.values()].map((e) => {
  const checkouts = [...e.folders.values()].sort((a, b) => b.sessions - a.sessions || b.last - a.last);
  const name = e.repo ? e.repo.split("/").pop() : basename(checkouts[0].path);
  // The main folder: the one named like the repository, else the one worked in most.
  const main = checkouts.find((c) => basename(c.path).toLowerCase() === name) ?? checkouts[0];
  const owner = e.repo ? e.repo.split("/").slice(0, -1).join("/") : null;
  const sessions = e.claude + e.codex;
  let kind = "project";
  if (/[-_][0-9a-f]{6}(-\d+)?$/.test(name)) kind = "generated";
  else if (owner && !ownOwner(owner)) kind = "others";
  const age = NOW - e.last;
  const status = age < 30 * DAY ? "active" : age < 120 * DAY ? "recent" : "old";
  const cloned = sessions === 0 && checkouts.every((c) => clonedOnly.has(c.path));
  const has = DOCS.filter((f) => existsSync(join(main.path, f)));
  const plans = PLAN_DIRS.filter((d) => existsSync(join(main.path, d)));
  return {
    name,
    repo: e.repo,
    owner,
    product: stem(name),
    kind,
    status,
    cloned,
    lastActive: day(e.last),
    sessions: { claude: e.claude, codex: e.codex },
    path: tilde(main.path),
    checkouts: checkouts.map((c) => tilde(c.path)),
    renamed: basename(main.path).toLowerCase() !== name ? basename(main.path) : null,
    linked: checkouts.some((c) => existsSync(join(c.path, ".anywhere"))),
    has,
    plans,
    hosting: hosting(main.path),
    memory: e.memory,
    titles: e.titles.slice(0, 5),
    _sessions: sessions,
    _last: e.last,
  };
});

// Group repositories into products: same owner and same stem, or a repository named after another's folder.
const products = new Map();
for (const r of entries) {
  if (r.kind !== "project") continue;
  const k = `${r.owner ?? "local"}::${r.product}`;
  const p = products.get(k) ?? { owner: r.owner, product: r.product, repos: [] };
  p.repos.push(r);
  products.set(k, p);
}
const productList = [...products.values()].map((p) => {
  p.repos.sort((a, b) => b._sessions - a._sessions || b._last - a._last);
  const last = Math.max(...p.repos.map((r) => r._last));
  const sessions = p.repos.reduce((n, r) => n + r._sessions, 0);
  const age = NOW - last;
  const status = age < 30 * DAY ? "active" : age < 120 * DAY ? "recent" : "old";
  // A suggestion for the person to confirm: what they work on now in full, what is paused in one line.
  const cloned = p.repos.every((r) => r.cloned);
  const suggest = status === "active" && sessions >= 3 ? "bring_in" : status === "old" || cloned ? "skip" : "brief";
  const reason = cloned
    ? "cloned here, never worked in"
    : [sessions ? `${sessions} session${sessions === 1 ? "" : "s"}` : "no agent sessions", `last ${day(last)}`].join(", ");
  return {
    owner: p.owner,
    name: p.repos.find((r) => r.name.replace(/[-_.]/g, "") === p.product)?.name ?? p.repos[0].name,
    status,
    suggest,
    reason,
    sessions,
    lastActive: day(last),
    repos: p.repos.map(({ _sessions, _last, ...r }) => r),
    _last: last,
  };
});

const byOwner = new Map();
for (const p of productList) {
  const k = p.owner ?? "Only on this computer (no git remote)";
  const g = byOwner.get(k) ?? { owner: k, products: [], _last: 0, sessions: 0 };
  g.products.push(p);
  g._last = Math.max(g._last, p._last);
  g.sessions += p.sessions;
  byOwner.set(k, g);
}
const groups = [...byOwner.values()]
  .sort((a, b) => b.sessions - a.sessions || b._last - a._last)
  .map((g) => ({
    owner: g.owner,
    sessions: g.sessions,
    products: g.products.sort((a, b) => b._last - a._last).map(({ _last, ...p }) => p),
  }));

const strip = ({ _sessions, _last, ...r }) => r;
const result = {
  since: day(SINCE),
  read: {
    claudeConfigs: CLAUDE_ROOTS.map((r) => tilde(dirname(r))),
    codex: existsSync(codexRoot) ? tilde(dirname(codexRoot)) : null,
  },
  groups,
  setAside: {
    generated: entries.filter((r) => r.kind === "generated").map(strip),
    others: entries.filter((r) => r.kind === "others").map(strip),
    goneFolders: gone.sort((a, b) => b.sessions - a.sessions),
    sessionsInTempFolders: setAside.scratch,
    sessionsInChatFolders: setAside.chats,
    sessionsNotInAProject: setAside.loose,
    sessionsInTestRuns: setAside.runs,
  },
};

if (args.includes("--json")) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const n = productList.length;
  const counts = { bring_in: 0, brief: 0, skip: 0 };
  for (const p of productList) counts[p.suggest]++;
  console.log(
    `Work found since ${result.since}: ${n} likely projects in ${groups.length} groups (by repository owner). ` +
      `Suggested: ${counts.bring_in} to bring in, ${counts.brief} as one line, ${counts.skip} to skip. A draft to confirm with the person.`,
  );
  console.log(`Read sessions from: ${[...result.read.claudeConfigs, result.read.codex].filter(Boolean).join(", ") || "nothing found"}\n`);
  for (const g of groups) {
    console.log(`## ${g.owner}  (${g.sessions} sessions)`);
    const old = g.products.filter((p) => p.suggest === "skip");
    for (const p of g.products.filter((x) => x.suggest !== "skip")) {
      const full = p.suggest === "bring_in";
      console.log(`- ${p.name}  [${p.suggest}]  ${p.reason}`);
      for (const r of p.repos) {
        const bits = [
          r.repo ?? "no remote",
          r.checkouts.length > 1 ? `${r.checkouts.length} copies: ${r.checkouts.slice(0, full ? 4 : 2).join(", ")}${r.checkouts.length > (full ? 4 : 2) ? ", …" : ""}` : r.path,
          r.renamed && `folder named "${r.renamed}"`,
          r.hosting.length && r.hosting.join(", "),
          full && r.has.length && `has ${r.has.join(", ")}`,
          full && r.plans.length && `plans in ${r.plans.join(", ")}`,
          full && r.memory.length && `saved agent memory: ${r.memory.map((m) => `${m.notes} notes in ${m.path}`).join(", ")}`,
          r.linked && "linked to Anywhere",
        ].filter(Boolean);
        console.log(`    ${bits.join(" · ")}`);
        if (r.titles.length) console.log(`      sessions about: ${r.titles.slice(0, full ? 3 : 1).join(" | ")}`);
      }
    }
    const clonedOnly = old.filter((p) => p.reason.startsWith("cloned"));
    const stale = old.filter((p) => !p.reason.startsWith("cloned"));
    if (stale.length) console.log(`  [skip] Not touched in 120+ days: ${stale.map((p) => p.name).join(", ")}`);
    if (clonedOnly.length) console.log(`  [skip] Cloned here, never worked in: ${clonedOnly.map((p) => p.name).join(", ")}`);
    console.log("");
  }
  const sa = result.setAside;
  console.log("## Set aside");
  if (sa.generated.length) console.log(`- Generated (name ends in an id): ${sa.generated.map((r) => r.name).join(", ")}`);
  if (sa.others.length) console.log(`- Other people's projects (cloned, never worked in): ${sa.others.map((r) => r.repo).join(", ")}`);
  if (sa.goneFolders.length) {
    const top = sa.goneFolders.slice(0, 12).map((g) => `${g.path} (${g.sessions})`);
    console.log(`- Folders with sessions that no longer exist: ${top.join(", ")}${sa.goneFolders.length > 12 ? `, and ${sa.goneFolders.length - 12} more` : ""}`);
  }
  console.log(
    `- Sessions in temporary or app folders: ${sa.sessionsInTempFolders}; in Codex chat folders: ${sa.sessionsInChatFolders}; ` +
      `in test runs: ${sa.sessionsInTestRuns}; in home, Desktop or other folders that hold many projects: ${sa.sessionsNotInAProject}`,
  );
}
