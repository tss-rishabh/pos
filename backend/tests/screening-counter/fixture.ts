import mysql from 'mysql2/promise';
import { sql } from 'drizzle-orm';
import type { AdministrationTransaction } from '../../src/modules/administration/checkins.js';
import {
  verifiedMysqlFixture,
  type FixtureValue,
} from '../../tools/operational-reports/verified-mysql-fixture.js';
import { publicScreeningFixture } from '../public-screening-writer/native-fixture.js';
import { counterInstallationSql } from '../../src/modules/legacy-order-imports/screening-counter/writers.js';
import {
  screeningCounterSourceCapture,
  initializeScreeningCounter,
} from '../../src/modules/legacy-order-imports/screening-counter/publisher.js';
import { sealCounterPublication } from '../../src/modules/legacy-order-imports/screening-counter/contracts.js';
export const sourceKey = 'fixture-independent-screening-source-key-'.repeat(2);
export const publicationKey = 'fixture-independent-screening-publication-key-'.repeat(2);
export const counterOptions = {
  contract: 'pos-screening-current-counter-v1' as const,
  publicationKey,
};
/** Adapter of the verified, default-preserving isolated DDL fixture to this
 * test transaction. mysql.format escapes fixture literals; production queries
 * continue to use Drizzle bound parameters. */
export async function insertCounterFixture(
  tx: AdministrationTransaction,
  table: string,
  overrides: Record<string, FixtureValue>,
) {
  const fixture = verifiedMysqlFixture(
    {
      query: async (statement: string, values: unknown[]) =>
        tx.execute(sql.raw(mysql.format(statement, values))),
    } as unknown as mysql.Connection,
    ['evidence/mysql-screening-schema.json'],
  );
  await fixture.insert(table, overrides);
}
export async function currentCounterFixture(template: string) {
  const f = await publicScreeningFixture(template);
  await f.reset();
  await f.fixture.insert('users', { id: '78', status: 1, is_block: 0, is_disabled: 0 });
  for (const statement of counterInstallationSql) await f.connection.query(statement);
  async function initialize(customerId: string) {
    const capture = await screeningCounterSourceCapture(f.db, sourceKey).capture(customerId);
    // Synthetic independently-owned BQ fixture publication. Actual runtime
    // publisher uses the separately verified warehouse query, never this SQL.
    const [raw] = await f.connection.query<mysql.RowDataPacket[]>(
      `SELECT CAST(s.id AS CHAR) markerId,CAST(s.order_id AS CHAR) orderId,CAST(s.has_product_id AS CHAR) lineId,
      IF(hp.prod_id=390238 AND o.order_status NOT IN(0,17),1,0) included FROM spiderman_screening_orders s LEFT JOIN orders o ON o.id=s.order_id LEFT JOIN has_products hp ON hp.id=s.has_product_id WHERE s.user_id=? ORDER BY s.id`,
      [customerId],
    );
    const baseline = sealCounterPublication(capture, sourceKey, publicationKey, {
      generationId: 'a'.repeat(64),
      snapshotId: capture.snapshotId,
      sourceCaptureHash: capture.signature,
      sourceCdcThrough: Date.now(),
      complete: true,
      rows: raw.map((row) => ({
        markerId: row.markerId as string,
        orderId: row.orderId as string,
        lineId: row.lineId as string,
        included: row.included === 1,
      })),
    });
    await initializeScreeningCounter(f.db, baseline, publicationKey);
    return baseline;
  }
  return { ...f, initialize };
}
