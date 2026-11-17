import { readFileSync } from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { splitMigration } from '../../src/db/migrations.js';
import { operationHash } from '../../src/modules/checkout/crypto.js';
import { checkoutHeaderHashSql } from '../../src/modules/checkout/projection.js';
import { cancellationMembershipHashSql } from '../../src/modules/checkout/cancellations/membership.js';
import {
  cancellationMembershipProvenance,
  cancellationMembershipVersions,
} from '../../src/modules/checkout/cancellations/benefit-schema.js';
import { financialImportSourceReceipts } from '../../src/modules/legacy-order-imports/financial-adapter-schema.js';
import { legacyImportFinancialJournal } from '../../src/modules/legacy-order-imports/financial-adapter-journal.js';
import { nativeImportOrder } from '../../src/modules/legacy-order-imports/financial-adapter-proof.js';
import { sourceOrderReceiptSchema } from '../../src/modules/legacy-order-imports/financial-adapter-contracts.js';
import { csvMembershipImportProfile } from '../../src/modules/legacy-order-imports/membership-profile/adapter.js';
import { validateCsvMembershipCompletionSnapshot } from '../../src/modules/legacy-order-imports/membership-profile/completion.js';
import {
  activatedMembershipContract,
  csvMemberStateSchema,
  csvMembershipReceiptHash,
  membershipProvenanceHash,
  type CsvMembershipProvenance,
} from '../../src/modules/legacy-order-imports/membership-profile/domain.js';
import { importFinancialFixture } from '../legacy-import-financial/fixture.js';
import { adapterOptions, memberEvidence } from './adapter-fixtures.js';

