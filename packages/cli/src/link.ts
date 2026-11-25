import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import { CliError } from "./errors.js";
import { isPagePath, type RecordEntry } from "./sync.js";

export type LinkFile = { server: string; project: string; pages: Record<string, RecordEntry> };

export const DIR = ".anywhere";
export const LINK = ".link.json";

export type Linked = { root: string; dir: string; link: LinkFile };

/** Find `.anywhere/.link.json` by walking up from `start`. */
export async function findLinked(start: string): Promise<Linked> {
  let cur = start;
  for (;;) {
    const dir = join(cur, DIR);
    const isFile = await stat(join(dir, LINK)).then((s) => s.isFile(), () => false);
    if (isFile) return { root: cur, dir, link: await readLink(dir) };
    const up = dirname(cur);
    if (up === cur || cur === parse(cur).root) {
      throw new CliError("This folder is not linked to an Anywhere project. Run: anywr link <project-slug>");
    }
    cur = up;
  }
}

export async function readLink(dir: string): Promise<LinkFile> {
  const path = join(dir, LINK);
  let parsed: Partial<LinkFile>;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as Partial<LinkFile>;
  } catch (e) {
    throw new CliError(`Cannot read ${path}: ${(e as Error).message}`);
  }
  if (typeof parsed.server !== "string" || typeof parsed.project !== "string") {
    throw new CliError(`${path} is damaged. Delete the ${DIR} folder and run: anywr link <project-slug>`);
  }
  // A link file can arrive with a cloned repository, so its page names are not trusted: only real
  // page paths are kept, and nothing else is ever read, written or deleted on their say-so.
  const pages: Record<string, RecordEntry> = {};
  for (const [path, entry] of Object.entries(parsed.pages ?? {})) if (isPagePath(path)) pages[path] = entry;
  return { server: parsed.server, project: parsed.project, pages };
}

export async function writeLink(dir: string, link: LinkFile): Promise<void> {
  const path = join(dir, LINK);
  const tmp = `${path}.${process.pid}.tmp`;
  const sorted = Object.fromEntries(Object.entries(link.pages).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(tmp, JSON.stringify({ ...link, pages: sorted }, null, 2) + "\n");
  await rename(tmp, path);
}
