import type { Briefing } from "../service/projects.js";

/** The text under a `## heading` of a markdown page, up to the next heading of that level or above. */
export function section(markdown: string, heading: string): string | null {
  const lines = markdown.split("\n");
  const want = heading.toLowerCase();
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    // No lazy group followed by optional spaces here: on a long line of spaces that takes time that
    // grows with the square of its length, and a page is anyone's to write.
    const m = /^(#{1,3})\s+(.*)$/.exec(lines[i]!);
    if (!m) continue;
    if (start >= 0) {
      return lines.slice(start, i).join("\n").trim();
    }
    if (m[2]!.trim().toLowerCase() === want) start = i + 1;
  }
  return start >= 0 ? lines.slice(start).join("\n").trim() : null;
}

/** List items of a page (or of a section of it), in order, without the marker. */
export function items(markdown: string): string[] {
  return markdown
    .split("\n")
    .filter((l) => /^\s*(?:[-*]|\d+\.)\s+/.test(l) && !/^\s{2,}/.test(l))
    .map((l) => l.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").trim())
    .filter(Boolean);
}

export function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** Page text without the title line, the italic description of an untouched template, or imported-from notes. */
function body(markdown: string): string {
  return markdown
    .split("\n")
    .filter((l, i) => !(i === 0 && /^#\s/.test(l)))
    .filter((l) => !/^_[^_].*_$/.test(l.trim()))
    .join("\n")
    .trim();
}

export function actorLabel(actor: string | null): string {
  if (!actor) return "unknown";
  if (actor === "web") return "the person, in the browser";
  if (actor.startsWith("app:")) return actor.slice(4);
  if (actor.startsWith("token:")) return `token "${actor.slice(6)}"`;
  return actor;
}

/**
 * The resume briefing: what an agent needs to carry on, kept to roughly 400 to 700 tokens. Page
 * excerpts go between the data markers by the caller; this returns the excerpt text and the
 * instructions that sit outside them.
 */
export function formatBriefing(b: Briefing, planTemplate: string): { excerpt: string; guidance: string } {
  const { pages } = b;
  const parts: string[] = [];

  const overview = pages["overview.md"]?.content ?? "";
  const state = section(overview, "current state") ?? body(overview);
  parts.push(`CURRENT STATE (overview.md)\n${clip(state || "(empty)", 700)}`);

  const plan = pages["plan.md"]?.content ?? "";
  const planIsTemplate = !plan.trim() || plan.trim() === planTemplate.trim();
  if (planIsTemplate) {
    parts.push("PLAN (plan.md)\n(not filled in yet)");
  } else {
    const phases = section(plan, "phases") ?? "";
    const done = (phases.match(/^\s*[-*]\s+\[x\]/gim) ?? []).length;
    const total = (phases.match(/^\s*[-*]\s+\[[ x]\]/gim) ?? []).length;
    const nextPhase = phases.split("\n").find((l) => /^\s*[-*]\s+\[ \]/.test(l))?.replace(/^\s*[-*]\s+\[ \]\s*/, "");
    const lines = [`PLAN (plan.md, version ${pages["plan.md"]!.version})`];
    const goal = section(plan, "goal");
    if (goal) lines.push(`Goal: ${clip(goal, 200)}`);
    if (total) lines.push(`Phases: ${done} of ${total} done${nextPhase ? `; next: ${clip(nextPhase, 160)}` : ""}`);
    for (const name of ["Now", "Next", "Blocked"]) {
      const text = section(plan, name);
      if (text) lines.push(`${name}:\n${clip(text, 600)}`);
    }
    if (lines.length === 1) lines.push(clip(body(plan), 900));
    parts.push(lines.join("\n"));
  }

  const decisions = items(pages["decisions.md"]?.content ?? "").slice(0, 5);
  if (decisions.length) parts.push(`RECENT DECISIONS (decisions.md, newest first)\n${decisions.map((d) => `- ${clip(d, 220)}`).join("\n")}`);

  const questions = items(pages["open-questions.md"]?.content ?? "").slice(0, 5);
  if (questions.length) parts.push(`OPEN QUESTIONS (open-questions.md)\n${questions.map((q) => `- ${clip(q, 200)}`).join("\n")}`);

  const log = items(pages["log.md"]?.content ?? "").slice(-4);
  if (log.length) parts.push(`LATEST LOG ENTRIES (log.md, oldest first)\n${log.map((l) => `- ${clip(l, 220)}`).join("\n")}`);

  if (b.recent.length) {
    parts.push(
      `RECENT CHANGES\n${b.recent
        .map((r) => `- ${r.path} version ${r.version}, ${r.deleted ? "deleted" : r.via === "append" ? "added to" : "written"} by ${actorLabel(r.actor)} at ${r.createdAt.slice(0, 16).replace("T", " ")} UTC`)
        .join("\n")}`,
    );
  }

  if (b.stale.length) {
    parts.push(`NOT CHANGED IN 90 DAYS (may be out of date)\n${b.stale.map((s) => `- ${s.path} (last ${s.updatedAt.slice(0, 10)})`).join("\n")}`);
  }

  const guidance = planIsTemplate
    ? "plan.md is still empty. If work is under way, fill in its Goal, Phases, Now and Next before you start, so the next agent can pick it up."
    : "To continue: start from Next in plan.md. Rewrite Now and Next in plan.md as you go, especially before a long step, so a session cut off by a usage limit leaves the plan current. Read any page in full with read_page.";
  return { excerpt: parts.join("\n\n"), guidance };
}
