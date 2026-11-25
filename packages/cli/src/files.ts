import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { isPagePath } from "./sync.js";

export const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

export const remoteFileName = (page: string): string => page.replace(/\.md$/, ".remote.md");
export const REMOTE_SUFFIX = ".remote.md";

async function walk(dir: string, prefix: string, depth: number, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (depth < 1) await walk(join(dir, e.name), rel, depth + 1, out);
    } else if (e.isFile()) out.push(rel);
  }
}

/** Page files under `dir` mapped to the sha256 of their raw bytes. Conflict files and non-pages are skipped. */
export async function listLocalPages(dir: string): Promise<Map<string, string>> {
  const all: string[] = [];
  await walk(dir, "", 0, all);
  const out = new Map<string, string>();
  for (const rel of all) {
    if (rel.endsWith(REMOTE_SUFFIX) || !isPagePath(rel)) continue;
    out.set(rel, sha256(await readFile(join(dir, rel))));
  }
  return out;
}

/** Pages that have a `<name>.remote.md` beside them (open conflicts). */
export async function listConflictFiles(dir: string): Promise<string[]> {
  const all: string[] = [];
  await walk(dir, "", 0, all);
  return all
    .filter((rel) => rel.endsWith(REMOTE_SUFFIX))
    .map((rel) => rel.slice(0, -REMOTE_SUFFIX.length) + ".md")
    .filter(isPagePath)
    .sort();
}

/**
 * The full path of `rel` under `dir`. Page paths can come from a server or from a link file someone
 * else wrote, so a path that would land outside `dir` is refused here as well as where it arrives.
 */
function inside(dir: string, rel: string): string {
  const root = resolve(dir);
  const path = resolve(root, rel);
  if (!path.startsWith(root + sep)) throw new Error(`Refusing to touch "${rel}": it is outside ${dir}.`);
  return path;
}

export async function writeBytes(dir: string, rel: string, bytes: Buffer): Promise<void> {
  const path = inside(dir, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

export async function removeFile(dir: string, rel: string): Promise<void> {
  try {
    await unlink(inside(dir, rel));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (rel.includes("/")) await rmdir(dirname(inside(dir, rel))).catch(() => undefined); // only if empty
}

export async function readBytes(dir: string, rel: string): Promise<Buffer> {
  return readFile(inside(dir, rel));
}