const template = process.env.CHECKOUT_MYSQL_TEST_URL;
describe.skipIf(!template)('server-installed membership adapter on isolated native writer', () => {
  let f: Awaited<ReturnType<typeof importFinancialFixture>>;
  beforeAll(async () => {
    f = await importFinancialFixture(template!);
    for (const path of [
      'src/modules/checkout/cancellations/benefit-migration.sql',
      'src/modules/checkout/cancellations/membership-producer-migration.sql',
    ])
      for (const statement of splitMigration(readFileSync(path, 'utf8')))
        await f.connection.query(statement);
    await f.connection.query('CREATE INDEX fixture_users_email ON users(email)');
    for (const statement of readFileSync(
      'compatibility/upstream/pending-cancellation/membership-fence.sql',
      'utf8',
    )
      .replace(/^DELIMITER.*$/gm, '')
      .split('$$')
      .map((value) => value.trim())
      .filter(Boolean))
      await f.connection.query(statement);
  }, 30000);
  afterAll(async () => {
    await f?.close();
  });
  beforeEach(async () => {
    await f.reset();
    await f.connection.query('DELETE FROM pos_rewrite_cancellation_membership_provenance');
    await f.connection.query('DELETE FROM pos_rewrite_membership_versions');
  });
  async function memberRows() {
    const [rows] = await f.db.get('writer').execute(sql`
      SELECT attribute,value,is_active AS active,
       DATE_FORMAT(TIMESTAMPADD(SECOND,UNIX_TIMESTAMP(created_at),'1970-01-01 00:00:00'),'%Y-%m-%d %H:%i:%s') AS createdAt,
       DATE_FORMAT(TIMESTAMPADD(SECOND,UNIX_TIMESTAMP(updated_at),'1970-01-01 00:00:00'),'%Y-%m-%d %H:%i:%s') AS updatedAt,
       ${sql.raw(cancellationMembershipHashSql)} AS hash
      FROM user_eav WHERE entity='private-import@example.test' ORDER BY attribute`);
    return z.array(csvMemberStateSchema).parse(rows);
  }
  async function prepare(kind: 'offline' | 'shopify' = 'offline', free = false) {
    const evidence = memberEvidence(kind, free),
      j = legacyImportFinancialJournal(f.config, f.db, f.options),
      reserved = await j.reserve(f.input(evidence.plan));
    evidence.state = { ...reserved.state, orderId: '5001', stage: 'confirmation' };
    evidence.plan = reserved.plan;
    await f.fixture.insert('orders', {
      id: '5001',
      user_id: '77',
      payment_method: kind === 'offline' ? 14 : 15,
      payment_status: kind === 'offline' ? 0 : 1,
      order_status: kind === 'offline' ? 0 : 1,
      created_at: evidence.plan.createdAt,
      updated_at: evidence.plan.createdAt,
      pay_amt: Number(evidence.plan.originalTenderAmount),
      order_amt: Number(evidence.plan.originalTenderAmount),
      cashback_used: 0,
      tss_money_used: 0,
      tss_points_used: 0,
      voucher_used: 0,
      voucher_amt_used: 0,
      coupon_used: 0,
      coupon_amt_used: 0,
      parent_order_id: 0,
      original_order_id: 0,
      hl_parent_order_id: 0,
      location_id: 0,
      order_ref_no: 'MEMBER-FIXTURE',
    });
    await f.fixture.insert('order_stores', {
      id: '1',
      order_id: '5001',
      store_id: '1',
      counter_id: '2',
    });
    for (const line of evidence.order.lines)
      await f.fixture.insert('has_products', {
        id: line.id,
        order_id: '5001',
        prod_id: line.productId,
        sub_prod_id: 0,
        qty: 1,
        price: free && line.productId === '12' ? 0 : Number(evidence.plan.originalTenderAmount),
        amount_to_be_refunded:
          free && line.productId === '12' ? 0 : Number(evidence.plan.originalTenderAmount),
        status: 'INCOMPLETE',
        created_at: evidence.plan.createdAt,
        updated_at: evidence.plan.createdAt,
      });
    const native = await f.db.get('writer').transaction((tx) => nativeImportOrder(tx, '5001'));
    evidence.order = sourceOrderReceiptSchema.parse({
      ...evidence.order,
      operationId: evidence.state.scope.operationId,
      requestHash: evidence.state.requestHash,
      namespace: evidence.state.namespace,
      headerHash: native.header.headerHash,
      lineHash: native.lineHash,
      lines: native.lines,
    });
    for (const row of evidence.snapshot.receipt.provenance.confirmed)
      await f.fixture.insert('user_eav', {
        entity: evidence.plan.email,
        attribute: row.attribute,
        value: row.value,
        is_active: 0,
        created_at: evidence.plan.createdAt,
        updated_at: evidence.plan.createdAt,
      });
    const [revision] = await f.db.get('writer').select().from(cancellationMembershipVersions),
      [header] = await f.db
        .get('writer')
        .execute(sql`SELECT ${sql.raw(checkoutHeaderHashSql)} AS hash FROM orders WHERE id=5001`),
      headerHash = z.array(z.object({ hash: z.string() })).parse(header)[0]!.hash,
      member = evidence.order.lines.find((line) =>
        adapterOptions.productIds.includes(line.productId),
      )!;
    const receipt = evidence.snapshot.receipt;
    Object.assign(receipt, {
      operationId: evidence.state.scope.operationId,
      requestHash: evidence.state.requestHash,
      planHash: evidence.state.planHash,
      namespace: evidence.state.namespace,
      authorityHash: operationHash(
        'legacy-order-imports.source.membership-authority.v1',
        evidence.state.authority,
        adapterOptions.sourceProofKey,
      ),
      headerHash: evidence.order.headerHash,
      lineHash: evidence.order.lineHash,
      memberLines: [{ ...member, quantity: 1 }],
      additionalLines: free ? [{ ...member, quantity: 1 }] : [],
    });
    Object.assign(receipt.provenance, {
      revision: String(revision!.revision),
      headerHash,
      confirmed: await memberRows(),
    });
    receipt.provenance.proofHash = membershipProvenanceHash(
      receipt.provenance,
      adapterOptions.membershipProofKey,
    );
    evidence.snapshot.sourceReceiptHash = csvMembershipReceiptHash(
      receipt,
      adapterOptions.sourceProofKey,
    );
    await f.db
      .get('writer')
      .insert(cancellationMembershipProvenance)
      .values({
        ...receipt.provenance,
        orderId: 5001n,
        customerId: 77n,
        revision: BigInt(receipt.provenance.revision),
      });
    await f.db
      .get('writer')
      .insert(financialImportSourceReceipts)
      .values({
        id: evidence.state.scope.operationId + ':membership',
        operationId: evidence.state.scope.operationId,
        kind: 'membership',
        requestHash: evidence.state.requestHash,
        status: 'completed',
        proof: receipt,
        proofHash: evidence.snapshot.sourceReceiptHash,
        createdAt: evidence.state.createdAt,
      });
    return evidence;
  }
  async function activate(evidence: Awaited<ReturnType<typeof prepare>>) {
    await f.connection.query(
      "UPDATE user_eav SET is_active=1 WHERE entity='private-import@example.test'",
    );
    const [version] = await f.db.get('writer').select().from(cancellationMembershipVersions);
    const provenance: CsvMembershipProvenance = {
      ...evidence.snapshot.receipt.provenance,
      contract: activatedMembershipContract,
      revision: String(version!.revision),
      confirmed: await memberRows(),
    };
    provenance.proofHash = membershipProvenanceHash(provenance, adapterOptions.membershipProofKey);
    await f.db
      .get('writer')
      .update(cancellationMembershipProvenance)
      .set({
        contract: provenance.contract,
        confirmed: provenance.confirmed,
        revision: BigInt(provenance.revision),
        proofHash: provenance.proofHash,
      })
      .where(eq(cancellationMembershipProvenance.orderId, 5001n));
  }
  function execute(
    evidence: Awaited<ReturnType<typeof prepare>>,
    phase: 'staged' | 'settled',
    options = adapterOptions,
  ) {
    const profile = csvMembershipImportProfile(options);
    return f.db.get('writer').transaction(async (tx) => {
      await profile.lock!(tx, evidence);
      await profile.sourceReceipt!(tx, evidence, evidence.order);
      return profile.expectedQuantities!(tx, evidence, evidence.order, phase);
    });
  }
  it.each([false, true])(
    'validates actual staged membership and explicit free manifest (free=%s)',
    async (free) => {
      const e = await prepare('offline', free),
        before = structuredClone(e.plan);
      expect(await execute(e, 'staged')).toEqual(
        new Map(
          free
            ? [
                ['11', 1],
                ['12', 1],
              ]
            : [['10', 1]],
        ),
      );
      expect(e.plan).toEqual(before);
      await expect(execute(e, 'settled')).rejects.toMatchObject({
        code: 'ORDER_IMPORT_MEMBERSHIP_PROOF_INVALID',
      });
      await activate(e);
      expect(await execute(e, 'settled')).toEqual(
        new Map(
          free
            ? [
                ['11', 1],
                ['12', 1],
              ]
            : [['10', 1]],
        ),
      );
      await expect(execute(e, 'staged')).rejects.toMatchObject({
        code: 'ORDER_IMPORT_MEMBERSHIP_PROOF_INVALID',
      });
    },
  );
  it('keeps Shopify STAGED and preserves the original stock plan.lines after an explicit free addition', async () => {
    const e = await prepare('shopify', true),
      before = structuredClone(e.plan.lines);
    expect(await execute(e, 'settled')).toEqual(
      new Map([
        ['11', 1],
        ['12', 1],
      ]),
    );
    expect(e.plan.lines).toEqual(before);
    const profile = csvMembershipImportProfile(adapterOptions);
    const frozen = await f.db.get('writer').transaction(async (tx) => {
      await profile.lock!(tx, e);
      return profile.completionSnapshot(tx, e, e.order);
    });
    expect(frozen).toEqual(e.snapshot);
    await activate(e);
    await expect(execute(e, 'settled')).rejects.toThrow();
  });
  it('requires the early exact customer lock witness before invoking native Order/provenance checks', async () => {
    const e = await prepare(),
      profile = csvMembershipImportProfile(adapterOptions);
    await expect(
      f.db.get('writer').transaction((tx) => profile.expectedQuantities!(tx, e, e.order, 'staged')),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_MEMBERSHIP_LOCK_REQUIRED' });
    await f.connection.beginTransaction();
    await f.connection.query('SELECT id FROM orders WHERE id=5001 FOR UPDATE');
    try {
      // Early lock must complete while a foreign transaction holds Order.
      await f.db.get('writer').transaction((tx) => profile.lock!(tx, e));
    } finally {
      await f.connection.rollback();
    }
    expect(await execute(e, 'staged')).toEqual(new Map([['10', 1]]));
  }, 10000);
  it('waits for the customer before locking Order when a concurrent writer owns that customer', async () => {
    const e = await prepare(),
      profile = csvMembershipImportProfile(adapterOptions);
    await f.connection.beginTransaction();
    await f.connection.query('SELECT id FROM users WHERE id=77 FOR UPDATE');
    const work = f.db.get('writer').transaction(async (tx) => {
      await profile.lock!(tx, e);
      return profile.expectedQuantities!(tx, e, e.order, 'staged');
    });
    void work.catch(() => undefined);
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const [rows] = await f.connection.query(
          "SELECT COUNT(*) AS n FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID WHERE l.OBJECT_SCHEMA=? AND l.OBJECT_NAME='users'",
          [new URL(f.config.MYSQL_WRITER_URL!).pathname.slice(1)],
        );
        waiting =
          BigInt(z.array(z.object({ n: z.union([z.string(), z.number()]) })).parse(rows)[0]!.n) >
          0n;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      // This would fail if the checker had taken Order before waiting on us.
      await expect(
        f.connection.query('SELECT id FROM orders WHERE id=5001 FOR UPDATE NOWAIT'),
      ).resolves.toBeDefined();
    } finally {
      await f.connection.rollback();
      expect(await work).toEqual(new Map([['10', 1]]));
    }
  }, 10000);
  it('rejects altered free-line value and a changed-then-restored membership revision before effects', async () => {
    const e = await prepare('offline', true);
    await f.connection.query('UPDATE has_products SET price=1 WHERE prod_id=12');
    await expect(execute(e, 'staged')).rejects.toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_PROOF_INVALID',
    });
    await f.connection.query('UPDATE has_products SET price=0 WHERE prod_id=12');
    await f.connection.query(
      "UPDATE user_eav SET value='changed' WHERE attribute='EXCLUSIVE_MEMBER'",
    );
    await f.connection.query("UPDATE user_eav SET value='1' WHERE attribute='EXCLUSIVE_MEMBER'");
    await expect(execute(e, 'staged')).rejects.toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_PROOF_INVALID',
    });
  });
  it.each([
    'disabled',
    'malformed',
    'oversized',
    'wrong-id',
    'request-hash',
    'disabled-malformed',
    'disabled-oversized',
  ] as const)(
    'refuses existing %s descriptor instead of treating it as a nonmember',
    async (changed) => {
      const e = await prepare(),
        profile = csvMembershipImportProfile({
          ...adapterOptions,
          ...(changed.startsWith('disabled')
            ? { contract: '', productIds: [], freeProductId: '' }
            : {}),
        });
      if (changed.endsWith('malformed') || changed.endsWith('oversized'))
        await f.connection.query(
          "UPDATE pos_rewrite_import_financial_source_receipts SET proof=? WHERE kind='membership'",
          [
            JSON.stringify({
              invalid: changed.endsWith('oversized') ? 'x'.repeat(262145) : 'invalid',
            }),
          ],
        );
      if (changed === 'wrong-id')
        await f.connection.query(
          "UPDATE pos_rewrite_import_financial_source_receipts SET id=CONCAT(id,'-bad')",
        );
      if (changed === 'request-hash')
        await f.connection.query(
          "UPDATE pos_rewrite_import_financial_source_receipts SET request_hash=REPEAT('f',64)",
        );
      await expect(
        f.db.get('writer').transaction((tx) => profile.lock!(tx, e)),
      ).rejects.toMatchObject({ code: 'ORDER_IMPORT_MEMBERSHIP_PROOF_INVALID' });
    },
  );
  it('does not hide a descriptor committed after an earlier RR snapshot when contracts are disabled', async () => {
    const e = await prepare(),
      profile = csvMembershipImportProfile({
        ...adapterOptions,
        contract: '',
        productIds: [],
        freeProductId: '',
      });
    await f.connection.query(
      "DELETE FROM pos_rewrite_import_financial_source_receipts WHERE kind='membership'",
    );
    await f.db.get('writer').transaction(async (tx) => {
      await tx.select().from(financialImportSourceReceipts);
      await f.db
        .get('writer')
        .insert(financialImportSourceReceipts)
        .values({
          id: e.state.scope.operationId + ':membership',
          operationId: e.state.scope.operationId,
          kind: 'membership',
          requestHash: e.state.requestHash,
          status: 'completed',
          proof: {},
          proofHash: '0'.repeat(64),
          createdAt: e.state.createdAt,
        });
      await expect(profile.lock!(tx, e)).rejects.toMatchObject({
        code: 'ORDER_IMPORT_MEMBERSHIP_PROOF_INVALID',
      });
    });
  });
  it('preserves completed evidence after current contact, entitlement, key and flag changes', async () => {
    const e = await prepare();
    await activate(e);
    const profile = csvMembershipImportProfile(adapterOptions),
      frozen = await f.db.get('writer').transaction(async (tx) => {
        await profile.lock!(tx, e);
        return profile.completionSnapshot(tx, e, e.order);
      });
    expect(frozen).toEqual(e.snapshot);
    await f.connection.query(
      "UPDATE users SET email='changed@example.test',is_block=1 WHERE id=77",
    );
    await f.connection.query("UPDATE user_eav SET value='changed',is_active=0");
    await f.connection.query(
      "UPDATE pos_rewrite_import_financial_source_receipts SET proof='{}',proof_hash=REPEAT('0',64)",
    );
    const disabled = csvMembershipImportProfile({
        ...adapterOptions,
        contract: '',
        sourceProofKey: '',
        membershipProofKey: '',
        productIds: [],
        freeProductId: '',
      }),
      completed = { ...e.state, kind: e.plan.kind, order: e.order };
    await f.db
      .get('writer')
      .transaction((tx) =>
        disabled.lock!(tx, { ...e, state: { ...e.state, status: 'completed' } }),
      );
    expect(validateCsvMembershipCompletionSnapshot(frozen, completed)).toEqual(e.snapshot);
    await expect(execute(e, 'settled')).rejects.toThrow();
  });
  it('does not permit an unrelated transaction or changed scope to reuse the early lock witness', async () => {
    const e = await prepare(),
      profile = csvMembershipImportProfile(adapterOptions);
    await f.db.get('writer').transaction((tx) => profile.lock!(tx, e));
    await expect(
      f.db.get('writer').transaction((tx) => profile.expectedQuantities!(tx, e, e.order, 'staged')),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_MEMBERSHIP_LOCK_REQUIRED' });
    await f.db.get('writer').transaction(async (tx) => {
      await profile.lock!(tx, e);
      await expect(
        profile.expectedQuantities!(
          tx,
          { ...e, state: { ...e.state, scope: { ...e.state.scope, counterId: '3' } } },
          e.order,
          'staged',
        ),
      ).rejects.toThrow();
    });
  });
  it('rolls back the caller transaction after a late profile failure and does not renew or alter the source descriptor', async () => {
    const e = await prepare(),
      profile = csvMembershipImportProfile(adapterOptions),
      marker = new Error('isolated adapter rollback');
    await expect(
      f.db.get('writer').transaction(async (tx) => {
        await profile.lock!(tx, e);
        await profile.expectedQuantities!(tx, e, e.order, 'staged');
        await tx
          .update(financialImportSourceReceipts)
          .set({ status: 'invalid' })
          .where(
            and(
              eq(financialImportSourceReceipts.operationId, e.state.scope.operationId),
              eq(financialImportSourceReceipts.kind, 'membership'),
            ),
          );
        throw marker;
      }),
    ).rejects.toBe(marker);
    expect(await execute(e, 'staged')).toEqual(new Map([['10', 1]]));
  });
  it('leaves ordinary plans available with optional contracts absent and never fabricates a member snapshot', async () => {
    const e = memberEvidence(),
      profile = csvMembershipImportProfile({
        ...adapterOptions,
        contract: '',
        sourceProofKey: '',
        membershipProofKey: '',
      });
    e.plan.lines[0]!.productId = '11';
    e.order.lines[0]!.productId = '11';
    profile.assertReady!(e.plan);
    await f.db.get('writer').transaction(async (tx) => {
      await profile.lock!(tx, e);
      expect(await profile.expectedQuantities!(tx, e, e.order, 'staged')).toBeNull();
      expect(await profile.completionSnapshot(tx, e, e.order)).toBeNull();
    });
  });
});
