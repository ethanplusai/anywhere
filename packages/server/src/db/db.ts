import pg from "pg";

/** The whole data layer contract. Two drivers implement it: pg and PGlite. */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Runs fn in one transaction. Nested calls reuse the outer transaction. */
  transaction<R>(fn: (tx: Db) => Promise<R>): Promise<R>;
  close(): Promise<void>;
}

export interface PgOptions {
  /** Connections in the pool. Keep it small on serverless, where every instance has its own pool. */
  max?: number;
  /** Any statement running longer is cancelled (audit D4). */
  statementTimeoutMs?: number;
  /** A transaction left idle this long is ended by the server, releasing its locks. */
  idleInTransactionTimeoutMs?: number;
}

export const PG_DEFAULTS: Required<PgOptions> = { max: 10, statementTimeoutMs: 15_000, idleInTransactionTimeoutMs: 10_000 };

/** The pg.Pool configuration pgDb uses; exported so the settings can be checked without a database. */
export function poolConfig(connectionString: string, options: PgOptions = {}): pg.PoolConfig {
  const o = { ...PG_DEFAULTS, ...options };
  return {
    connectionString,
    max: o.max,
    statement_timeout: o.statementTimeoutMs,
    idle_in_transaction_session_timeout: o.idleInTransactionTimeoutMs,
    connectionTimeoutMillis: 10_000,
  };
}

export function pgDb(connectionString: string, options: PgOptions = {}): Db {
  const pool = new pg.Pool(poolConfig(connectionString, options));
  // An idle client erroring (database restart, failover) must not crash the process; the pool replaces it.
  pool.on("error", (err) => console.error("Postgres pool error:", err.message));
  // Return bytea as Buffer (default) and timestamptz as Date (default).
  const fromClient = (client: pg.PoolClient): Db => ({
    async query<T>(sql: string, params: unknown[] = []) {
      const res = await client.query(sql, params);
      return res.rows as T[];
    },
    async transaction<R>(fn: (tx: Db) => Promise<R>) {
      return fn(fromClient(client));
    },
    async close() {},
  });
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      const res = await pool.query(sql, params);
      return res.rows as T[];
    },
    async transaction<R>(fn: (tx: Db) => Promise<R>) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(fromClient(client));
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

/** PGlite: Postgres in-process. Used for tests and for running without a database server. */
export async function pgliteDb(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = dataDir ? new PGlite(dataDir) : new PGlite();
  await db.waitReady;
  type Tx = { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };
  const fromTx = (tx: Tx): Db => ({
    async query<T>(sql: string, params: unknown[] = []) {
      const res = await tx.query(sql, params);
      return res.rows.map(normaliseRow) as T[];
    },
    async transaction<R>(fn: (tx: Db) => Promise<R>) {
      return fn(fromTx(tx));
    },
    async close() {},
  });
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      const res = await db.query(sql, params);
      return res.rows.map(normaliseRow) as T[];
    },
    async transaction<R>(fn: (tx: Db) => Promise<R>) {
      return db.transaction((tx) => fn(fromTx(tx)));
    },
    async close() {
      await db.close();
    },
  };
}

/** PGlite returns bytea as Uint8Array; make it a Buffer like pg does. */
function normaliseRow(row: unknown): unknown {
  if (row && typeof row === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      out[k] = v instanceof Uint8Array && !Buffer.isBuffer(v) ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : v;
    }
    return out;
  }
  return row;
}
