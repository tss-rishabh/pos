/** Disposable cross-language component proof, never an upstream app bootstrap. */
import assert from 'node:assert/strict';
import { readNativeMembershipAccount } from '../checkout/native-membership-account.js';
import mysql, { type RowDataPacket } from 'mysql2/promise';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { readConfig } from '../../src/config.js';
import { createDatabases } from '../../src/db/pools.js';
import {
  importFinancialStateSchema,
  sourceOrderReceiptSchema,
} from '../../src/modules/legacy-order-imports/financial-adapter-contracts.js';
import {
  csvMembershipReceiptSchema,
  csvMemberStateSchema,
  csvMembershipContract,
} from '../../src/modules/legacy-order-imports/membership-profile/domain.js';
import { assertCsvMembershipProfile } from '../../src/modules/legacy-order-imports/membership-profile/native.js';
import {
  applyCancellationMembership,
  cancellationMembershipHashSql,
  lockCancellationMembership,
} from '../../src/modules/checkout/cancellations/membership.js';
import {
  cancellationBenefitPolicy,
  cancellationMembershipContract,
} from '../../src/modules/checkout/cancellations/benefit-contracts.js';
import type { LegacyOrderImportPlan } from '../../src/modules/legacy-order-imports/plans.js';

const raw = process.env.MEMBERSHIP_NATIVE_NODE_URL ?? '',
  url = new URL(raw);
if (
  url.protocol !== 'mysql:' ||
  url.hostname !== '127.0.0.1' ||
  url.pathname !== '/pos_checkout_contract_test' ||
  !url.port ||
  url.password ||
  url.search ||
  url.hash
)
  throw new Error('Only the disposable CSV membership bridge is permitted.');
