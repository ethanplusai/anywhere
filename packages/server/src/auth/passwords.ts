import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * scrypt N=2^15, r=8, p=3: one of the OWASP-recommended equivalents of N=2^17, p=1 (audit A8), at a
 * quarter of the memory (32 MiB per hash), which matters on small serverless instances.
 */
const PARAMS = { N: 32768, r: 8, p: 3 };
const KEYLEN = 64;
/** Hashes run at most this many at a time per process, so a sign-in flood cannot exhaust memory. */
const MAX_CONCURRENT = 4;

let running = 0;
const waiting: (() => void)[] = [];

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

function derive(password: string, salt: Buffer, p: { N: number; r: number; p: number }): Promise<Buffer> {
  return slot(
    () =>
      new Promise((resolve, reject) =>
        scrypt(password.normalize("NFKC"), salt, KEYLEN, { ...p, maxmem: 256 * p.N * p.r + 1024 * 1024 }, (err, key) =>
          err ? reject(err) : resolve(key),
        ),
      ),
  );
}

/** Stored as `scrypt:N:r:p:saltBase64:keyBase64`. Older hashes are `scrypt:N:saltBase64:keyBase64` (r=8, p=1). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, PARAMS);
  return ["scrypt", PARAMS.N, PARAMS.r, PARAMS.p, salt.toString("base64"), key.toString("base64")].join(":");
}

function parse(stored: string): { N: number; r: number; p: number; salt: Buffer; key: Buffer } | null {
  const parts = stored.split(":");
  if (parts[0] !== "scrypt") return null;
  const [N, r, p, salt, key] =
    parts.length === 4 ? [parts[1], "8", "1", parts[2], parts[3]] : parts.length === 6 ? parts.slice(1) : [];
  const nums = [N, r, p].map(Number);
  if (!salt || !key || nums.some((n) => !Number.isSafeInteger(n) || n < 1)) return null;
  return { N: nums[0]!, r: nums[1]!, p: nums[2]!, salt: Buffer.from(salt, "base64"), key: Buffer.from(key, "base64") };
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const h = parse(stored);
  if (!h || h.N > 1 << 20 || h.r > 32 || h.p > 16) return false;
  const key = await derive(password, h.salt, h);
  return key.length === h.key.length && timingSafeEqual(key, h.key);
}

/** True when a stored hash uses weaker parameters than today's; it is replaced at the next sign-in. */
export function needsRehash(stored: string): boolean {
  const h = parse(stored);
  return !h || h.N !== PARAMS.N || h.r !== PARAMS.r || h.p !== PARAMS.p;
}
