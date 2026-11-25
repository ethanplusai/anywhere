import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeServer } from "./fake-server.js";
import { World } from "./harness.js";

// The server and the link file are not trusted to name files on this computer, and a link file
// that arrives with a cloned repository is not trusted to say where the token goes.

let w: World;
beforeEach(async () => {
  w = await new World().start();
});
afterEach(async () => {
  await w.stop();
});

const linkPath = () => join(w.anywhere, ".link.json");
const link = () => JSON.parse(readFileSync(linkPath(), "utf8"));

describe("paths from the server", () => {
  beforeEach(async () => {
    await w.linked();
  });

  it("pull never writes a page whose path leaves .anywhere, and says so", async () => {
    w.server.setPage("acme", "../../escaped.md", "planted\n");
    w.server.setPage("acme", "../CLAUDE.md", "planted\n");
    w.server.setPage("acme", "/tmp/anywr-absolute.md", "planted\n");
    w.server.setPage("acme", "topics/ok.md", "fine\n");
    const r = await w.run(["pull"]);
    expect(existsSync(join(w.root, "escaped.md"))).toBe(false);
    expect(existsSync(join(w.work, "CLAUDE.md"))).toBe(false);
    expect(existsSync("/tmp/anywr-absolute.md")).toBe(false);
    expect(readFileSync(join(w.anywhere, "topics/ok.md"), "utf8")).toBe("fine\n");
    expect(r.out + r.err).toContain("not a page path");
    expect(Object.keys(link().pages).every((p) => !p.includes(".."))).toBe(true);
  });

  it("status and push ignore such a page too", async () => {
    w.server.setPage("acme", "../../escaped.md", "planted\n");
    expect((await w.run(["status", "--json"])).json().pages.map((p: { path: string }) => p.path)).not.toContain("../../escaped.md");
    await w.run(["push"]);
    expect(existsSync(join(w.root, "escaped.md"))).toBe(false);
  });
});

describe("a link file someone else wrote", () => {
  it("cannot make pull or push delete or overwrite a file outside .anywhere", async () => {
    await w.linked();
    const victim = join(w.root, "victim.txt");
    writeFileSync(victim, "keep me\n");
    const l = link();
    l.pages["../../victim.txt"] = { version: 1, sha256: "0".repeat(64) };
    l.pages["../../victim.md"] = { version: 1, sha256: "0".repeat(64) };
    writeFileSync(linkPath(), JSON.stringify(l));
    await w.run(["pull"]);
    await w.run(["push"]);
    expect(readFileSync(victim, "utf8")).toBe("keep me\n");
    expect(Object.keys(link().pages).some((p) => p.includes(".."))).toBe(false);
  });

  it("never receives ANYWR_TOKEN unless the person named that server", async () => {
    const other = new FakeServer();
    other.token = "anywr_from_env";
    const otherUrl = await other.start();
    try {
      other.addProject("acme", "Acme");
      mkdirSync(w.anywhere, { recursive: true });
      writeFileSync(linkPath(), JSON.stringify({ server: otherUrl, project: "acme", pages: {} }));

      const refused = await w.run(["pull"], { env: { ANYWR_TOKEN: "anywr_from_env" } });
      expect(refused.code).not.toBe(0);
      expect(refused.err).toContain("Not signed in");
      expect(other.log).toHaveLength(0);

      const named = await w.run(["pull"], { env: { ANYWR_TOKEN: "anywr_from_env", ANYWR_SERVER: otherUrl } });
      expect(named.code).toBe(0);
      expect(other.log.length).toBeGreaterThan(0);
    } finally {
      await other.stop();
    }
  });
});

describe("servers over plain http", () => {
  it("are refused unless they are on this computer", async () => {
    const r = await w.run(["login", "http://example.com", "--token", "x"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("https://");
  });
});
