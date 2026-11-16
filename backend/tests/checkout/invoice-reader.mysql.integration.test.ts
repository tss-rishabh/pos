import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import mysql from 'mysql2/promise';
import { expect, it } from 'vitest';
import { z } from 'zod';

const template = process.env.CHECKOUT_MYSQL_TEST_URL;
it.skipIf(!template)(
  'uses actual read-only invoice connections without weakening SQL mode',
  async () => {
    const url = new URL(template ?? '');
    if (
      url.protocol !== 'mysql:' ||
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.pathname !== '/pos_rewrite_checkout_test'
    )
      throw new Error('Invoice tests require the isolated local MySQL template.');
    const schema = 'pos_rewrite_invoice_test_' + randomBytes(6).toString('hex'),
      connection = await mysql.createConnection({
        host: url.hostname,
        port: Number(url.port || 3306),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
      });
    try {
      await connection.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
      await connection.changeUser({ database: schema });
      await connection.query(
        'CREATE TABLE invoice_read_guard (id BIGINT PRIMARY KEY, marker VARCHAR(32) NOT NULL)',
      );
      await connection.execute('INSERT INTO invoice_read_guard(id,marker) VALUES (1,?)', [
        'reader-ready',
      ]);
      url.pathname = '/' + schema;
      const project = resolve('compatibility/upstream/invoice-security/runtime'),
        probe = resolve('compatibility/upstream/invoice-security/reader_probe.py');
      const result = z
        .object({
          selected: z.literal('reader-ready'),
          writeRejected: z.literal(true),
          rows: z.literal(1),
          sqlModeUnchanged: z.literal(true),
          runtime: z
            .object({
              privateHeaderRequired: z.literal(true),
              legacyRouteAbsent: z.literal(true),
              oversizedIdRejected: z.literal(true),
              writerBindingsAbsent: z.literal(true),
              redisWriterAbsent: z.literal(true),
              runtime: z.literal('locked-python312-falcon4-sqlalchemy2'),
            })
            .strict(),
        })
        .strict()
        .parse(
          JSON.parse(
            execFileSync('uv', ['run', '--frozen', '--project', project, 'python', probe], {
              input: JSON.stringify({ url: url.href }),
              encoding: 'utf8',
              timeout: 20_000,
              maxBuffer: 64 * 1024,
              env: { PATH: process.env.PATH, HOME: process.env.HOME, PYTHONDONTWRITEBYTECODE: '1' },
              stdio: ['pipe', 'pipe', 'pipe'],
            }),
          ) as unknown,
        );
      expect(result.rows).toBe(1);
    } finally {
      await connection.query(`DROP DATABASE IF EXISTS ${mysql.escapeId(schema)}`);
      await connection.end();
    }
  },
  30_000,
);
