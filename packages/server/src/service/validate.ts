import { AppError } from "./errors.js";

export const STANDARD_PAGES = ["overview.md", "plan.md", "decisions.md", "open-questions.md", "ideas.md", "log.md"] as const;
export type StandardPath = (typeof STANDARD_PAGES)[number];

export const MAX_PAGE_BYTES = 256 * 1024;
export const MAX_BODY_BYTES = 1024 * 1024;

const PATH_RE = /^[a-z0-9][a-z0-9-]{0,62}(\/[a-z0-9][a-z0-9-]{0,62})?\.md$/;
const SLUG_RE = /^[a-z0-9-]{1,64}$/;

export function isStandardPage(path: string): path is StandardPath {
  return (STANDARD_PAGES as readonly string[]).includes(path);
}

export function assertPath(path: string): void {
  if (!PATH_RE.test(path)) {
    throw new AppError(
      422,
      "invalid_path",
      `"${path}" is not a valid page path. Use lowercase letters, digits and hyphens, at most two segments, ending in .md (e.g. "topics/pricing.md").`,
    );
  }
}

export function assertSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new AppError(422, "invalid_slug", `"${slug}" is not a valid project slug: use 1-64 of [a-z0-9-].`);
  }
}

/** Lowercase, runs of other characters become "-", trimmed to 64. */
export function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}
