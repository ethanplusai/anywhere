import { mkdirSync, readFileSync, statSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { World } from "./harness.js";

let w: World;
beforeEach(async () => {
  w = await new World().start();
});
afterEach(async () => {
  await w.stop();
});

const read = (p: string) => readFileSync(join(w.anywhere, p), "utf8");
const write = (p: string, s: string | Buffer) => {
  mkdirSync(join(w.anywhere, p, ".."), { recursive: true });
  writeFileSync(join(w.anywhere, p), s);
};
const link = () => JSON.parse(readFileSync(join(w.anywhere, ".link.json"), "utf8"));

describe("login, logout, projects", () => {
  it("verifies the token, stores it 0600 and never prints it", async () => {
    const r = await w.run(["login", w.url, "--token", w.server.token]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("tester@example.com");
    expect(r.out + r.err).not.toContain(w.server.token);
    const file = join(w.cfg, "credentials.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain(w.server.token);
  });
  it("takes the token from the prompt and from ANYWR_TOKEN", async () => {
    w.secret = w.server.token;
    expect((await w.run(["login", w.url])).code).toBe(0);
    expect((await w.run(["login", w.url], { env: { ANYWR_TOKEN: w.server.token } })).code).toBe(0);
  });
  it("rejects a bad token and stores nothing", async () => {
    const r = await w.run(["login", w.url, "--token", "nope"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("did not accept");
    expect(existsSync(join(w.cfg, "credentials.json"))).toBe(false);
  });
  it("lists projects, as JSON too, and logs out", async () => {
    w.server.addProject("acme", "Acme");
    await w.run(["login", w.url, "--token", w.server.token]);
    expect((await w.run(["projects"])).out).toContain("acme");
    expect((await w.run(["projects", "--json"])).json().projects[0].slug).toBe("acme");
    expect((await w.run(["logout"])).out).toContain("Signed out");
    const after = await w.run(["projects"]);
    expect(after.code).toBe(1);
    expect(after.err).toContain("anywr login");
  });
});

describe("link", () => {
  it("creates .anywhere with the standard pages and a link file", async () => {
    await w.linked();
    expect(readdirSync(w.anywhere).sort()).toEqual([".link.json", "decisions.md", "ideas.md", "log.md", "open-questions.md", "overview.md"]);
    expect(link().project).toBe("acme");
    expect(link().pages["overview.md"].version).toBe(1);
    expect(link().pages["overview.md"].sha256).toHaveLength(64);
  });
  it("adds .anywhere/ to .gitignore in a git repo, once", async () => {
    w.git("init", "-q");
    await w.linked();
    expect(readFileSync(join(w.work, ".gitignore"), "utf8")).toBe(".anywhere/\n");
    await w.run(["link", "acme"]);
    expect(readFileSync(join(w.work, ".gitignore"), "utf8")).toBe(".anywhere/\n");
  });
  it("leaves an existing ignore rule alone and writes nothing outside git", async () => {
    w.git("init", "-q");
    writeFileSync(join(w.work, ".gitignore"), "node_modules/\n.anywhere/\n");
    await w.linked();
    expect(readFileSync(join(w.work, ".gitignore"), "utf8")).toBe("node_modules/\n.anywhere/\n");
  });
  it("does not create .gitignore outside a git repo", async () => {
    await w.linked();
    expect(existsSync(join(w.work, ".gitignore"))).toBe(false);
  });
  it("--create makes the project first; slug_taken is explained", async () => {
    await w.run(["login", w.url, "--token", w.server.token]);
    const r = await w.run(["link", "new-one", "--create", "New One"]);
    expect(r.code).toBe(0);
    expect(w.server.projects.get("new-one")?.name).toBe("New One");
    expect(existsSync(join(w.anywhere, "overview.md"))).toBe(true);
    const other = join(w.root, "other");
    mkdirSync(other);
    const dup = await w.run(["link", "new-one", "--create", "Again"], { cwd: other });
    expect(dup.code).toBe(1);
    expect(dup.err).toContain("already exists");
  });
  it("explains an unknown project", async () => {
    await w.run(["login", w.url, "--token", w.server.token]);
    const r = await w.run(["link", "ghost"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("--create");
  });
  it("finds .anywhere from a subdirectory", async () => {
    await w.linked();
    const sub = join(w.work, "src", "deep");
    mkdirSync(sub, { recursive: true });
    w.server.setPage("acme", "ideas.md", "# Ideas\n\nnew\n");
    const r = await w.run(["pull"], { cwd: sub });
    expect(r.code).toBe(0);
    expect(read("ideas.md")).toContain("new");
  });
  it("outside a linked folder says what to do", async () => {
    const r = await w.run(["pull"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("link <project-slug>");
  });
});

describe("pull and push without conflict", () => {
  beforeEach(async () => {
    await w.linked();
  });

  it("pull: remote changed overwrites, remote new is written, remote deleted removes", async () => {
    w.server.setPage("acme", "overview.md", "# Acme\n\nchanged\n");
    w.server.setPage("acme", "topics/pricing.md", "# Pricing\n");
    w.server.setPage("acme", "topics/old.md", "old\n");
    await w.run(["pull"]);
    w.server.removePage("acme", "topics/old.md");
    const r = await w.run(["pull", "--json"]);
    expect(r.code).toBe(0);
    expect(read("overview.md")).toBe("# Acme\n\nchanged\n");
    expect(read("topics/pricing.md")).toBe("# Pricing\n");
    expect(existsSync(join(w.anywhere, "topics/old.md"))).toBe(false);
    expect(link().pages["topics/old.md"]).toBeUndefined();
    expect(link().pages["overview.md"].version).toBe(2);
    expect(r.json().changes).toEqual([{ path: "topics/old.md", action: "deleted", detail: "deleted on the server" }]);
  });

  it("pull with nothing new is a quiet success", async () => {
    const r = await w.run(["pull"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("up to date");
  });

  it("push: edit, new page, delete page", async () => {
    w.server.setPage("acme", "topics/gone.md", "bye\n");
    await w.run(["pull"]);
    write("overview.md", "# Acme\n\nedited locally\n");
    write("topics/pricing.md", "# Pricing\n\ntwo tier\n");
    write("topics/gone.md", "");
    (await import("node:fs")).rmSync(join(w.anywhere, "topics/gone.md"));
    const r = await w.run(["push"]);
    expect(r.code).toBe(0);
    expect(w.server.page("acme", "overview.md")?.content).toBe("# Acme\n\nedited locally\n");
    expect(w.server.page("acme", "overview.md")?.version).toBe(2);
    expect(w.server.page("acme", "topics/pricing.md")?.content).toContain("two tier");
    expect(w.server.page("acme", "topics/gone.md")).toBeUndefined();
    expect(link().pages["topics/gone.md"]).toBeUndefined();
    expect(link().pages["topics/pricing.md"].version).toBe(1);
    expect((await w.run(["push"])).out).toContain("nothing to push");
  });

  it("push restores a deleted standard page with a warning", async () => {
    (await import("node:fs")).rmSync(join(w.anywhere, "log.md"));
    const r = await w.run(["push"]);
    expect(r.code).toBe(0);
    expect(r.err).toContain("standard page");
    expect(existsSync(join(w.anywhere, "log.md"))).toBe(true);
    expect(w.server.page("acme", "log.md")).toBeDefined();
    expect(w.server.log.some((q) => q.method === "DELETE")).toBe(false);
  });

  it("push of identical content created elsewhere records it and does not conflict", async () => {
    w.server.setPage("acme", "ideas.md", "same\n");
    write("ideas.md", "same\n");
    const r = await w.run(["pull"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(w.anywhere, "ideas.remote.md"))).toBe(false);
    expect(link().pages["ideas.md"].version).toBe(2);
    expect((await w.run(["push"])).out).toContain("nothing to push");
  });

  it("preserves exact bytes: CRLF, BOM, no trailing newline", async () => {
    const bytes = Buffer.from("﻿line one\r\nline two  ", "utf8");
    write("topics/raw.md", bytes);
    expect((await w.run(["push"])).code).toBe(0);
    expect(w.server.page("acme", "topics/raw.md")?.content).toBe(bytes.toString("utf8"));
    expect(link().pages["topics/raw.md"].sha256).toBe(w.server.page("acme", "topics/raw.md") && (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex"));
    w.server.setPage("acme", "topics/raw.md", "﻿server\r\n");
    await w.run(["pull"]);
    expect(readFileSync(join(w.anywhere, "topics/raw.md"))).toEqual(Buffer.from("﻿server\r\n", "utf8"));
  });

  it("never sends a file that is not valid UTF-8", async () => {
    write("topics/bin.md", Buffer.from([0xff, 0xfe, 0x41, 0xc3]));
    const r = await w.run(["push"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("not valid UTF-8");
    expect(w.server.page("acme", "topics/bin.md")).toBeUndefined();
  });

  it("ignores non-page files and .remote.md files for syncing", async () => {
    write("notes.txt", "x");
    write("Bad Name.md", "x");
    write("topics/a/b.md", "x");
    expect((await w.run(["push"])).out).toContain("nothing to push");
  });

  it("local deleted + remote changed: pull restores; remote deleted + local changed: kept, push recreates", async () => {
    (await import("node:fs")).rmSync(join(w.anywhere, "ideas.md"));
    w.server.setPage("acme", "ideas.md", "# Ideas\n\nserver side\n");
    const r = await w.run(["pull"]);
    expect(r.out).toContain("restored");
    expect(read("ideas.md")).toContain("server side");

    w.server.setPage("acme", "topics/t.md", "t1\n");
    await w.run(["pull"]);
    write("topics/t.md", "t-local\n");
    w.server.removePage("acme", "topics/t.md");
    const kept = await w.run(["pull"]);
    expect(kept.code).toBe(0);
    expect(read("topics/t.md")).toBe("t-local\n");
    expect(link().pages["topics/t.md"]).toBeUndefined();
    expect((await w.run(["push"])).code).toBe(0);
    expect(w.server.page("acme", "topics/t.md")?.content).toBe("t-local\n");
    expect(w.server.page("acme", "topics/t.md")?.version).toBeGreaterThan(2); // continues past the tombstone
  });

  it("push when the server deleted a page we changed (409, current null): keep file, next push recreates", async () => {
    w.server.setPage("acme", "topics/t.md", "t1\n");
    await w.run(["pull"]);
    write("topics/t.md", "t-local\n");
    w.server.removePage("acme", "topics/t.md");
    const r = await w.run(["push"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("kept-local");
    expect(read("topics/t.md")).toBe("t-local\n");
    expect(link().pages["topics/t.md"]).toBeUndefined();
    await w.run(["push"]);
    expect(w.server.page("acme", "topics/t.md")?.content).toBe("t-local\n");
  });

  it("push of a page we deleted that the server changed restores the server copy", async () => {
    w.server.setPage("acme", "topics/t.md", "t1\n");
    await w.run(["pull"]);
    (await import("node:fs")).rmSync(join(w.anywhere, "topics/t.md"));
    w.server.setPage("acme", "topics/t.md", "t2\n");
    const r = await w.run(["push"]);
    expect(r.code).toBe(0);
    expect(read("topics/t.md")).toBe("t2\n");
    expect(w.server.page("acme", "topics/t.md")?.content).toBe("t2\n");
  });

  it("both sides deleted: pull drops the record", async () => {
    w.server.setPage("acme", "topics/t.md", "t1\n");
    await w.run(["pull"]);
    (await import("node:fs")).rmSync(join(w.anywhere, "topics/t.md"));
    w.server.removePage("acme", "topics/t.md");
    expect((await w.run(["pull"])).code).toBe(0);
    expect(link().pages["topics/t.md"]).toBeUndefined();
  });
});

describe("conflicts", () => {
  beforeEach(async () => {
    await w.linked();
  });

  it("pull writes .remote.md, keeps the file and record, exits 1, and is idempotent", async () => {
    const before = link().pages["decisions.md"];
    write("decisions.md", "# Decisions\n\nlocal\n");
    w.server.setPage("acme", "decisions.md", "# Decisions\n\nremote\n");
    const r = await w.run(["pull"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("decisions.remote.md");
    expect(r.out).toContain("anywr push");
    expect(read("decisions.md")).toBe("# Decisions\n\nlocal\n");
    expect(read("decisions.remote.md")).toBe("# Decisions\n\nremote\n");
    expect(link().pages["decisions.md"]).toEqual({ ...before, mergeBase: 2 });
    const again = await w.run(["pull", "--json"]);
    expect(again.code).toBe(1);
    expect(again.json().conflicts).toEqual([{ path: "decisions.md", remoteFile: ".anywhere/decisions.remote.md" }]);
    expect(link().pages["decisions.md"].mergeBase).toBe(2);
  });

  it("push skips a page with an open conflict and exits 1 but still pushes the rest", async () => {
    write("decisions.md", "local\n");
    w.server.setPage("acme", "decisions.md", "remote\n");
    await w.run(["pull"]);
    write("ideas.md", "# Ideas\n\nfine\n");
    const r = await w.run(["push"]);
    expect(r.code).toBe(1);
    expect(w.server.page("acme", "ideas.md")?.content).toContain("fine");
    expect(w.server.page("acme", "decisions.md")?.content).toBe("remote\n");
  });

  it("full cycle: conflict, merge, delete .remote.md, (even pull again), push succeeds", async () => {
    write("overview.md", "# Acme\n\nmine\n");
    w.server.setPage("acme", "overview.md", "# Acme\n\ntheirs\n");
    expect((await w.run(["pull"])).code).toBe(1);
    write("overview.md", "# Acme\n\nmine and theirs\n");
    (await import("node:fs")).rmSync(join(w.anywhere, "overview.remote.md"));
    expect((await w.run(["pull"])).code).toBe(0); // must not reopen the conflict
    expect(existsSync(join(w.anywhere, "overview.remote.md"))).toBe(false);
    const r = await w.run(["push"]);
    expect(r.code).toBe(0);
    expect(w.server.page("acme", "overview.md")?.content).toBe("# Acme\n\nmine and theirs\n");
    expect(w.server.page("acme", "overview.md")?.version).toBe(3);
    expect(link().pages["overview.md"].mergeBase).toBeUndefined();
    expect(link().pages["overview.md"].version).toBe(3);
  });

  it("a push refused with 409 creates the .remote.md (no prior pull)", async () => {
    write("overview.md", "# Acme\n\nmine\n");
    w.server.setPage("acme", "overview.md", "# Acme\n\ntheirs\n");
    const r = await w.run(["push"]);
    expect(r.code).toBe(1);
    expect(read("overview.remote.md")).toBe("# Acme\n\ntheirs\n");
    expect(read("overview.md")).toBe("# Acme\n\nmine\n");
    expect(link().pages["overview.md"].mergeBase).toBe(2);
    expect(w.server.page("acme", "overview.md")?.content).toBe("# Acme\n\ntheirs\n");
  });

  it("a new page created on both sides conflicts, and resolves by pushing the merge", async () => {
    write("topics/x.md", "local x\n");
    w.server.setPage("acme", "topics/x.md", "remote x\n");
    const r = await w.run(["push"]);
    expect(r.code).toBe(1);
    expect(read("topics/x.remote.md")).toBe("remote x\n");
    write("topics/x.md", "merged x\n");
    (await import("node:fs")).rmSync(join(w.anywhere, "topics/x.remote.md"));
    expect((await w.run(["push"])).code).toBe(0);
    expect(w.server.page("acme", "topics/x.md")?.content).toBe("merged x\n");
  });

  it("changed on both sides to the same bytes is not a conflict (push 409 path)", async () => {
    write("ideas.md", "same\n");
    w.server.setPage("acme", "ideas.md", "same\n");
    const r = await w.run(["push"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(w.anywhere, "ideas.remote.md"))).toBe(false);
    expect(link().pages["ideas.md"].version).toBe(2);
  });

  it("status reports the conflict and exits 1", async () => {
    write("decisions.md", "local\n");
    w.server.setPage("acme", "decisions.md", "remote\n");
    await w.run(["pull"]);
    const r = await w.run(["status"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("CONFLICT");
  });
});

describe("status, rate limits, failures", () => {
  beforeEach(async () => {
    await w.linked();
  });

  it("status shows both sides and supports --json", async () => {
    write("ideas.md", "edit\n");
    w.server.setPage("acme", "overview.md", "remote edit\n");
    const r = await w.run(["status"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("ideas.md");
    expect(r.out).toContain("edited here");
    expect(r.out).toContain("changed on server");
    const j = (await w.run(["status", "--json"])).json();
    expect(j.pages.find((p: { path: string }) => p.path === "ideas.md")).toMatchObject({ local: "changed", remote: "unchanged" });
    expect(j.pages.find((p: { path: string }) => p.path === "overview.md")).toMatchObject({ local: "unchanged", remote: "changed" });
  });

  it("status is clean when in sync", async () => {
    expect((await w.run(["status"])).out).toContain("in sync");
  });

  it("retries once after a 429 and honours Retry-After", async () => {
    w.server.rateLimit = 1;
    w.server.retryAfter = "2";
    const r = await w.run(["pull"]);
    expect(r.code).toBe(0);
    expect(w.sleeps).toEqual([2000]);
  });

  it("fails with the server's message after a second 429", async () => {
    w.server.rateLimit = 2;
    const r = await w.run(["pull"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Slow down");
  });

  it("a rejected token says how to sign in again; progress is kept", async () => {
    w.server.token = "anywr_rotated";
    const r = await w.run(["pull"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("anywr login");
    expect(link().pages["overview.md"]).toBeDefined();
  });

  it("an unreachable server gives a clear message; status falls back to local state", async () => {
    write("ideas.md", "edit\n");
    await w.server.stop();
    const p = await w.run(["pull"]);
    expect(p.code).toBe(1);
    expect(p.err).toContain("Cannot reach");
    const s = await w.run(["status"]);
    expect(s.out).toContain("edited here");
    expect(s.err).toContain("Could not reach");
    w.server = new (await import("./fake-server.js")).FakeServer();
  });

  it("--json errors are JSON", async () => {
    const r = await w.run(["pull", "--json"], { cwd: w.root });
    expect(r.code).toBe(1);
    expect(r.json().ok).toBe(false);
  });
});

describe("help", () => {
  it("--help and unknown commands", async () => {
    const h = await w.run(["--help"]);
    expect(h.code).toBe(0);
    expect(h.out).toContain("link <project-slug>");
    expect((await w.run(["frobnicate"])).code).toBe(2);
    expect((await w.run(["pull", "--nope"])).code).toBe(2);
    expect((await w.run(["push", "--help"])).out).toContain("Usage: anywr push");
    expect((await w.run(["--version"])).out).toMatch(/^\d+\.\d+\.\d+/);
  });
});
