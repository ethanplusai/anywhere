import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/db.js";
import { createUser, findUserByEmail } from "../src/auth/users.js";
import { MAX_CODE_ATTEMPTS, checkCode, peekLink, startChallenge, useLink } from "../src/auth/email-codes.js";
import { coarseIp, describeAgent } from "../src/auth/events.js";
import { createPat, listPats, revokePat } from "../src/auth/tokens.js";
import { resolveBearer } from "../src/auth/resolve.js";
import { createSession, deleteSession, getSessionUser, csrfToken, checkCsrf } from "../src/auth/sessions.js";
import { freshDb } from "./helpers.js";

let db: Db;
beforeEach(async () => {
  db = await freshDb();
});
afterEach(async () => {
  await db.close();
});

describe("users", () => {
  it("have no password and are found by email in any case", async () => {
    const u = await createUser(db, "Ann@Example.com");
    expect(await findUserByEmail(db, "ann@example.com")).toEqual({ id: u.id, email: "Ann@Example.com" });
    const cols = await db.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name = 'users'");
    expect(cols.map((c) => c.column_name)).not.toContain("password_hash");
  });

  it("refuses a duplicate email and a malformed one", async () => {
    await createUser(db, "a@example.com");
    await expect(createUser(db, "A@example.com")).rejects.toMatchObject({ code: "email_taken" });
    await expect(createUser(db, "not-an-email")).rejects.toMatchObject({ code: "invalid_body" });
    await expect(createUser(db, "a\u0000b@example.com")).rejects.toMatchObject({ code: "invalid_body" });
  });
});

describe("email codes", () => {
  const start = (browser = "browser-one-0123456789abcdefghijklmn") =>
    startChallenge(db, { purpose: "signin", email: "Me@Example.com", userId: null, browser, next: "/tokens" });

  it("are six digits, stored only as hashes, and work once in the browser that asked", async () => {
    const { code, link } = await start();
    expect(code).toMatch(/^\d{6}$/);
    const stored = JSON.stringify(await db.query("SELECT * FROM email_challenges"));
    expect(stored).not.toContain(link);
    expect(stored).not.toContain(`"${code}"`);
    expect((await checkCode(db, "another-browser-0123456789abcdefghij", "signin", code)).ok).toBe(false);
    const ok = await checkCode(db, "browser-one-0123456789abcdefghijklmn", "signin", code);
    expect(ok).toMatchObject({ ok: true, challenge: { email: "me@example.com", next: "/tokens" } });
    expect((await checkCode(db, "browser-one-0123456789abcdefghijklmn", "signin", code)).ok).toBe(false);
  });

  it("end after five wrong guesses, even if the next one is right", async () => {
    const { code } = await start();
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 1; i < MAX_CODE_ATTEMPTS; i++) expect(await checkCode(db, "browser-one-0123456789abcdefghijklmn", "signin", wrong)).toMatchObject({ ok: false, reason: "wrong", left: MAX_CODE_ATTEMPTS - i });
    expect(await checkCode(db, "browser-one-0123456789abcdefghijklmn", "signin", wrong)).toMatchObject({ ok: false, reason: "spent" });
    expect((await checkCode(db, "browser-one-0123456789abcdefghijklmn", "signin", code)).ok).toBe(false);
  });

  it("replace the previous code in the same browser, and expire", async () => {
    const first = await start();
    const second = await start();
    expect((await checkCode(db, "browser-one-0123456789abcdefghijklmn", "signin", first.code)).ok).toBe(first.code === second.code);
    const third = await start();
    await db.query("UPDATE email_challenges SET expires_at = now() - interval '1 second'");
    expect(await checkCode(db, "browser-one-0123456789abcdefghijklmn", "signin", third.code)).toMatchObject({ ok: false, reason: "none" });
  });

  it("links can be looked at without being used, then work once on any device", async () => {
    const { link } = await start();
    expect(await peekLink(db, link)).toMatchObject({ email: "me@example.com" });
    expect(await peekLink(db, link)).not.toBeNull();
    expect(await useLink(db, link)).toMatchObject({ email: "me@example.com" });
    expect(await useLink(db, link)).toBeNull();
    expect(await useLink(db, "not a token")).toBeNull();
  });
});

describe("where a request came from", () => {
  it("is kept coarse: a browser name and a network, not an address", () => {
    expect(describeAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15")).toBe("Safari on macOS");
    expect(describeAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0")).toBe("Edge on Windows");
    expect(describeAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1")).toBe("Chrome on iOS");
    expect(describeAgent(undefined)).toBe("");
    expect(coarseIp("203.0.113.42")).toBe("203.0.113.x");
    expect(coarseIp("::ffff:198.51.100.7")).toBe("198.51.100.x");
    expect(coarseIp("2001:db8:85a3:8d3:1319:8a2e:370:7348")).toBe("2001:db8:85a3::");
    expect(coarseIp("unknown")).toBe("");
  });
});

describe("personal access tokens", () => {
  it("are anywr_ tokens stored only as a hash, resolvable until revoked", async () => {
    const u = await createUser(db, "a@example.com");
    const { id, token } = await createPat(db, u.id, "laptop");
    expect(token).toMatch(/^anywr_[A-Za-z0-9_-]{32,}$/);
    const stored = await db.query<{ token_hash: string }>("SELECT token_hash FROM personal_access_tokens");
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(await resolveBearer(db, `Bearer ${token}`)).toMatchObject({ userId: u.id, via: "pat" });
    expect((await listPats(db, u.id)).map((p) => p.name)).toEqual(["laptop"]);
    await revokePat(db, u.id, id);
    expect(await resolveBearer(db, `Bearer ${token}`)).toBeNull();
  });

  it("rejects missing, malformed and unknown bearer values", async () => {
    expect(await resolveBearer(db, undefined)).toBeNull();
    expect(await resolveBearer(db, "Basic abc")).toBeNull();
    expect(await resolveBearer(db, "Bearer anywr_nope")).toBeNull();
  });

  it("cannot be revoked by another user", async () => {
    const a = await createUser(db, "a@example.com");
    const b = await createUser(db, "b@example.com");
    const { id, token } = await createPat(db, a.id, "x");
    await revokePat(db, b.id, id);
    expect(await resolveBearer(db, `Bearer ${token}`)).not.toBeNull();
  });
});

describe("web sessions", () => {
  it("resolve to the user until deleted and bind a CSRF token", async () => {
    const u = await createUser(db, "a@example.com");
    const sid = await createSession(db, u.id);
    expect(await getSessionUser(db, sid)).toMatchObject({ id: u.id, email: "a@example.com" });
    const t = csrfToken(sid);
    expect(checkCsrf(sid, t)).toBe(true);
    expect(checkCsrf(sid, "x" + t.slice(1))).toBe(false);
    await deleteSession(db, sid);
    expect(await getSessionUser(db, sid)).toBeNull();
  });
});
