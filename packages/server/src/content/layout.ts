import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { STANDARD_PAGES, type StandardPath } from "../service/validate.js";

/**
 * docs/layout.md at the repo root is the single source of the guide text and page templates. The
 * build copies it into the package as layout.md so an installed copy of the server carries it; in a
 * checkout that has not been built yet the repo file is read directly.
 */
const PACKAGED_LAYOUT_PATH = fileURLToPath(new URL("../../layout.md", import.meta.url));
const REPO_LAYOUT_PATH = fileURLToPath(new URL("../../../../docs/layout.md", import.meta.url));
// In a checkout the repo file is the truth (the packaged copy may be from an older build); an
// installed package has only its own copy.
const DEFAULT_LAYOUT_PATH = existsSync(REPO_LAYOUT_PATH) ? REPO_LAYOUT_PATH : PACKAGED_LAYOUT_PATH;

export interface Layout {
  /** The full layout and rules, for the `guide` tool. */
  guide: string;
  /** Initial content of each standard page: a level-one heading and one italic line. */
  templates: Record<StandardPath, string>;
}

export function loadLayout(path: string = DEFAULT_LAYOUT_PATH): Layout {
  return parseLayout(readFileSync(path, "utf8"));
}

export function parseLayout(markdown: string): Layout {
  // Drop the maintainer note ("This is the one description ... nowhere else.") from what agents see.
  const guide = markdown
    .split(/\n\s*\n/)
    .filter((para) => !para.startsWith("This is the one description"))
    .map((para) => para.replace(/<!-- template: [^>]+ -->\n?/g, ""))
    .join("\n\n")
    .trim();

  const holds = new Map<string, string>();
  for (const line of markdown.split("\n")) {
    const m = /^\|\s*`([^`]+)`\s*\|\s*(.+?)\s*\|\s*$/.exec(line);
    if (m?.[1] && m[2]) holds.set(m[1], m[2]);
  }

  // A page can have a fuller starting shape: `<!-- template: plan.md -->` followed by a fenced block.
  const shapes = new Map<string, string>();
  for (const m of markdown.matchAll(/<!-- template: ([a-z0-9./-]+) -->\s*```markdown\n([\s\S]*?)```/g)) {
    if (m[1] && m[2]) shapes.set(m[1], m[2]);
  }

  const templates = {} as Record<StandardPath, string>;
  for (const path of STANDARD_PAGES) {
    const text = holds.get(path);
    if (!text) throw new Error(`docs/layout.md has no table row for ${path}`);
    templates[path] = shapes.get(path) ?? `# ${titleFor(path)}\n\n_${text}_\n`;
  }
  return { guide, templates };
}

function titleFor(path: string): string {
  const words = path.replace(/\.md$/, "").replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