const connection = await mysql.createConnection({
  host: url.hostname,
  port: Number(url.port),
  user: 'root',
  database: 'pos_checkout_contract_test',
  dateStrings: true,
  supportBigNumbers: true,
  bigNumberStrings: true,
});
const nativeAccount = readNativeMembershipAccount(raw);
Object.assign(process.env, nativeAccount.environment);
const db = createDatabases(
  readConfig({
    NODE_ENV: 'test',
    SESSION_SECRET: 'isolated-membership-native-bridge-session-secret',
    MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
    MYSQL_WRITER_URL: nativeAccount.applicationUrl,
    MYSQL_PRIMARY_READER_URL: nativeAccount.applicationUrl,
  }),
);
const parse = (value: unknown): unknown => (typeof value === 'string' ? JSON.parse(value) : value);
try {
  const [stored] = await connection.query<RowDataPacket[]>(
    "SELECT proof FROM pos_rewrite_import_financial_source_receipts WHERE kind='membership'",
  );
  const receipt = csvMembershipReceiptSchema.parse(parse(stored[0]?.proof));
  const [records] = await connection.query<RowDataPacket[]>(
    'SELECT state FROM pos_rewrite_import_financial_operations WHERE id=?',
    [receipt.operationId],
  );
  const initial = z
    .object({ scope: z.unknown(), authority: z.unknown() })
    .parse(parse(records[0]?.state));
  const kind = process.env.POS_CSV_MEMBERSHIP_KIND ?? '',
    free = kind.endsWith('auto-free') || kind.endsWith('auto-history'),
    freeValue = kind.endsWith('auto-history') ? '1999.00' : '2300.00',
    shopify = kind.startsWith('shopify');
  const common = {
    sequence: 1,
    firstRow: 2,
    reference: 'isolated-source-member-order',
    storeId: '1',
    email: 'fixture@example.test',
    createdAt: '2026-06-15 12:00:00',
    lines: [
      {
        productId: free ? '11' : '10',
        quantity: 1,
        unitPrice: free ? freeValue : '100.00',
        sourceRows: [2],
      },
    ],
    originalTenderAmount: free ? freeValue : '100.00',
  };
  const plan: LegacyOrderImportPlan = shopify
    ? {
        ...common,
        kind: 'shopify',
        payment: 'shopify',
        currency: 'INR',
        address: { shipping_name: 'Fixture' },
        legacyTaxDigit: 1,
        shippingCharges: '0.00',
        discountAmount: '0.00',
        financialStatus: 'paid',
        declaredSubtotal: common.originalTenderAmount,
        declaredTaxes: '0.00',
        declaredTotal: common.originalTenderAmount,
      }
    : {
        ...common,
        kind: 'offline',
        payment: 'cash',
        sendOrderPlacedSms: false,
        message: 'isolated source settlement',
      };
  const state = importFinancialStateSchema.parse({
    ...initial,
    planHash: receipt.planHash,
    requestHash: receipt.requestHash,
    namespace: receipt.namespace,
    status: 'running',
    stage: 'confirmation',
    orderId: receipt.orderId,
    errorCode: null,
    requestId: 'isolated-membership-bridge',
    createdAt: 1781505000000,
    updatedAt: 1781505000000,
  });
  const [lineRows] = await connection.query<RowDataPacket[]>(
    "SELECT CAST(id AS CHAR) AS id,CAST(prod_id AS CHAR) AS productId,qty AS quantity,LOWER(SHA2(CAST(JSON_OBJECT('has_product_id',has_products.id,'product_id',has_products.prod_id,'quantity',has_products.qty,'price',has_products.price) AS CHAR CHARACTER SET utf8mb4),256)) AS inputHash FROM has_products WHERE order_id=5001 ORDER BY id",
  );
  const order = sourceOrderReceiptSchema.parse({
    contract: 'pos-legacy-order-import-source-v1',
    operationId: receipt.operationId,
    requestHash: receipt.requestHash,
    namespace: receipt.namespace,
    customerId: '77',
    storeId: '1',
    counterId: '3',
    createdAt: plan.createdAt,
    orderId: receipt.orderId,
    headerHash: receipt.headerHash,
    lineHash: receipt.lineHash,
    method: receipt.method,
    payable: plan.originalTenderAmount,
    refundAllocationContract: 'pos-refund-per-hp-v1',
    refundSourcePatchHash: 'e156c0c281cf5d846b6ae88cd7824959babe2069ed409ca9dff31b7882945f11',
    sourceCommit: receipt.sourceCommit,
    sourceControllerHash: 'd8b922d8ddaa5ed4743b51b113bbae344e3853a4f49054f18bb9b1cd8597da18',
    lineItemsEnabled: false,
    lines: lineRows.map((row) => ({ ...row, quantity: Number(row.quantity) })),
    effectsHash: 'd'.repeat(64),
  });
  const options = {
    contract: csvMembershipContract,
    sourceProofKey: z.string().min(32).parse(process.env.POS_LEGACY_IMPORT_PROOF_KEY),
    membershipProofKey: z.string().min(32).parse(process.env.POS_MEMBERSHIP_PROOF_KEY),
    freshReaderContract: 'pos-membership-fresh-reader-v1',
    productIds: ['10'],
    freeProductId: '10',
  };
  const phase = process.argv[2] === 'activated' ? 'settled' : 'staged';
  const rejected = process.argv[2] === 'reject-stale';
  if (rejected)
    await assert.rejects(
      db
        .get('writer')
        .transaction((tx) =>
          assertCsvMembershipProfile(tx, { state, plan, order, phase }, options),
        ),
    );
  else
    await db.get('writer').transaction(async (tx) => {
      const result = await assertCsvMembershipProfile(tx, { state, plan, order, phase }, options);
      assert.equal(result?.receipt.kind, receipt.kind);
      assert.equal(result?.expectedQuantities.size, free ? 2 : 1);
    });
  if (phase === 'settled' && !shopify) {
    const profile = {
      policy: cancellationBenefitPolicy,
      walletWriterContract: 'pos-wallet-user-lock-v1',
      voucherWriterContract: 'pos-voucher-user-lock-v1',
      membershipWriterContract: cancellationMembershipContract,
      membershipCacheContract: 'pos-membership-fresh-reader-v1',
      membershipProofKey: options.membershipProofKey,
    } as const;
    const scope = {
      orderId: '5001',
      customerId: '77',
      voucherId: '0',
      headerHash: receipt.provenance.headerHash,
      money: 0,
      points: 0,
      voucher: 0,
      membership: true,
      lines: [],
      timestamp: '2026-11-17 12:00:00',
    };
    const current = async () => {
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT attribute,value,is_active AS active,DATE_FORMAT(TIMESTAMPADD(SECOND,UNIX_TIMESTAMP(created_at),'1970-01-01 00:00:00'),'%Y-%m-%d %H:%i:%s') AS createdAt,DATE_FORMAT(TIMESTAMPADD(SECOND,UNIX_TIMESTAMP(updated_at),'1970-01-01 00:00:00'),'%Y-%m-%d %H:%i:%s') AS updatedAt,${cancellationMembershipHashSql} AS hash FROM user_eav WHERE entity='fixture@example.test' AND attribute IN ('EXCLUSIVE_MEMBER','EXCLUSIVE_EXPIRY') ORDER BY attribute`,
      );
      return z.array(csvMemberStateSchema).parse(rows);
    };
    const staged = await current(),
      marker = new Error('isolated late cancellation rollback');
    await assert.rejects(
      db.get('writer').transaction(async (tx) => {
        const proof = await lockCancellationMembership(tx, scope, profile);
        await applyCancellationMembership(tx, proof);
        throw marker;
      }),
      (error) => error === marker,
    );
    assert.deepEqual(await current(), staged);
    await db.get('writer').transaction(async (tx) => {
      await tx.execute(sql`SET time_zone='+05:30'`);
      const proof = await lockCancellationMembership(tx, scope, profile);
      await applyCancellationMembership(tx, proof);
    });
    assert.deepEqual(await current(), receipt.provenance.before);
    await assert.rejects(
      db.get('writer').transaction((tx) => lockCancellationMembership(tx, scope, profile)),
    );
    console.log(
      'Node verified CSV source→Go activation; exact prior entitlement/expiry/timestamps restored once, including late rollback.',
    );
  } else if (rejected)
    console.log(
      'Node rejected changed-and-restored external writer revision; original source descriptor retained.',
    );
  else
    console.log(
      'Node verified original private CSV staging descriptor +native membership revision/EAV; no payment invented.',
    );
} finally {
  await db.close();
  await connection.end();
}
