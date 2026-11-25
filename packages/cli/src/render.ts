import type { PageStatus, SyncResult } from "./engine.js";

const pad = (s: string, n: number) => s.padEnd(n);

export function renderSync(kind: "pull" | "push", project: string, r: SyncResult): { out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const real = r.changes.filter((c) => c.action !== "skipped");
  if (real.length === 0 && r.conflicts.length === 0 && r.errors.length === 0) {
    out.push(kind === "pull" ? `${project}: already up to date.` : `${project}: nothing to push.`);
  } else {
    out.push(`${kind === "pull" ? "Pulled" : "Pushed"} ${project}: ${real.length} change${real.length === 1 ? "" : "s"}.`);
    for (const c of r.changes) out.push(`  ${pad(c.action, 9)} ${c.path}${c.detail ? `  (${c.detail})` : ""}`);
  }
  for (const w of r.warnings) err.push(`warning: ${w}`);
  for (const e of r.errors) err.push(`error: ${e.path}: ${e.message}`);
  if (r.conflicts.length) {
    out.push("");
    out.push(
      `${r.conflicts.length} conflict${r.conflicts.length === 1 ? "" : "s"} open: the page changed here and on the server.`,
    );
    for (const c of r.conflicts) {
      const name = c.path.split("/").pop() ?? c.path;
      const remoteName = c.remoteFile.split("/").pop() ?? c.remoteFile;
      out.push(`  ${c.path}`);
      out.push(`    Server copy: ${c.remoteFile}`);
      out.push(
        `    Next: merge what matters from ${remoteName} into ${name}, delete ${remoteName}, then run: anywr push`,
      );
    }
  }
  return { out: out.join("\n") + "\n", err: err.length ? err.join("\n") + "\n" : "" };
}

export function syncJson(command: string, server: string, project: string, r: SyncResult): string {
  const ok = r.conflicts.length === 0 && r.errors.length === 0;
  return JSON.stringify({ ok, command, server, project, ...r }, null, 2) + "\n";
}

const LOCAL_WORD: Record<string, string> = { changed: "edited here", new: "new here", deleted: "deleted here" };
const REMOTE_WORD: Record<string, string> = {
  changed: "changed on server",
  new: "new on server",
  deleted: "deleted on server",
};

export function renderStatus(project: string, pages: PageStatus[], warning?: string): { out: string; err: string } {
  const out: string[] = [];
  const dirty = pages.filter((p) => p.conflict || LOCAL_WORD[p.local] || REMOTE_WORD[p.remote]);
  if (dirty.length === 0) out.push(`${project}: in sync.`);
  else {
    out.push(`${project}:`);
    for (const p of dirty) {
      const bits: string[] = [];
      if (LOCAL_WORD[p.local]) bits.push(LOCAL_WORD[p.local] as string);
      if (REMOTE_WORD[p.remote]) bits.push(REMOTE_WORD[p.remote] as string);
      if (p.conflict) bits.push("CONFLICT open: merge the .remote.md copy, delete it, then anywr push");
      out.push(`  ${pad(p.path, 28)} ${bits.join("; ")}`);
    }
    out.push("");
    out.push("Run `anywr pull` to fetch server changes and `anywr push` to send local ones.");
  }
  return { out: out.join("\n") + "\n", err: warning ? `warning: ${warning}\n` : "" };
}
