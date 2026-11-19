/**
 * Guarded read-only MySQL access for the live production parity suite (Phase F1).
 *
 * Three independent layers stand between the rewrite's read code and production:
 *
 * 1. Drizzle session: a `logQuery` hook runs {@link guardStatement} before every builder,
 *    `execute`, `all` and transaction-bracket statement, and throws before the driver is called.
 * 2. mysql2 promise pool and its pool connections (a Proxy): every `query`/`execute` is guarded,
 *    locking reads are downgraded to plain consistent reads, and each SELECT is EXPLAINed first.
 *    The plan gate refuses a full scan of a table with more than `planRowLimit` rows
 *    (`information_schema.TABLES.table_rows`, or the EXPLAIN estimate for aliases and derived
 *    tables) and any access whose estimate exceeds the same limit, unless that access is an
 *    index-ordered, LIMIT-bounded driving scan with no filesort/temporary (plan-gate.ts).
 * 3. Every core mysql2 connection: `query`, `execute` and `prepare` are wrapped on the instance
 *    with the strict guard (locking reads refused), so even a path that bypassed layers 1 and 2
 *    fails loudly. Each new connection first runs exactly `SET SESSION TRANSACTION READ ONLY` and
 *    `SET SESSION MAX_EXECUTION_TIME=<≤10000>`, verifies both with a SELECT, and is destroyed
 *    (and refused) if either is missing.
 *
 * `multipleStatements` is disabled. Credentials and server error text are never printed: callers
 * report {@link errorCode} only.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/mysql2';
import type { Logger } from 'drizzle-orm/logger';
import mysql from 'mysql2/promise';
import type { PoolConnection as CorePoolConnection } from 'mysql2';
import { z } from 'zod';
import type { Databases } from '../../src/db/pools.js';
import { planShape, planVerdict, trailingLimit } from './plan-gate.js';
import {
  guardStatement,
  maxExecutionTimeLimit,
  ReadOnlyGuardError,
  statementText,
} from './sql-guard.js';

export const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** `POS_PROD_RO_MYSQL_CA` value that allows plaintext, accepted only for a loopback host. */
export const localPlaintext = 'plaintext-localhost';
const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export const liveEnvSchema = z.object({
  POS_PROD_RO_MYSQL_URL: z.string().startsWith('mysql://'),
  POS_PROD_RO_MYSQL_CA: z.string().min(1).optional(),
  POS_PROD_RO_MAX_EXECUTION_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(maxExecutionTimeLimit)
    .default(maxExecutionTimeLimit),
  POS_PROD_RO_PLAN_ROW_LIMIT: z.coerce.number().int().min(1).max(100_000).default(100_000),
  // W16: the read paths take no locks any more, so strict refusal is the default.
  POS_PROD_RO_LOCKING_READS: z.enum(['downgrade', 'refuse']).default('refuse'),
  /**
   * How read-only is proven. `session` (default) requires @@SESSION.transaction_read_only = 1.
   * `grants` is for servers behind a proxy that does not keep transaction_read_only (for
   * example ProxySQL): the session flag may read 0, and the account's privileges in
   * information_schema must be SELECT/USAGE only, or the run is refused.
   */
  POS_PROD_RO_READONLY_PROOF: z.enum(['session', 'grants']).default('session'),
});
export type LiveEnv = z.infer<typeof liveEnvSchema>;

export function liveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env['POS_PROD_RO_MYSQL_URL']);
}

/** Thrown by the plan gate. Carries only table names, access types and estimates. */
export class PlanGuardError extends Error {
  readonly code: 'RO_PLAN_FULL_SCAN' | 'RO_PLAN_ROWS';
  readonly table: string;
  readonly access: string;
  readonly estimate: number;
  constructor(
    code: 'RO_PLAN_FULL_SCAN' | 'RO_PLAN_ROWS',
    table: string,
    access: string,
    estimate: number,
  ) {
    super(`Plan gate skipped a statement (${code}) on ${table} (${access}, ~${estimate} rows).`);
    this.name = 'PlanGuardError';
    this.code = code;
    this.table = table;
    this.access = access;
    this.estimate = estimate;
  }
}

