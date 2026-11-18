import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readNativeHeadMetadata } from '../../src/modules/screening-origins/native-head-metadata.js';
import { publicScreeningFixture } from './native-fixture.js';
const template = process.env.CHECKOUT_MYSQL_TEST_URL;
describe.skipIf(!template)('reviewed source referral allocation privilege', () => {
  let f: Awaited<ReturnType<typeof publicScreeningFixture>>;
  beforeAll(async () => {
    f = await publicScreeningFixture(template!);
    await f.reset();
  }, 30000);
  afterAll(async () => {
    await f?.close();
  });
  it('admits only UPDATE for the actual app account and refuses the same native statement when revoked', async () => {
    const heads = f.headFixture!;
    const account = mysql.escape(heads.names.app) + "@'%'";
    const target = mysql.escapeId(heads.schema) + '.referral_log';
    const [rights] = await f.connection.query<mysql.RowDataPacket[]>(
      "SELECT PRIVILEGE_TYPE privilegeName FROM information_schema.TABLE_PRIVILEGES WHERE TABLE_SCHEMA=? AND TABLE_NAME='referral_log' AND GRANTEE=? ORDER BY PRIVILEGE_TYPE",
      [heads.schema, "'" + heads.names.app + "'@'%'"],
    );
    expect(rights.map((row) => row.privilegeName)).toEqual(['UPDATE']);
    await f.sourceFixture.insert('referral_log', {
      id: 1,
      referred_to: 77,
      referred_by: 78,
      order_count: 0,
      order_id: 0,
    });
    const app = await mysql.createConnection(heads.appUrl);
    const statement = 'UPDATE referral_log SET order_count = 1, order_id = ? WHERE referred_to = ?';
    try {
      const [identity] = await app.query<mysql.RowDataPacket[]>('SELECT CURRENT_USER() account');
      expect(identity[0]!.account).toBe(heads.names.app + '@%');
      await f.connection.query('REVOKE UPDATE ON ' + target + ' FROM ' + account);
      await expect(app.execute(statement, [5001, 77])).rejects.toMatchObject({
        errno: 1142,
        code: 'ER_TABLEACCESS_DENIED_ERROR',
      });
      await f.connection.query('GRANT UPDATE ON ' + target + ' TO ' + account);
      // Re-attest the complete native participant/grant universe after changing
      // grants; the application never receives source/head owner authority.
      await heads.sourceDb
        .get('primary')
        .transaction((tx) => readNativeHeadMetadata(tx, heads.headMetadata));
      await app.execute(statement, [5001, 77]);
      const [rows] = await app.query<mysql.RowDataPacket[]>(
        'SELECT order_count,CAST(order_id AS CHAR) orderId FROM referral_log WHERE id=1',
      );
      expect(rows).toEqual([{ order_count: 1, orderId: '5001' }]);
    } finally {
      await app.end();
    }
  });
});
