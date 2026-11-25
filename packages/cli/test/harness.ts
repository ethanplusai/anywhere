import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/main.js";
import { FakeServer } from "./fake-server.js";

export type Run = { code: number; out: string; err: string; json: () => any }; // eslint-disable-line @typescript-eslint/no-explicit-any

export class World {
  server = new FakeServer();
  root = mkdtempSync(join(tmpdir(), "anywr-test-"));
  work = join(this.root, "work");
  cfg = join(this.root, "config");
  url = "";
  secret = "";
  sleeps: number[] = [];

  async start(): Promise<this> {
    mkdirSync(this.work, { recursive: true });
    this.url = await this.server.start();
    return this;
  }
  async stop(): Promise<void> {
    await this.server.stop();
    rmSync(this.root, { recursive: true, force: true });
  }
  get anywhere(): string {
    return join(this.work, ".anywhere");
  }
  git(...args: string[]): void {
    execFileSync("git", args, { cwd: this.work, stdio: "ignore" });
  }
  async run(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<Run> {
    let out = "";
    let err = "";
    const code = await main(args, {
      cwd: opts.cwd ?? this.work,
      env: { ANYWR_CONFIG_DIR: this.cfg, HOME: this.root, ...opts.env },
      stdout: (s) => void (out += s),
      stderr: (s) => void (err += s),
      readSecret: async () => this.secret,
      sleep: async (ms) => void this.sleeps.push(ms),
    });
    return { code, out, err, json: () => JSON.parse(out) };
  }
  /** Sign in and link a fresh project with the standard pages. */
  async linked(slug = "acme"): Promise<void> {
    this.server.addProject(slug, "Acme");
    const l = await this.run(["login", this.url, "--token", this.server.token]);
    if (l.code !== 0) throw new Error(l.err);
    const r = await this.run(["link", slug]);
    if (r.code !== 0) throw new Error(r.err + r.out);
  }
}
