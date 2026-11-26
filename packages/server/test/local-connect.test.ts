import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import { prepareLocal, type LocalSetup } from "../src/local.js";
import { localConnector, SERVER_NAME, type LocalConnector } from "../src/local-connect.js";
import type { Db } from "../src/db/db.js";
import { freshDb } from "./helpers.js";

// One-click connect: the local server adds itself to the agents on this computer. Everything here
// runs against a made-up home folder and a recorded stand-in for the agents' commands.

const PORT = "3998";
const ORIGIN = `http://127.0.0.1:${PORT}`;
let root: string;
let userHome: string;
let bin: string;
let db: Db;
let config: Config;
let local: LocalSetup;
let calls: { file: string; args: string[] }[];
let exit: (file: string, args: string[]) => number;
let connector: LocalConnector;

const token = () => readFileSync(local.agentTokenPath, "utf8").trim();
const installAgent = (name: string) => {
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, name), "#!/bin/sh\n");
  chmodSync(join(bin, name), 0o755);
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "anywhere-connect-"));
  userHome = join(root, "user");
  bin = join(root, "bin");
  mkdirSync(userHome, { recursive: true });
  db = await freshDb();
  config = loadConfig({ ANYWHERE_LOCAL: "1", ANYWHERE_HOME: join(root, "anywhere"), PORT });
  local = await prepareLocal(db, config);
  calls = [];
  exit = () => 0;
  connector = localConnector(config, local, {
    home: userHome,
    env: { PATH: bin },
    run: async (file, args) => {
      calls.push({ file, args });
      return { code: exit(file, args), output: "" };
    },
  });
});
afterEach(async () => {
  await db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("what it finds", () => {
  it("says an agent is not on this computer, and connects nothing, when its command is missing", async () => {
    expect(connector.status("claude")).toEqual({ installed: false, connected: false, skill: false });
    const r = await connector.connect("claude");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("not found");
    expect(calls).toHaveLength(0);
    expect(existsSync(join(userHome, ".claude"))).toBe(false);
  });

  it("reads each agent's own settings to say whether it is connected", () => {
    installAgent("claude");
    installAgent("codex");
    writeFileSync(join(userHome, ".claude.json"), JSON.stringify({ mcpServers: { [SERVER_NAME]: {} } }));
    mkdirSync(join(userHome, ".codex"));
    writeFileSync(join(userHome, ".codex", "config.toml"), `[mcp_servers.other]\nurl = "https://example.com"\n`);
    expect(connector.status("claude")).toMatchObject({ installed: true, connected: true });
    expect(connector.status("codex")).toMatchObject({ installed: true, connected: false });
  });
});

describe("connecting Claude Code", () => {
  it("runs one fixed command with the token from the owner's file, and installs the skill", async () => {
    installAgent("claude");
    const r = await connector.connect("claude");
    expect(r.ok).toBe(true);
    expect(calls.map((c) => c.file)).toEqual([join(bin, "claude"), join(bin, "claude")]);
    expect(calls[0]!.args).toEqual(["mcp", "remove", "--scope", "user", SERVER_NAME]);
    expect(calls[1]!.args).toEqual([
      "mcp", "add", "--scope", "user", "--transport", "http", SERVER_NAME, `${ORIGIN}/mcp`,
      "--header", `Authorization: Bearer ${token()}`,
    ]);
    const skill = readFileSync(join(userHome, ".claude", "skills", "anywhere", "SKILL.md"), "utf8");
    expect(skill).toContain("name: anywhere");
    expect(existsSync(join(userHome, ".claude", "skills", "anywhere", "scripts", "map-work.mjs"))).toBe(true);
    expect(connector.status("claude").skill).toBe(true);
  });

  it("says so, and installs nothing, when Claude Code refuses", async () => {
    installAgent("claude");
    exit = (_f, args) => (args[1] === "add" ? 1 : 0);
    const r = await connector.connect("claude");
    expect(r.ok).toBe(false);
    expect(existsSync(join(userHome, ".claude", "skills"))).toBe(false);
  });
});

describe("connecting Codex", () => {
  const file = () => join(userHome, ".codex", "config.toml");
  const other = `model = "x"\n\n[mcp_servers.other]\nurl = "https://example.com"\n`;

  it("adds its entry to the settings, keeps everything else, and replaces an earlier entry", async () => {
    installAgent("codex");
    mkdirSync(join(userHome, ".codex"));
    writeFileSync(file(), `${other}\n[mcp_servers.${SERVER_NAME}]\nurl = "http://old"\n\n[mcp_servers.after]\nurl = "https://after.example"\n`);
    const r = await connector.connect("codex");
    expect(r.ok).toBe(true);
    const text = readFileSync(file(), "utf8");
    expect(text).toContain('[mcp_servers.other]\nurl = "https://example.com"');
    expect(text).toContain('[mcp_servers.after]\nurl = "https://after.example"');
    expect(text).not.toContain("http://old");
    expect(text.split(`[mcp_servers.${SERVER_NAME}]`)).toHaveLength(2);
    expect(text).toContain(`url = "${ORIGIN}/mcp"`);
    expect(text).toContain(`http_headers = { Authorization = "Bearer ${token()}" }`);
    expect(calls).toEqual([{ file: join(bin, "codex"), args: ["mcp", "get", SERVER_NAME] }]);
    expect(existsSync(join(userHome, ".codex", "skills", "anywhere", "SKILL.md"))).toBe(true);
    expect(connector.status("codex").connected).toBe(true);
  });

  it("puts the settings back exactly as they were when Codex cannot read the new entry", async () => {
    installAgent("codex");
    mkdirSync(join(userHome, ".codex"));
    writeFileSync(file(), other);
    exit = () => 1;
    const r = await connector.connect("codex");
    expect(r.ok).toBe(false);
    expect(readFileSync(file(), "utf8")).toBe(other);
    expect(existsSync(join(userHome, ".codex", "skills"))).toBe(false);
  });
});

describe("the button", () => {
  const req = (app: ReturnType<typeof createApp>, path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
    app.fetch(new Request(`${ORIGIN}${path}`, { redirect: "manual", ...init, headers: { host: `127.0.0.1:${PORT}`, ...init.headers } }));
  const form = (fields: Record<string, string>, cookie?: string) => ({
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(fields).toString(),
  });

  it("works only from the unlocked browser with its form token, and only for the two agents", async () => {
    installAgent("claude");
    const app = createApp({ db, config, local, connector });
    // Locked: sent to unlock, nothing runs.
    expect((await req(app, "/local/connect/claude", form({}))).status).toBe(302);
    const unlock = await req(app, "/local/unlock", form({ token: local.browserToken }));
    const cookie = unlock.headers.get("set-cookie")!.split(";")[0]!;
    const page = await (await req(app, "/welcome", { headers: { cookie } })).text();
    expect(page).toContain("Connect Claude Code");
    expect(page).toContain("Not on this computer"); // Codex is not installed in this made-up home
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page)![1]!;
    // No form token: refused, nothing runs.
    expect((await req(app, "/local/connect/claude", form({}, cookie))).status).toBe(403);
    // Another website's request never arrives at all.
    const evil = await req(app, "/local/connect/claude", { ...form({ _csrf: csrf }, cookie), headers: { ...form({}, cookie).headers, origin: "https://evil.example" } });
    expect(evil.status).toBe(403);
    // Anything but the two agents is not a route, whatever it carries.
    expect((await req(app, "/local/connect/claude;rm%20-rf", form({ _csrf: csrf }, cookie))).status).toBe(404);
    expect(calls).toHaveLength(0);

    const done = await req(app, "/local/connect/claude", form({ _csrf: csrf }, cookie));
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/welcome?connected=claude");
    expect(calls).toHaveLength(2);
    // The page only says "connected" when the agent's settings agree, not because the address says so.
    expect(await (await req(app, "/welcome?connected=claude", { headers: { cookie } })).text()).not.toContain("Claude Code is connected");
    writeFileSync(join(userHome, ".claude.json"), JSON.stringify({ mcpServers: { [SERVER_NAME]: {} } }));
    expect(await (await req(app, "/welcome?connected=claude", { headers: { cookie } })).text()).toContain("Claude Code is connected");
  });

  it("does not exist outside local mode", async () => {
    const hosted = loadConfig({ BASE_URL: "http://localhost:3000", ANYWHERE_PGLITE_DIR: join(root, "db") });
    const app = createApp({ db, config: hosted });
    const res = await app.fetch(new Request("http://localhost:3000/local/connect/claude", { method: "POST", headers: { origin: "http://localhost:3000" } }));
    expect(res.status).toBe(404);
  });
});