/** The first error of `type` in an error's `cause` chain (Drizzle wraps driver errors). */
export function causeOf<T extends Error>(
  error: unknown,
  type: abstract new (...args: never[]) => T,
): T | undefined {
  for (let current = error, depth = 0; current && depth < 8; depth += 1) {
    if (current instanceof type) return current;
    current = typeof current === 'object' && 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

/** A printable error code: never the message, which may echo SQL text or values. */
export function errorCode(error: unknown): string {
  if (error instanceof ReadOnlyGuardError || error instanceof PlanGuardError) return error.code;
  if (error && typeof error === 'object') {
    if ('code' in error && typeof error.code === 'string' && /^[A-Z0-9_]{2,64}$/.test(error.code))
      return error.code;
    if ('name' in error && error.name === 'ZodError') return 'ZOD_PARSE';
    if ('cause' in error && error.cause) return errorCode(error.cause);
  }
  return 'UNKNOWN';
}

export interface PlanRejection {
  code: PlanGuardError['code'];
  table: string;
  access: string;
  estimate: number;
}
/** A plan accepted only because a LIMIT-bounded, index-ordered scan drives it (plan-gate.ts). */
export interface PlanBounded {
  table: string;
  access: string;
  estimate: number;
}
export interface GuardStats {
  statements: number;
  reads: number;
  explains: number;
  transactions: number;
  downgradedLocks: number;
  downgradedUpdateLocks: number;
  refused: number;
  refusedCodes: string[];
  planRejected: PlanRejection[];
  planBounded: PlanBounded[];
  connections: number;
  verifiedConnections: number;
}
export function emptyStats(): GuardStats {
  return {
    statements: 0,
    reads: 0,
    explains: 0,
    transactions: 0,
    downgradedLocks: 0,
    downgradedUpdateLocks: 0,
    refused: 0,
    refusedCodes: [],
    planRejected: [],
    planBounded: [],
    connections: 0,
    verifiedConnections: 0,
  };
}
export function statsDelta(after: GuardStats, before: GuardStats) {
  return {
    statements: after.statements - before.statements,
    explains: after.explains - before.explains,
    downgradedLocks: after.downgradedLocks - before.downgradedLocks,
    downgradedUpdateLocks: after.downgradedUpdateLocks - before.downgradedUpdateLocks,
    refused: after.refused - before.refused,
    refusedCodes: after.refusedCodes.slice(before.refusedCodes.length),
    planRejected: after.planRejected.slice(before.planRejected.length),
    planBounded: after.planBounded.slice(before.planBounded.length),
  };
}

export function connectionOptions(env: LiveEnv): mysql.PoolOptions {
  const url = new URL(env.POS_PROD_RO_MYSQL_URL);
  if (url.protocol !== 'mysql:') throw new Error('POS_PROD_RO_MYSQL_URL must be a mysql:// URL.');
  const database = decodeURIComponent(url.pathname.replace(/^\//, '')) || 'tss';
  if (!/^[A-Za-z0-9_]{1,64}$/.test(database))
    throw new Error('POS_PROD_RO_MYSQL_URL must name a plain schema.');
  const loopback = loopbackHosts.has(url.hostname);
  let ssl: mysql.PoolOptions['ssl'];
  if (env.POS_PROD_RO_MYSQL_CA === localPlaintext) {
    if (!loopback) throw new Error(`${localPlaintext} is accepted only for a loopback MySQL host.`);
    ssl = undefined;
  } else
    ssl = {
      ca: readFileSync(env.POS_PROD_RO_MYSQL_CA ?? resolve(backendRoot, '../global-bundle.pem')),
      rejectUnauthorized: true,
    };
  return {
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    ssl,
    // Same driver typing as src/db/pools.ts, so read paths see production value types.
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
    timezone: 'Z',
    multipleStatements: false,
    connectTimeout: 10_000,
    connectionLimit: 2,
    maxIdle: 2,
    idleTimeout: 600_000,
    waitForConnections: true,
    queueLimit: 32,
  };
}

export type QueryArgument = string | { sql: string; [key: string]: unknown };
export interface Queryable {
  query(argument: QueryArgument, values?: unknown): Promise<unknown>;
  execute(argument: QueryArgument, values?: unknown): Promise<unknown>;
}

export interface GuardedDatabase {
  databases: Databases;
  db: ReturnType<Databases['get']>;
  stats: GuardStats;
  database: string;
  maxExecutionMs: number;
  planRowLimit: number;
  lockingReads: 'downgrade' | 'refuse';
  /** Session read-only and statement timeout as the server reports them. */
  sessionState(): Promise<{ readOnly: boolean; maxExecutionMs: number }>;
  close(): Promise<void>;
}

function refusal(stats: GuardStats) {
  return (error: unknown) => {
    stats.refused += 1;
    stats.refusedCodes.push(error instanceof ReadOnlyGuardError ? error.code : 'RO_GUARD');
    return error;
  };
}

/**
 * Layer 3: wraps `query`, `execute` and `prepare` on one core mysql2 connection with the strict
 * guard (locking reads refused). Throws synchronously before the driver sees the statement.
 */
export function guardCoreConnection(
  connection: object,
  stats: GuardStats,
  isBroken: () => boolean = () => false,
): void {
  const refuse = refusal(stats),
    core = connection as Record<string, unknown>;
  for (const method of ['query', 'execute', 'prepare'] as const) {
    const original = core[method];
    if (typeof original !== 'function') continue;
    core[method] = function guarded(this: unknown, ...args: unknown[]) {
      if (isBroken())
        throw refuse(new ReadOnlyGuardError('RO_GUARD_STATEMENT', 'Connection is not verified.'));
      if (method === 'prepare')
        throw refuse(
          new ReadOnlyGuardError('RO_GUARD_STATEMENT', 'Prepared statements are refused.'),
        );
      try {
        guardStatement(statementText(args[0]));
      } catch (error) {
        throw refuse(error);
      }
      return (original as (...values: unknown[]) => unknown).apply(this, args);
    };
  }
}

export type PlanGate = (target: Queryable, sql: string, values: unknown) => Promise<void>;

/**
 * Layers 1 and 2: a Drizzle database over a Proxy of the mysql2 promise pool. Every statement is
 * guarded in the Drizzle logger hook and again in the pool/pool-connection proxy, where locking
 * reads are downgraded and SELECTs pass the plan gate before they are sent.
 */
export function guardedDrizzle(
  pool: mysql.Pool,
  stats: GuardStats,
  planGate?: PlanGate,
  lockingReads: 'downgrade' | 'refuse' = 'downgrade',
) {
  const refuse = refusal(stats);
  function guardQueryable<T extends object>(target: T, isPool: boolean): T {
    return new Proxy(target, {
      get(object, property) {
        if (property === 'query' || property === 'execute')
          return async (argument: QueryArgument, values?: unknown) => {
            stats.statements += 1;
            let guarded;
            try {
              guarded = guardStatement(statementText(argument), { lockingReads });
            } catch (error) {
              throw refuse(error);
            }
            if (guarded.kind === 'read') stats.reads += 1;
            else stats.transactions += 1;
            if (guarded.downgraded) stats.downgradedLocks += 1;
            if (guarded.lock === 'update') stats.downgradedUpdateLocks += 1;
            const queryable = object as unknown as Queryable;
            if (guarded.explainable && planGate) await planGate(queryable, guarded.sql, values);
            const sent: QueryArgument = guarded.downgraded
              ? typeof argument === 'string'
                ? guarded.sql
                : { ...argument, sql: guarded.sql }
              : argument;
            return property === 'query'
              ? queryable.query(sent, values)
              : queryable.execute(sent, values);
          };
        if (property === 'getConnection' && isPool)
          return async () =>
            guardQueryable(await (object as unknown as mysql.Pool).getConnection(), false);
        if (property === 'prepare' || property === 'unprepare')
          return () => {
            throw refuse(
              new ReadOnlyGuardError('RO_GUARD_STATEMENT', 'Prepared statements are refused.'),
            );
          };
        const value: unknown = Reflect.get(object, property, object);
        return typeof value === 'function' ? value.bind(object) : value;
      },
    });
  }
  const guardedPool = guardQueryable(pool, true);
  const logger: Logger = {
    logQuery(query: string) {
      try {
        guardStatement(query, { lockingReads });
      } catch (error) {
        throw refuse(error);
      }
    },
  };
  return { pool: guardedPool, db: drizzle(guardedPool, { logger }) };
}

export async function openGuardedDatabase(env: LiveEnv): Promise<GuardedDatabase> {
  const options = connectionOptions(env),
    stats = emptyStats(),
    maxExecutionMs = env.POS_PROD_RO_MAX_EXECUTION_MS,
    planRowLimit = env.POS_PROD_RO_PLAN_ROW_LIMIT,
    database = String(options.database);
  const pool = mysql.createPool(options);
  const broken = new WeakSet<object>();

  // Layer 3: every core connection, strict guard, verified session settings.
  pool.pool.on('connection', (connection: CorePoolConnection) => {
    stats.connections += 1;
    guardCoreConnection(connection, stats, () => broken.has(connection));
    const fail = (error: unknown) => {
      if (error) {
        broken.add(connection);
        connection.destroy();
      }
    };
    connection.query('SET SESSION TRANSACTION READ ONLY', fail);
    connection.query(`SET SESSION MAX_EXECUTION_TIME=${maxExecutionMs}`, fail);
    connection.query(
      'SELECT @@SESSION.transaction_read_only AS ro, @@SESSION.max_execution_time AS met',
      (error: unknown, rows: unknown) => {
        const parsed = z
          .array(z.object({ ro: z.coerce.number(), met: z.coerce.number() }))
          .length(1)
          .safeParse(rows);
        if (
          error ||
          !parsed.success ||
          (env.POS_PROD_RO_READONLY_PROOF === 'session' && parsed.data[0]!.ro !== 1) ||
          parsed.data[0]!.met !== maxExecutionMs
        ) {
          broken.add(connection);
          connection.destroy();
          return;
        }
        stats.verifiedConnections += 1;
      },
    );
  });

  const tableRows = new Map<string, number>();
  async function planGate(target: Queryable, sql: string, values: unknown) {
    // Metadata reads (this suite's schema check) touch no data table.
    if (
      /^\s*select\b[^;]*\bfrom\s+information_schema\.\w+(?:\s+where\b[^;]*)?$/i.test(sql) &&
      !/\bjoin\b/i.test(sql)
    )
      return;
    stats.explains += 1;
    // FORMAT=JSON exposes per-block filesort/temporary flags; see plan-gate.ts for the rule.
    const [rows] = (await target.query(`EXPLAIN FORMAT=JSON ${sql}`, values)) as [unknown, unknown];
    const [explain] = z
      .array(z.object({ EXPLAIN: z.string() }).loose())
      .length(1)
      .parse(rows);
    const verdict = planVerdict(
      planShape(JSON.parse(explain!.EXPLAIN) as unknown),
      trailingLimit(sql, values),
      (table) => tableRows.get(table),
      planRowLimit,
    );
    if (verdict.kind === 'bounded')
      stats.planBounded.push({
        table: verdict.table,
        access: verdict.access,
        estimate: verdict.estimate,
      });
    if (verdict.kind === 'reject') {
      const rejection = new PlanGuardError(
        verdict.code,
        verdict.table,
        verdict.access,
        verdict.estimate,
      );
      stats.planRejected.push({
        code: verdict.code,
        table: verdict.table,
        access: verdict.access,
        estimate: verdict.estimate,
      });
      throw rejection;
    }
  }

  const { pool: guardedPool, db } = guardedDrizzle(
    pool,
    stats,
    planGate,
    env.POS_PROD_RO_LOCKING_READS,
  );
  const databases: Databases = {
    get: () => db,
    async close() {},
  };

  async function sessionState() {
    const [rows] = (await guardedPool.query(
      'SELECT @@SESSION.transaction_read_only AS ro, @@SESSION.max_execution_time AS met',
    )) as [unknown, unknown];
    const row = z
      .array(z.object({ ro: z.coerce.number(), met: z.coerce.number() }))
      .length(1)
      .parse(rows)[0]!;
    return { readOnly: row.ro === 1, maxExecutionMs: row.met };
  }
  try {
    const state = await sessionState();
    if (
      (env.POS_PROD_RO_READONLY_PROOF === 'session' && !state.readOnly) ||
      state.maxExecutionMs !== maxExecutionMs
    )
      throw new ReadOnlyGuardError('RO_GUARD_STATEMENT', 'Session settings were not applied.');
    if (env.POS_PROD_RO_READONLY_PROOF === 'grants' && !state.readOnly) {
      // The account itself must be unable to write: only SELECT/USAGE privileges, anywhere.
      const privileges: string[] = [];
      for (const view of [
        'USER_PRIVILEGES',
        'SCHEMA_PRIVILEGES',
        'TABLE_PRIVILEGES',
        'COLUMN_PRIVILEGES',
      ]) {
        const [rows] = (await guardedPool.query(
          `SELECT PRIVILEGE_TYPE AS privilege FROM information_schema.${view}`,
        )) as [unknown, unknown];
        privileges.push(
          ...z
            .array(z.object({ privilege: z.string() }))
            .parse(rows)
            .map((row) => row.privilege),
        );
      }
      if (privileges.length === 0 || privileges.some((p) => p !== 'SELECT' && p !== 'USAGE'))
        throw new ReadOnlyGuardError(
          'RO_GUARD_STATEMENT',
          'Account has privileges beyond SELECT/USAGE; refusing without a read-only session.',
        );
    }
    const [rows] = (await guardedPool.query(
      'SELECT TABLE_NAME AS name, TABLE_ROWS AS tableRows FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
      [database],
    )) as [unknown, unknown];
    for (const row of z
      .array(z.object({ name: z.string(), tableRows: z.coerce.number().nullable() }))
      .parse(rows))
      tableRows.set(row.name, row.tableRows ?? 0);
  } catch (error) {
    await pool.end();
    throw error;
  }
  return {
    databases,
    db,
    stats,
    database,
    maxExecutionMs,
    planRowLimit,
    lockingReads: env.POS_PROD_RO_LOCKING_READS,
    sessionState,
    async close() {
      await pool.end();
    },
  };
}
