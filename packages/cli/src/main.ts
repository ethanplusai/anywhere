import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Api, ApiError } from "./api.js";
import { normalizeServer, readCredentials, tokenFor, writeCredentials } from "./config.js";
import { pull, push, status, type Ctx } from "./engine.js";
import { CliError } from "./errors.js";
import { DIR, LINK, findLinked, readLink, writeLink, type LinkFile, type Linked } from "./link.js";
import { renderStatus, renderSync, syncJson } from "./render.js";

export type Env = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  /** Ask for a secret without echoing it. */
  readSecret: (prompt: string) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
};

const HELP = `anywr: keep a project's Anywhere pages in a local, gitignored .anywhere/ folder

Usage: anywr <command> [options]

Commands:
  login <server-url>       Sign in with a personal access token (--token, or ANYWR_TOKEN, or paste when asked)
  logout [server-url]      Forget the stored token
  projects                 List your projects
  link <project-slug>      Link this folder to a project and pull its pages (--create "<name>" makes it first)
  pull                     Fetch pages changed on the server
  push                     Send pages changed here
  status                   Show what differs

Options:
  --json                   Machine-readable output (status, pull, push, projects)
  --server <url>           Server to use when not given by the link or a single login (link, projects)
  -h, --help               Show help
  -v, --version            Show the version

A conflict (a page changed on both sides) leaves the server copy in <name>.remote.md next to the page
and makes pull, push and status exit with code 1. Merge into <name>.md, delete the .remote.md, then run
anywr push.
`;

const COMMAND_HELP: Record<string, string> = {
  login: "Usage: anywr login <server-url> [--token <token>]\nThe token can also come from ANYWR_TOKEN or be pasted at the prompt. It is verified with GET /api/v1/me and stored with mode 0600.\n",
  logout: "Usage: anywr logout [server-url]\nRemoves the stored token for that server (default: the last one you logged in to).\n",
  projects: "Usage: anywr projects [--server <url>] [--json]\n",
  link: 'Usage: anywr link <project-slug> [--create "<name>"] [--server <url>] [--json]\nCreates .anywhere/ here, ignores it in git, and pulls.\n',
  pull: "Usage: anywr pull [--json]\n",
  push: "Usage: anywr push [--json]\n",
  status: "Usage: anywr status [--json]\n",
};

function version(): Promise<string> {
  return readFile(new URL("../package.json", import.meta.url), "utf8").then((s) => (JSON.parse(s) as { version: string }).version);
}

function run(cmd: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd }, (error) => {
      if (!error) resolve(0);
      else resolve(typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : -1);
    });
  });
}

async function ensureGitignored(cwd: string): Promise<string | null> {
  const code = await run("git", ["check-ignore", "-q", `${DIR}/${LINK}`], cwd);
  if (code !== 1) return null; // 0: already ignored; 128/-1: not a git repo or no git
  const path = join(cwd, ".gitignore");
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch {
    /* no .gitignore yet */
  }
  const sep = existing === "" || existing.endsWith("\n") ? "" : "\n";
  await writeFile(path, `${existing}${sep}${DIR}/\n`);
  return `Added ${DIR}/ to .gitignore.`;
}

async function resolveServer(e: Env, opt: { server?: string | undefined }, linked?: Linked | null): Promise<string> {
  if (opt.server) return normalizeServer(opt.server);
  if (e.env["ANYWR_SERVER"]) return normalizeServer(e.env["ANYWR_SERVER"]);
  if (linked) return linked.link.server;
  const creds = await readCredentials(e.env);
  const servers = Object.keys(creds.servers);
  if (creds.default && creds.servers[creds.default]) return creds.default;
  if (servers.length === 1) return servers[0] as string;
  if (e.env["ANYWR_TOKEN"]) throw new CliError("Say which server with --server <url> or ANYWR_SERVER.", 2);
  throw new CliError("Not signed in. Run: anywr login <server-url>");
}

const tryFindLinked = (cwd: string) => findLinked(cwd).catch(() => null);

