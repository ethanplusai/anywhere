import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/db.js";
import { createUser, verifyLogin } from "../src/auth/users.js";
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
  it("signs in with the right password, case-insensitive email", async () => {
    const u = await createUser(db, "Ann@Example.com", "correct horse battery");
    expect(await verifyLogin(db, "ann@example.com", "correct horse battery")).toEqual({ id: u.id, email: "Ann@Example.com" });
    expect(await verifyLogin(db, "ann@example.com", "wrong")).toBeNull();
    expect(await verifyLogin(db, "nobody@example.com", "x")).toBeNull();
  });

  it("refuses a duplicate email and a short password", async () => {
    await createUser(db, "a@example.com", "long enough pw");
    await expect(createUser(db, "A@example.com", "long enough pw")).rejects.toMatchObject({ code: "email_taken" });
    await expect(createUser(db, "b@example.com", "short")).rejects.toMatchObject({ code: "invalid_body" });
    await expect(createUser(db, "not-an-email", "long enough pw")).rejects.toMatchObject({ code: "invalid_body" });
  });
});

describe("personal access tokens", () => {
  it("are anywr_ tokens stored only as a hash, resolvable until revoked", async () => {
    const u = await createUser(db, "a@example.com", "long enough pw");
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
    const a = await createUser(db, "a@example.com", "long enough pw");
    const b = await createUser(db, "b@example.com", "long enough pw");
    const { id, token } = await createPat(db, a.id, "x");
    await revokePat(db, b.id, id);
    expect(await resolveBearer(db, `Bearer ${token}`)).not.toBeNull();
  });
});

describe("web sessions", () => {
  it("resolve to the user until deleted and bind a CSRF token", async () => {
    const u = await createUser(db, "a@example.com", "long enough pw");
    const sid = await createSession(db, u.id);
    expect(await getSessionUser(db, sid)).toMatchObject({ id: u.id, email: "a@example.com" });
    const t = csrfToken(sid);
    expect(checkCsrf(sid, t)).toBe(true);
    expect(checkCsrf(sid, "x" + t.slice(1))).toBe(false);
    await deleteSession(db, sid);
    expect(await getSessionUser(db, sid)).toBeNull();
  });
});
