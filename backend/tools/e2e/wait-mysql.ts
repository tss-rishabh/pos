import mysql from 'mysql2/promise';

/**
 * Wait (up to 120 s) for the isolated loopback MySQL named by E2E_MYSQL_URL and check the server
 * settings the e2e stacks rely on: an empty global sql_mode (production runs non-strict) and a
 * loopback-only bind address. Prints the version and settings only, never the URL.
 */
const raw = process.env.E2E_MYSQL_URL ?? '';
const url = new URL(raw);
if (url.protocol !== 'mysql:' || !['127.0.0.1', 'localhost'].includes(url.hostname))
  throw new Error('E2E_MYSQL_URL must name a loopback MySQL server.');
url.pathname = '/';
const deadline = Date.now() + 120000;
let lastError = 'not attempted';
for (;;) {
  try {
    const connection = await mysql.createConnection({ uri: url.href, connectTimeout: 3000 });
    try {
      const [rows] = await connection.query(
        'SELECT @@version AS version, @@GLOBAL.sql_mode AS sqlMode, @@bind_address AS bind',
      );
      const row = (rows as { version: string; sqlMode: string; bind: string }[])[0]!;
      process.stdout.write(JSON.stringify(row) + '\n');
      if (row.sqlMode !== '') throw new Error('The e2e MySQL global sql_mode must be empty.');
      if (row.bind !== '127.0.0.1') throw new Error('The e2e MySQL must bind to 127.0.0.1 only.');
      break;
    } finally {
      await connection.end();
    }
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (
      !code ||
      !['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'PROTOCOL_CONNECTION_LOST'].includes(code)
    )
      throw error;
    lastError = code;
    if (Date.now() > deadline) throw new Error(`MySQL did not accept connections (${lastError}).`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