type Opts = { json?: boolean | undefined; server?: string | undefined; token?: string | undefined; create?: string | undefined; help?: boolean | undefined };

function parse(args: string[]): { positionals: string[]; values: Opts } {
  try {
    const r = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: "boolean" },
        server: { type: "string" },
        token: { type: "string" },
        create: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
    return { positionals: r.positionals, values: r.values };
  } catch (e) {
    throw new CliError(`${(e as Error).message}. Try: anywr --help`, 2);
  }
}

async function loadCtx(e: Env, o: Opts): Promise<{ ctx: Ctx; linked: Linked }> {
  const linked = await findLinked(e.cwd);
  const token = await tokenFor(e.env, linked.link.server, o.server);
  const api = new Api(linked.link.server, token, e.sleep ? { sleep: e.sleep } : {});
  return { ctx: { dir: linked.dir, link: linked.link, api }, linked };
}

async function syncCommand(kind: "pull" | "push", o: Opts, e: Env): Promise<number> {
  const { ctx } = await loadCtx(e, o);
  let result;
  try {
    result = await (kind === "pull" ? pull(ctx) : push(ctx));
  } finally {
    await writeLink(ctx.dir, ctx.link);
  }
  if (o.json) e.stdout(syncJson(kind, ctx.link.server, ctx.link.project, result));
  else {
    const r = renderSync(kind, ctx.link.project, result);
    e.stdout(r.out);
    if (r.err) e.stderr(r.err);
  }
  return result.conflicts.length || result.errors.length ? 1 : 0;
}

async function login(pos: string[], o: Opts, e: Env): Promise<number> {
  if (!pos[0]) throw new CliError("Usage: anywr login <server-url>", 2);
  const server = normalizeServer(pos[0]);
  let token = (o.token ?? e.env["ANYWR_TOKEN"] ?? "").trim();
  if (!token) token = (await e.readSecret(`Paste a personal access token for ${server}: `)).trim();
  if (!token) throw new CliError("No token given.", 2);
  let email: string;
  try {
    email = (await new Api(server, token, e.sleep ? { sleep: e.sleep } : {}).me()).user.email;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) throw new CliError(`${server} did not accept that token. Create a new one on its web page.`);
    throw err;
  }
  const creds = await readCredentials(e.env);
  creds.servers[server] = { token };
  creds.default = server;
  await writeCredentials(e.env, creds);
  if (o.json) e.stdout(JSON.stringify({ ok: true, server, email }) + "\n");
  else e.stdout(`Signed in to ${server} as ${email}.\n`);
  return 0;
}

async function logout(pos: string[], o: Opts, e: Env): Promise<number> {
  const creds = await readCredentials(e.env);
  const arg = pos[0] ?? o.server;
  const server = arg ? normalizeServer(arg) : creds.default;
  if (!server || !creds.servers[server]) {
    e.stdout("Not signed in; nothing to do.\n");
    return 0;
  }
  delete creds.servers[server];
  if (creds.default === server) {
    const next = Object.keys(creds.servers)[0];
    if (next) creds.default = next;
    else delete creds.default;
  }
  await writeCredentials(e.env, creds);
  e.stdout(`Signed out of ${server}.\n`);
  return 0;
}

async function projects(o: Opts, e: Env): Promise<number> {
  const server = await resolveServer(e, o, await tryFindLinked(e.cwd));
  const api = new Api(server, await tokenFor(e.env, server, o.server), e.sleep ? { sleep: e.sleep } : {});
  const { projects: list } = await api.projects();
  if (o.json) e.stdout(JSON.stringify({ ok: true, server, projects: list }, null, 2) + "\n");
  else if (list.length === 0) e.stdout('No projects yet. Create one with: anywr link <slug> --create "<name>"\n');
  else for (const p of list) e.stdout(`${p.slug.padEnd(28)} ${p.name}${p.description ? `: ${p.description}` : ""}\n`);
  return 0;
}

