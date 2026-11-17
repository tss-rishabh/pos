import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import type { Config } from '../config.js';
import type { Reader } from '../domain/routing.js';
import { unavailable } from '../domain/errors.js';
import type { PoolConnection } from 'mysql2';

export function databasePool(
  connection: string,
  config: Pick<Config, 'MYSQL_ALLOW_LOCAL_PLAINTEXT' | 'MYSQL_TLS_CA_FILE' | 'MYSQL_POOL_SIZE'>,
  readOnly = false,
) {
  const url = new URL(connection);
  if (url.protocol !== 'mysql:' || !url.pathname.slice(1))
    throw new Error('Database configuration must be a MySQL URL with a schema.');
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  const plaintext = local && config.MYSQL_ALLOW_LOCAL_PLAINTEXT;
  const pool = mysql.createPool({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    ssl: plaintext
      ? undefined
      : {
          rejectUnauthorized: true,
          ...(config.MYSQL_TLS_CA_FILE ? { ca: readFileSync(config.MYSQL_TLS_CA_FILE) } : {}),
        },
    connectionLimit: config.MYSQL_POOL_SIZE,
    maxIdle: config.MYSQL_POOL_SIZE,
    idleTimeout: 60_000,
    connectTimeout: 6000,
    enableKeepAlive: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
    multipleStatements: false,
    waitForConnections: true,
    queueLimit: 64,
    timezone: 'Z',
  });
  pool.pool.on('connection', (connection: PoolConnection) => {
    if (readOnly)
      connection.query('SET SESSION TRANSACTION READ ONLY', (error) => {
        if (error) connection.destroy();
      });
    connection.query(`SET SESSION MAX_EXECUTION_TIME=${readOnly ? 10000 : 15000}`, (error) => {
      if (error) connection.destroy();
    });
  });
  return pool;
}
export function createDatabases(config: Config) {
  const pools = new Map<string, ReturnType<typeof databasePool>>();
  for (const [name, value] of Object.entries({
    writer: config.MYSQL_WRITER_URL,
    primary: config.MYSQL_PRIMARY_READER_URL,
    data: config.MYSQL_DATA_READER_URL,
  })) {
    if (value) pools.set(name, databasePool(value, config, name !== 'writer'));
  }
  function get(name: Exclude<Reader, 'bigquery'> | 'writer') {
    const pool = pools.get(name);
    if (!pool) return unavailable(`MySQL ${name}`);
    return drizzle(pool);
  }
  return {
    get,
    async close() {
      await Promise.all([...pools.values()].map((pool) => pool.end()));
    },
  };
}
export type Databases = ReturnType<typeof createDatabases>;
