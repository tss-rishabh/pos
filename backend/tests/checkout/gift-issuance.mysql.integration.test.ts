import { execFileSync } from 'node:child_process';
import { pinnedSourceEnvironment } from '../../tools/pinned-source-env.js';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import mysql from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';

const template = process.env.CHECKOUT_MYSQL_TEST_URL;
describe.skipIf(!template)('native pinned gift voucher constructor and issuance candidate', () => {
  it('keeps source values, rejects strict-mode empty-phone SQL, and locks/rolls back voucher+line issuance', async () => {
    const url = new URL(template!);
    if (
      url.protocol !== 'mysql:' ||
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.pathname !== '/pos_rewrite_checkout_test' ||
      url.search ||
      url.hash
    )
      throw new Error('Gift issuance requires an explicit isolated localhost fixture.');
    const schema = 'pos_rewrite_gift_issuance_test_' + randomBytes(6).toString('hex');
    url.pathname = '/';
    const connection = await mysql.createConnection(url.href);
    try {
      await connection.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
      await connection.changeUser({ database: schema });
      const fixture = verifiedMysqlFixture(connection, [
        'evidence/mysql-global-benefits-schema.json',
        'evidence/mysql-gift-card-batches-schema.json',
      ]);
      await fixture.create(['gift_vouchers', 'gift_card_collection']);
      await connection.query('ALTER TABLE gift_vouchers ADD UNIQUE(voucher_code)');
      await connection.query(
        'CREATE TABLE gift_issuance_lines(id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,voucher_id BIGINT NOT NULL,order_id BIGINT NOT NULL) ENGINE=InnoDB',
      );
      await fixture.insert('gift_card_collection', {
        id: 1,
        size: 10,
        is_completed: 1,
        is_printed: 1,
        is_block: 0,
        created_by: 44,
      });
      url.pathname = '/' + schema;
      const script = resolve('compatibility/upstream/ordinary/gift_issuance_fixture.py'),
        runtime = resolve('compatibility/upstream/offline-cash-pricing'),
        result = z
          .object({
            checks: z.literal(7),
            strictModeUnchanged: z.literal(true),
            vouchers: z.literal(1),
            lines: z.literal(1),
            funded: z.literal(0),
          })
          .strict()
          .parse(
            JSON.parse(
              execFileSync('uv', ['run', '--project', runtime, '--frozen', 'python', script], {
                input: JSON.stringify({ url: url.href }) + '\n',
                encoding: 'utf8',
                timeout: 25_000,
                env: {
                  ...pinnedSourceEnvironment(),
                  PATH: process.env.PATH,
                  HOME: process.env.HOME,
                  UV_PROJECT_ENVIRONMENT: join(tmpdir(), 'pos-gift-issuance-runtime'),
                  PYTHONDONTWRITEBYTECODE: '1',
                },
                stdio: ['pipe', 'pipe', 'pipe'],
                cwd: dirname(dirname(dirname(script))),
              }),
            ) as unknown,
          );
      expect(result.funded).toBe(0);
    } finally {
      await connection.changeUser({ database: 'mysql' });
      await connection.query(`DROP DATABASE IF EXISTS ${mysql.escapeId(schema)}`);
      await connection.end();
    }
  }, 30_000);
});
