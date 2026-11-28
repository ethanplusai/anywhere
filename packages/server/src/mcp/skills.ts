import { createHash } from "node:crypto";
import { SKILL_FILES } from "../web/skill.generated.js";

/*
 * The Anywhere skill, served over MCP with the Skills extension (io.modelcontextprotocol/skills,
 * beta). It is the same skill people can download (skill/anywhere): a SKILL.md and the files next
 * to it, each as its own resource under skill://anywhere/, listed with its size and SHA-256 so the
 * client can check what it loads.
 */

export const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";

export interface SkillFile {
  uri: string;
  mimeType: string;
  text: string;
  size: number;
  digest: string;
}

export interface Skill {
  uri: string;
  frontmatter: Record<string, string>;
  files: SkillFile[];
}

const MIME: Record<string, string> = { md: "text/markdown", mjs: "text/javascript", js: "text/javascript", json: "application/json", txt: "text/plain" };

/** The `key: value` lines between the opening `---` lines. The skill's frontmatter is plain strings. */
export function parseFrontmatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) throw new Error("SKILL.md has no frontmatter.");
  const out: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`Unexpected frontmatter line: ${line}`);
    out[kv[1]!] = kv[2]!.trim();
  }
  return out;
}

function build(): Skill[] {
  const byRoot = new Map<string, typeof SKILL_FILES>();
  for (const f of SKILL_FILES) {
    const root = f.path.split("/")[0]!;
    byRoot.set(root, [...(byRoot.get(root) ?? []), f]);
  }
  return [...byRoot.entries()].map(([root, files]) => {
    const skillMd = files.find((f) => f.path === `${root}/SKILL.md`);
    if (!skillMd) throw new Error(`skill ${root} has no SKILL.md`);
    const frontmatter = parseFrontmatter(skillMd.content);
    // The last segment of the skill's path must be its name.
    if (frontmatter.name !== root) throw new Error(`skill folder ${root} does not match its name ${frontmatter.name}`);
    const ordered = [skillMd, ...files.filter((f) => f !== skillMd).sort((a, b) => a.path.localeCompare(b.path))];
    return {
      uri: `skill://${root}/SKILL.md`,
      frontmatter,
      files: ordered.map((f) => {
        const bytes = Buffer.from(f.content, "utf8");
        return {
          uri: `skill://${f.path}`,
          mimeType: MIME[f.path.split(".").pop() ?? ""] ?? "text/plain",
          text: f.content,
          size: bytes.length,
          digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        };
      }),
    };
  });
}

export const SKILLS: Skill[] = build();

/** A skill as skills/list and skills/get describe it. */
export function skillEntry(s: Skill) {
  return { uri: s.uri, frontmatter: s.frontmatter, resources: s.files.map((f) => ({ uri: f.uri, digest: f.digest, size: f.size })) };
}

export function findSkill(uri: string): Skill | undefined {
  return SKILLS.find((s) => s.uri === uri);
}

export function findSkillFile(uri: string): SkillFile | undefined {
  for (const s of SKILLS) for (const f of s.files) if (f.uri === uri) return f;
  return undefined;
}