async function link(pos: string[], o: Opts, e: Env): Promise<number> {
  const slug = pos[0];
  if (!slug) throw new CliError('Usage: anywr link <project-slug> [--create "<name>"]', 2);
  const dir = join(e.cwd, DIR);
  const exists = await stat(join(dir, LINK)).then(() => true, () => false);
  const existing = exists ? await readLink(dir) : null;
  const server = existing?.server ?? (await resolveServer(e, o));
  if (existing && existing.project !== slug) {
    throw new CliError(`This folder is already linked to "${existing.project}". Delete ${DIR}/ first to link a different project.`);
  }
  const api = new Api(server, await tokenFor(e.env, server, o.server), e.sleep ? { sleep: e.sleep } : {});

  if (o.create !== undefined) {
    try {
      await api.createProject({ name: o.create, slug });
      e.stderr(`Created project "${o.create}" (${slug}).\n`);
    } catch (err) {
      if (err instanceof ApiError && err.code === "slug_taken") {
        throw new CliError(`A project with the slug "${slug}" already exists. Link it without --create, or pick another slug.`);
      }
      throw err;
    }
  } else {
    try {
      await api.getProject(slug);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        throw new CliError(`No project "${slug}" on ${server}. See yours with: anywr projects, or create it with: anywr link ${slug} --create "<name>"`);
      }
      if (err instanceof ApiError && err.status === 401) throw new CliError(`The server rejected the token. Run: anywr login ${server}`);
      throw err;
    }
  }
  await mkdir(dir, { recursive: true });
  const note = await ensureGitignored(e.cwd);
  if (note) e.stderr(note + "\n");
  const lf: LinkFile = existing ?? { server, project: slug, pages: {} };
  await writeLink(dir, lf);
  const ctx: Ctx = { dir, link: lf, api };
  let result;
  try {
    result = await pull(ctx);
  } finally {
    await writeLink(dir, lf);
  }
  if (o.json) e.stdout(syncJson("link", server, slug, result));
  else {
    e.stdout(`Linked ${e.cwd} to ${slug} on ${server}.\n`);
    const r = renderSync("pull", slug, result);
    e.stdout(r.out);
    if (r.err) e.stderr(r.err);
  }
  return result.conflicts.length || result.errors.length ? 1 : 0;
}

async function statusCommand(o: Opts, e: Env): Promise<number> {
  const { ctx } = await loadCtx(e, o);
  const s = await status(ctx);
  const open = s.pages.some((p) => p.conflict);
  if (o.json) {
    e.stdout(JSON.stringify({ ok: !open, server: ctx.link.server, project: ctx.link.project, pages: s.pages, ...(s.warning ? { warning: s.warning } : {}) }, null, 2) + "\n");
  } else {
    const r = renderStatus(ctx.link.project, s.pages, s.warning);
    e.stdout(r.out);
    if (r.err) e.stderr(r.err);
  }
  return open ? 1 : 0;
}

export async function main(argv: string[], e: Env): Promise<number> {
  let json = argv.includes("--json");
  try {
    const cmd = argv[0];
    if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
      e.stdout(HELP);
      return 0;
    }
    if (cmd === "--version" || cmd === "-v") {
      e.stdout((await version()) + "\n");
      return 0;
    }
    const { positionals, values } = parse(argv.slice(1));
    json = values.json === true;
    if (values.help) {
      e.stdout(COMMAND_HELP[cmd] ?? HELP);
      return 0;
    }
    switch (cmd) {
      case "login":
        return await login(positionals, values, e);
      case "logout":
        return await logout(positionals, values, e);
      case "projects":
        return await projects(values, e);
      case "link":
        return await link(positionals, values, e);
      case "pull":
      case "push":
        return await syncCommand(cmd, values, e);
      case "status":
        return await statusCommand(values, e);
      default:
        throw new CliError(`Unknown command "${cmd}". Try: anywr --help`, 2);
    }
  } catch (err) {
    const message = err instanceof CliError || err instanceof ApiError ? err.message : `Unexpected error: ${(err as Error).message}`;
    const code = err instanceof CliError ? err.exitCode : 1;
    if (json) e.stdout(JSON.stringify({ ok: false, error: message }) + "\n");
    else e.stderr(`anywr: ${message}\n`);
    return code;
  }
}
