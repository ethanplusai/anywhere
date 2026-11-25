// Audit 2026-11-23: A1, A2, A14 (rate limits, client addresses, bearer lookups).
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/auth/ratelimit.js";
import { ipKey } from "../src/http.js";
import { freshDb, formFrom, makeTestApp, spyDb } from "./helpers.js";

const wrong = { email: "me@example.com", password: "wrong wrong wrong" };
const right = { email: "me@example.com", password: "long enough pw" };

function randomIp(): string {
  const b = randomBytes(4);
  return `${b[0]! % 223 + 1}.${b[1]}.${b[2]}.${b[3]}`;
}

describe("A1: client addresses behind a proxy", () => {
  it("abuse: a sign-in flood with a spoofed X-Forwarded-For prefix is still limited", async () => {
    const t = await makeTestApp({ ANYWHERE_AUTH_RATE_LIMIT: "3", ANYWHERE_TRUST_PROXY: "1", ANYWHERE_SIGNIN_EMAIL_LIMIT: "1000" });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 8; i++) {
        // The attacker controls the left part; the proxy appends the real address on the right.
        const res = await t.fetch("/signin", formFrom(wrong, `${randomIp()}, 203.0.113.5`));
        statuses.push(res.status);
      }
      expect(statuses.slice(0, 3)).toEqual([400, 400, 400]);
      expect(statuses.slice(3).every((s) => s === 429)).toBe(true);
      // Someone else behind the same proxy is not affected.
      const other = await t.fetch("/signin", formFrom(right, `${randomIp()}, 198.51.100.7`));
      expect(other.status).toBe(302);
    } finally {
      await t.close();
    }
  });

  it("takes the Nth entry from the right for N trusted hops", async () => {
    const t = await makeTestApp({ ANYWHERE_AUTH_RATE_LIMIT: "2", ANYWHERE_TRUST_PROXY: "2", ANYWHERE_SIGNIN_EMAIL_LIMIT: "1000" });
    try {
      for (let i = 0; i < 2; i++) await t.fetch("/signin", formFrom(wrong, `${randomIp()}, 203.0.113.9, 10.0.0.1`));
      const limited = await t.fetch("/signin", formFrom(right, `${randomIp()}, 203.0.113.9, 10.0.0.2`));
      expect(limited.status).toBe(429);
      const other = await t.fetch("/signin", formFrom(right, `203.0.113.10, 10.0.0.1`));
      expect(other.status).toBe(302);
    } finally {
      await t.close();
    }
  });

  it("uses a named platform header when configured, ignoring X-Forwarded-For", async () => {
    const t = await makeTestApp({ ANYWHERE_AUTH_RATE_LIMIT: "2", ANYWHERE_CLIENT_IP_HEADER: "x-real-ip", ANYWHERE_SIGNIN_EMAIL_LIMIT: "1000" });
    try {
      const send = (ip: string, body = wrong) => {
        const init = formFrom(body, randomIp());
        (init.headers as Record<string, string>)["x-real-ip"] = ip;
        return t.fetch("/signin", init);
      };
      await send("203.0.113.1");
      await send("203.0.113.1");
      expect((await send("203.0.113.1", right)).status).toBe(429);
      expect((await send("203.0.113.2", right)).status).toBe(302);
    } finally {
      await t.close();
    }
  });

  it("keys IPv6 addresses by their /64", () => {
    expect(ipKey("2001:db8:1:2:aaaa::1")).toBe("2001:0db8:0001:0002::/64");
    expect(ipKey("2001:db8:1:2:ffff:ffff:ffff:ffff")).toBe("2001:0db8:0001:0002::/64");
    expect(ipKey("[2001:db8::1]")).toBe("2001:0db8:0000:0000::/64");
    expect(ipKey("::ffff:203.0.113.5")).toBe("203.0.113.5");
    expect(ipKey("203.0.113.5")).toBe("203.0.113.5");
  });
});

