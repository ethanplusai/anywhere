#!/usr/bin/env node
// Copies skill/anywhere into the Claude Code and/or Codex skill folders.
// Usage: node skill/install.mjs [--claude] [--codex] [--dest <skills-dir>]
// With no flags it installs for both. --dest installs into one folder of your choosing.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function targets({ claude, codex, dest, env = process.env, home = homedir() }) {
  if (dest) return [join(dest, "anywhere")];
  const both = !claude && !codex;
  const out = [];
  if (claude || both) out.push(join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "skills", "anywhere"));
  if (codex || both) out.push(join(env.CODEX_HOME || join(home, ".codex"), "skills", "anywhere"));
  return out;
}

export function install(dirs, source = join(here, "anywhere")) {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
    mkdirSync(dirname(d), { recursive: true });
    cpSync(source, d, { recursive: true });
  }
  return dirs;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const i = a.indexOf("--dest");
  const dest = i >= 0 ? a[i + 1] : undefined;
  if (i >= 0 && !dest) {
    console.error("--dest needs a folder");
    process.exit(2);
  }
  for (const d of install(targets({ claude: a.includes("--claude"), codex: a.includes("--codex"), dest }))) {
    console.log(`installed ${d}`);
  }
}
