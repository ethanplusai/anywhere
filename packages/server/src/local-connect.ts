import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { mcpUrl } from "./deps.js";
import type { Config } from "./config.js";
import type { LocalSetup } from "./local.js";
import { SKILL_FILES } from "./web/skill.generated.js";

/*
 * One-click connect, for local mode only. A local server runs on the owner's computer as the owner,
 * so it can do what its walkthrough used to ask them to paste into a terminal: add itself to Claude
 * Code or Codex and put the skill where each one looks for skills.
 *
 * This is the one place the server changes files outside its own folder or starts another program,
 * so it is narrow on purpose. Nothing a request carries reaches a command line or a path: the only
 * choice is which of two agents, the arguments are fixed, the program is started without a shell,
 * and the routes that call this exist only in local mode, behind the unlocked browser and its form
 * token (see web/onboarding.ts).
 */

export type AgentId = "claude" | "codex";
export const AGENTS: readonly AgentId[] = ["claude", "codex"];
export const AGENT_NAMES: Record<AgentId, string> = { claude: "Claude Code", codex: "Codex" };

/** The name agents know this server by. */
export const SERVER_NAME = "anywhere-local";

export interface AgentStatus {
  /** The agent's command was found on this computer. */
  installed: boolean;
  /** Its settings name this server. */
  connected: boolean;
  /** The Anywhere skill is in its skills folder. */
  skill: boolean;
}

export interface ConnectResult {
  ok: boolean;
  /** One plain sentence for the person: what happened, or what to do about it. */
  message: string;
}

export interface LocalConnector {
  status(agent: AgentId): AgentStatus;
  connect(agent: AgentId): Promise<ConnectResult>;
}

type Run = (file: string, args: string[]) => Promise<{ code: number; output: string }>;

export interface ConnectorOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Starts a program and waits for it. Tests replace it. */
  run?: Run;
}

const runProgram: Run = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: 30_000, windowsHide: true }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, output: `${stdout}${stderr}` });
    });
  });

export function localConnector(config: Config, local: LocalSetup, options: ConnectorOptions = {}): LocalConnector {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const run = options.run ?? runProgram;
  const url = mcpUrl(config);

  const settingsDir = (agent: AgentId) =>
    agent === "claude" ? env.CLAUDE_CONFIG_DIR || join(home, ".claude") : env.CODEX_HOME || join(home, ".codex");
  /** Where each agent records its servers. Claude Code keeps its own beside its folder unless the folder is moved. */
  const settingsFile = (agent: AgentId) =>
    agent === "claude"
      ? env.CLAUDE_CONFIG_DIR
        ? join(env.CLAUDE_CONFIG_DIR, ".claude.json")
        : join(home, ".claude.json")
      : join(settingsDir("codex"), "config.toml");
  const skillDir = (agent: AgentId) => join(settingsDir(agent), "skills", "anywhere");

  /** The agent's command: on the PATH this server was started with, or in the places installers put it. */
  function find(agent: AgentId): string | null {
    const dirs = [
      ...(env.PATH ?? "").split(delimiter).filter(Boolean),
      join(home, ".local", "bin"),
      join(home, ".claude", "local"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ];
    for (const dir of dirs) {
      const file = join(dir, agent);
      try {
        accessSync(file, constants.X_OK);
        return file;
      } catch {
        // not here
      }
    }
    return null;
  }

  function connected(agent: AgentId): boolean {
    try {
      const text = readFileSync(settingsFile(agent), "utf8");
      if (agent === "codex") return text.split("\n").some((l) => l.trim() === `[mcp_servers.${SERVER_NAME}]`);
      const servers = (JSON.parse(text) as { mcpServers?: Record<string, unknown> }).mcpServers;
      return Boolean(servers && Object.hasOwn(servers, SERVER_NAME));
    } catch {
      return false;
    }
  }

  function installSkill(agent: AgentId): void {
    const dir = skillDir(agent);
    rmSync(dir, { recursive: true, force: true });
    for (const file of SKILL_FILES) {
      // Embedded paths start with "anywhere/"; they come from this repository, not from a request.
      const path = join(dirname(dir), file.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.content);
    }
  }

  const token = () => readFileSync(local.agentTokenPath, "utf8").trim();

  async function connectClaude(command: string): Promise<ConnectResult> {
    // Replace an earlier entry of the same name, so pressing the button twice is harmless.
    await run(command, ["mcp", "remove", "--scope", "user", SERVER_NAME]);
    const added = await run(command, [
      "mcp", "add", "--scope", "user", "--transport", "http", SERVER_NAME, url,
      "--header", `Authorization: Bearer ${token()}`,
    ]);
    if (added.code !== 0) return { ok: false, message: "Claude Code refused the connection. Try the command below in a terminal to see why." };
    return { ok: true, message: "Claude Code is connected. Open a new Claude Code session and say: Set up Anywhere." };
  }

  async function connectCodex(command: string): Promise<ConnectResult> {
    // Codex takes a fixed header only in its settings file, so the entry is written there, checked
    // with Codex itself, and taken back out if Codex cannot read the file afterwards.
    const file = settingsFile("codex");
    const before = existsSync(file) ? readFileSync(file, "utf8") : "";
    const kept: string[] = [];
    let skipping = false;
    for (const line of before.split("\n")) {
      if (line.trim().startsWith("[")) skipping = line.trim() === `[mcp_servers.${SERVER_NAME}]`;
      if (!skipping) kept.push(line);
    }
    const entry = [
      `[mcp_servers.${SERVER_NAME}]`,
      `url = ${JSON.stringify(url)}`,
      `http_headers = { Authorization = ${JSON.stringify(`Bearer ${token()}`)} }`,
      "",
    ].join("\n");
    mkdirSync(dirname(file), { recursive: true });
    const rest = kept.join("\n").trim();
    writeFileSync(file, rest ? `${rest}\n\n${entry}` : entry, { mode: 0o600 });
    const check = await run(command, ["mcp", "get", SERVER_NAME]);
    if (check.code !== 0) {
      writeFileSync(file, before);
      return { ok: false, message: "This version of Codex did not accept the connection, so its settings were put back as they were." };
    }
    return { ok: true, message: "Codex is connected. Open a new Codex session and say: Set up Anywhere." };
  }

  return {
    status(agent) {
      return { installed: find(agent) !== null, connected: connected(agent), skill: existsSync(join(skillDir(agent), "SKILL.md")) };
    },
    async connect(agent) {
      const command = find(agent);
      if (!command) return { ok: false, message: `${AGENT_NAMES[agent]} was not found on this computer. Install it, then come back and connect.` };
      try {
        const result = agent === "claude" ? await connectClaude(command) : await connectCodex(command);
        if (result.ok) installSkill(agent);
        return result;
      } catch (e) {
        console.error(`connect ${agent}:`, (e as Error).message);
        return { ok: false, message: `Connecting ${AGENT_NAMES[agent]} failed. Try the command below in a terminal to see why.` };
      }
    },
  };
}
