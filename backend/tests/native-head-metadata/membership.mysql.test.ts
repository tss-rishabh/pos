import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type mysql from 'mysql2/promise';
import { importFinancialFixture } from '../legacy-import-financial/fixture.js';
import { installNativeHeadFixture } from './fixture.js';
import {
  nativeMembershipGenerationPublisher,
  publishMembershipGeneration,
} from '../../src/modules/checkout/screening-writer/membership-history-publication.js';
import { readNativeHeadMetadata } from '../../src/modules/screening-origins/native-head-metadata.js';
import { couponHistoryWriterDefinitions } from '../../src/modules/legacy-order-imports/benefit-profile/history-writers.js';
const template = process.env.CHECKOUT_MYSQL_TEST_URL;
const authority = {
  sourceKey: 'native-member-source-key-'.repeat(3),
  publicationKey: 'native-member-publication-key-'.repeat(3),
  memberIds: ['390238'],
};
describe.skipIf(!template)('actual shared membership and coupon publication owners', () => {
  let f: Awaited<ReturnType<typeof importFinancialFixture>>,
    heads: Awaited<ReturnType<typeof installNativeHeadFixture>>,
    publisher: ReturnType<typeof nativeMembershipGenerationPublisher>;
  let latest: string, earlier: string;
  beforeAll(async () => {
    f = await importFinancialFixture(template!);
    heads = await installNativeHeadFixture(f.connection, template!, {
      families: ['membership', 'coupon'],
    });
    await f.reset();
    const [rows] = await f.connection.query<mysql.RowDataPacket[]>(
      "SELECT @@GLOBAL.server_uuid serverUuid,DATE_FORMAT(UTC_TIMESTAMP()-INTERVAL 5 MINUTE,'%Y-%m-%d %H:%i:%s') latest,DATE_FORMAT(UTC_TIMESTAMP()-INTERVAL 10 MINUTE,'%Y-%m-%d %H:%i:%s') earlier",
    );
    latest = String(rows[0]!.latest);
    earlier = String(rows[0]!.earlier);
    publisher = nativeMembershipGenerationPublisher(
      heads.sourceDb,
      {
        contract: 'pos-membership-history-native-publication-v1',
        sourceSchema: heads.schema,
        sourceServerUuid: String(rows[0]!.serverUuid),
        triggerDefiner: heads.headMetadata.membershipDefiner!,
        headMetadata: heads.headMetadata,
        sourceTimeZone: 'UTC',
      },
      authority,
    );
    for (const [id, status, createdAt] of [
      ['5101', 3, earlier],
      ['5102', 3, latest],
      ['5103', 1, latest],
    ] as const)
      await f.fixture.insert('orders', {
        id,
        user_id: '77',
        order_status: status,
        payment_method: 14,
        created_at: createdAt,
        updated_at: createdAt,
      });
    await f.fixture.insert('has_products', {
      id: '6101',
      order_id: '5102',
      prod_id: '390238',
      qty: 1,
      is_exclusive_order: 0,
    });
  }, 60000);
  afterAll(async () => {
    await heads?.close();
    await f?.close();
  });
  const capture = () =>
    publisher.capture({
      customerId: '77',
      generationId: 'a'.repeat(64),
      configurationHash: 'b'.repeat(64),
    });
  it('qualifies both installed families under their separate locked owners', async () => {
    const result = await heads.sourceDb
      .get('writer')
      .transaction((tx) => readNativeHeadMetadata(tx, heads.headMetadata));
    expect(result.membershipTriggers).toHaveLength(7);
    expect(result.couponTriggers).toHaveLength(10);
    expect(result.counterTriggers).toEqual([]);
    expect(new Set(result.membershipTriggers.map((t) => t.definer))).toEqual(
      new Set([heads.headMetadata.membershipDefiner]),
    );
    expect(new Set(result.couponTriggers.map((t) => t.definer))).toEqual(
      new Set([heads.headMetadata.couponDefiner]),
    );
  });
  it('captures genuine ordered native delivered history and seals only independent matching warehouse facts', async () => {
    const source = await capture();
    const selection = {
      lastDeliveredOrder: {
        id: '5102',
        paymentMethod: 14,
        createdAt: latest,
        lines: [{ lineId: '6101', productId: '390238', isExclusiveOrder: 0 }],
      },
      recentDeliveredOrders: [
        {
          id: '5102',
          paymentMethod: 14,
          createdAt: latest,
          lines: [{ lineId: '6101', productId: '390238', isExclusiveOrder: 0 }],
        },
        { id: '5101', paymentMethod: 14, createdAt: earlier, lines: [] },
      ],
    };
    expect(source.selection).toEqual(selection);
    expect(source.sourceOrderCount).toBe('2');
    expect(source.sourceLineCount).toBe('1');
    const facts = {
      orderCount: '2',
      selectedOrderCount: '2',
      lineCount: '1',
      invalidRows: '0',
      duplicateIds: '0',
      latestTies: '1',
      selection,
    };
    const published = await publishMembershipGeneration(
      source,
      { read: async () => structuredClone(facts) },
      authority,
      { signal: new AbortController().signal, clock: () => source.capturedAt + 1 },
    );
    expect(published.publication.sourceCaptureHash).toBe(source.signature);
    expect(published.publication.warehouseSelectionHash).toBe(source.selectionHash);
    await expect(
      publishMembershipGeneration(
        source,
        { read: async () => ({ ...facts, lineCount: '0' }) },
        authority,
        { signal: new AbortController().signal, clock: () => source.capturedAt + 1 },
      ),
    ).rejects.toThrow();
  });
  it('advances native membership and coupon heads on the same original order mutation', async () => {
    const before = await capture();
    const [old] = await f.connection.query<mysql.RowDataPacket[]>(
      "SELECT revision FROM pos_rewrite_coupon_history_heads WHERE kind='customer' AND scope_id='77'",
    );
    await f.connection.query('UPDATE orders SET payment_method=11 WHERE id=5102');
    const after = await capture();
    const [current] = await f.connection.query<mysql.RowDataPacket[]>(
      "SELECT revision FROM pos_rewrite_coupon_history_heads WHERE kind='customer' AND scope_id='77'",
    );
    expect(BigInt(after.head.revision)).toBeGreaterThan(BigInt(before.head.revision));
    expect(BigInt(current[0]!.revision)).toBeGreaterThan(BigInt(old[0]!.revision));
    expect(after.selectionHash).not.toBe(before.selectionHash);
  });
  it('refuses membership capture when any installed coupon writer is missing', async () => {
    const trigger = couponHistoryWriterDefinitions[0]!.name;
    const [rows] = await f.connection.query<mysql.RowDataPacket[]>(
      'SHOW CREATE TRIGGER ' + trigger,
    );
    const original = String(rows[0]!['SQL Original Statement']);
    await f.connection.query('DROP TRIGGER ' + trigger);
    try {
      await expect(capture()).rejects.toThrow();
    } finally {
      await f.connection.query(original);
    }
    await expect(capture()).resolves.toHaveProperty('signature');
  });
});
