#!/usr/bin/env node
// Builds skill/anywhere/SKILL.md from skill/SKILL.template.md and docs/layout.md,
// so the layout and rules have one source. Usage: node skill/build.mjs [--check]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");

/** The part of docs/layout.md the skill embeds: no title, no note about where it is used, headings one level down. */
export function layoutSection(layoutText) {
  return layoutText
    .replace(/\r\n/g, "\n")
    .replace(/^# .*\n+/, "")
    .replace(/^This is the one description[\s\S]*?\n\n/m, "")
    .replace(/^## /gm, "### ")
    .trim();
}

export function buildSkill(root = repo) {
  const template = readFileSync(join(root, "skill", "SKILL.template.md"), "utf8");
  const layout = layoutSection(readFileSync(join(root, "docs", "layout.md"), "utf8"));
  if (!template.includes("{{LAYOUT}}")) throw new Error("template has no {{LAYOUT}} placeholder");
  return template.replace("{{LAYOUT}}", () => layout);
}

export const outputPath = (root = repo) => join(root, "skill", "anywhere", "SKILL.md");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = buildSkill();
  const out = outputPath();
  if (process.argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(out, "utf8");
    } catch {
      /* missing */
    }
    if (current !== text) {
      console.error("skill/anywhere/SKILL.md is out of date. Run: node skill/build.mjs");
      process.exit(1);
    }
  } else {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text);
    console.log(`wrote ${out}`);
  }
}