describe("A2: rate limits that hold across instances", () => {
  it("counts in Postgres, so two app instances share one limit", async () => {
    const db = await freshDb();
    const env = { ANYWHERE_AUTH_RATE_LIMIT: "3", ANYWHERE_TRUST_PROXY: "1", ANYWHERE_SIGNIN_EMAIL_LIMIT: "1000" };
    const a = await makeTestApp(env, { db });
    const b = await makeTestApp(env, { db });
    try {
      await a.fetch("/signin", formFrom(wrong, "203.0.113.5"));
      await b.fetch("/signin", formFrom(wrong, "203.0.113.5"));
      await a.fetch("/signin", formFrom(wrong, "203.0.113.5"));
      expect((await b.fetch("/signin", formFrom(right, "203.0.113.5"))).status).toBe(429);
    } finally {
      await db.close();
    }
  });

  it("slides the window, so the edge of a window does not allow double", async () => {
    const db = await freshDb();
    let now = 60_000 * 1000; // the start of a window
    const limiter = new RateLimiter(db, () => now);
    const rule = { limit: 10, windowS: 60 };
    try {
      now += 59_000;
      for (let i = 0; i < 10; i++) expect(await limiter.hit("k", rule)).toBeNull();
      now += 2_000; // into the next fixed window
      expect(await limiter.hit("k", rule)).not.toBeNull();
      now += 60_000; // a full window later everything has slid out
      expect(await limiter.hit("k", rule)).toBeNull();
    } finally {
      await db.close();
    }
  });

  it("locks an account after repeated failures from any number of addresses", async () => {
    const t = await makeTestApp({ ANYWHERE_AUTH_RATE_LIMIT: "100", ANYWHERE_TRUST_PROXY: "1", ANYWHERE_SIGNIN_EMAIL_LIMIT: "3" });
    try {
      for (let i = 0; i < 3; i++) {
        expect((await t.fetch("/signin", formFrom(wrong, randomIp()))).status).toBe(400);
      }
      const res = await t.fetch("/signin", formFrom(right, randomIp()));
      expect(res.status).toBe(429);
      expect(await res.text()).toContain("Too many failed attempts for this account");
      // Other accounts still sign in.
      await t.fetch("/signup", formFrom({ email: "two@example.com", password: "another long pw" }, randomIp()));
      const other = await t.fetch("/signin", formFrom({ email: "two@example.com", password: "another long pw" }, randomIp()));
      expect(other.status).toBe(302);
    } finally {
      await t.close();
    }
  });

  it("limits failed bearer authentication per address on /api/v1 and /mcp", async () => {
    const t = await makeTestApp({ ANYWHERE_UNAUTH_RATE_LIMIT: "3" });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 3; i++) statuses.push((await t.api("GET", "/me", undefined, `anywr_guess${i}`)).status);
      statuses.push((await t.fetch("/mcp", { method: "POST", headers: { authorization: "Bearer anywr_nope" } })).status);
      expect(statuses).toEqual([401, 401, 401, 429]);
      // A valid token is not affected by other people's failures.
      expect((await t.api("GET", "/me")).status).toBe(200);
    } finally {
      await t.close();
    }
  });
});

describe("A14: bearer lookups", () => {
  it("runs no UPDATE for guessed tokens and touches last_used_at at most once a minute", async () => {
    const spy = spyDb(await freshDb());
    const t = await makeTestApp({ ANYWHERE_UNAUTH_RATE_LIMIT: "1000" }, { db: spy.db });
    try {
      spy.statements.length = 0;
      for (let i = 0; i < 5; i++) await t.api("GET", "/me", undefined, `anywr_${randomBytes(8).toString("hex")}`);
      expect(spy.statements.filter((s) => /UPDATE\s+personal_access_tokens/i.test(s))).toHaveLength(0);
      for (let i = 0; i < 5; i++) expect((await t.api("GET", "/me")).status).toBe(200);
      expect(spy.statements.filter((s) => /UPDATE\s+personal_access_tokens/i.test(s))).toHaveLength(1);
    } finally {
      await t.close();
    }
  });
});
