import assert from 'node:assert/strict';
import mysql, { type RowDataPacket } from 'mysql2/promise';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { readConfig } from '../../src/config.js';
import { createDatabases } from '../../src/db/pools.js';
import { checkoutHeaderHashSql } from '../../src/modules/checkout/projection.js';
import {
  applyCancellationMembership,
  cancellationMembershipHashSql,
  lockCancellationMembership,
} from '../../src/modules/checkout/cancellations/membership.js';
import {
  cancellationBenefitPolicy,
  cancellationMembershipContract,
  type CancellationBenefitScope,
} from '../../src/modules/checkout/cancellations/benefit-contracts.js';

const raw = process.env.MEMBERSHIP_NATIVE_NODE_URL ?? '';
const url = new URL(raw);
if (
  url.protocol !== 'mysql:' ||
  url.hostname !== '127.0.0.1' ||
  url.pathname !== '/pos_checkout_contract_test' ||
  !url.port ||
  url.search ||
  url.hash ||
  url.password
)
  throw new Error('Only the disposable membership bridge is permitted.');
const connection = await mysql.createConnection({
  host: url.hostname,
  port: Number(url.port),
  user: 'root',
  database: 'pos_checkout_contract_test',
  dateStrings: true,
  supportBigNumbers: true,
  bigNumberStrings: true,
});
const db = createDatabases(
  readConfig({
    NODE_ENV: 'test',
    SESSION_SECRET: 'isolated-membership-native-bridge-session-secret',
    MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
    MYSQL_WRITER_URL: raw,
    MYSQL_PRIMARY_READER_URL: raw,
  }),
);
const profile = {
  policy: cancellationBenefitPolicy,
  walletWriterContract: 'pos-wallet-user-lock-v1',
  voucherWriterContract: 'pos-voucher-user-lock-v1',
  membershipWriterContract: cancellationMembershipContract,
  membershipCacheContract: 'pos-membership-fresh-reader-v1',
  membershipProofKey: z.string().min(32).parse(process.env.POS_MEMBERSHIP_PROOF_KEY),
} as const;
async function scope(): Promise<CancellationBenefitScope> {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT ${checkoutHeaderHashSql} AS hash FROM orders WHERE id=5001`,
  );
  return {
    orderId: '5001',
    customerId: '77',
    voucherId: '0',
    headerHash: z.string().parse(rows[0]?.hash),
    money: 0,
    points: 0,
    voucher: 0,
    membership: true,
    lines: [],
    timestamp: '2026-11-17 12:00:00',
  };
}
const stateSchema = z.array(
  z
    .object({
      attribute: z.string(),
      value: z.string().nullable(),
      active: z.number().nullable(),
      createdAt: z.string(),
      updatedAt: z.string(),
      hash: z.string(),
    })
    .strict(),
);
async function current() {
  const [rows] = await connection.query<
    RowDataPacket[]
  >(`SELECT attribute,value,is_active AS active,
    DATE_FORMAT(TIMESTAMPADD(SECOND,UNIX_TIMESTAMP(created_at),'1970-01-01 00:00:00'),'%Y-%m-%d %H:%i:%s') AS createdAt,
    DATE_FORMAT(TIMESTAMPADD(SECOND,UNIX_TIMESTAMP(updated_at),'1970-01-01 00:00:00'),'%Y-%m-%d %H:%i:%s') AS updatedAt,
    ${cancellationMembershipHashSql} AS hash FROM user_eav WHERE entity='fixture@example.test' AND attribute IN ('EXCLUSIVE_MEMBER','EXCLUSIVE_EXPIRY') ORDER BY attribute`);
  return stateSchema.parse(rows);
}
try {
  const input = await scope();
  const mode = process.argv[2];
  if (mode === 'check-staged') {
    await db.get('writer').transaction(async (tx) => {
      const plan = await lockCancellationMembership(tx, input, profile);
      assert.equal(
        plan.outcome,
        process.env.POS_MEMBERSHIP_BRIDGE_KIND === 'upgrade'
          ? 'prior-entitlement-restored'
          : 'deactivated',
      );
    });
    console.log('Node verified actual Python staged proof and native EAV hashes.');
  } else if (mode === 'restore') {
    const [rows] = await connection.query<RowDataPacket[]>(
      'SELECT before_state AS value FROM pos_rewrite_cancellation_membership_provenance WHERE order_id=5001',
    );
    const before = stateSchema.parse(
      typeof rows[0]?.value === 'string' ? JSON.parse(rows[0].value) : rows[0]?.value,
    );
    const staged = await current();
    const marker = new Error('fixture late cancellation failure');
    await assert.rejects(
      db.get('writer').transaction(async (tx) => {
        await tx.execute(sql`SET time_zone='+05:30'`);
        const plan = await lockCancellationMembership(tx, input, profile);
        await applyCancellationMembership(tx, plan);
        throw marker;
      }),
      (error) => error === marker,
    );
    assert.deepEqual(await current(), staged);
    await db.get('writer').transaction(async (tx) => {
      await tx.execute(sql`SET time_zone='+05:30'`);
      const plan = await lockCancellationMembership(tx, input, profile);
      await applyCancellationMembership(tx, plan);
    });
    assert.deepEqual(await current(), before);
    await assert.rejects(
      db.get('writer').transaction((tx) => lockCancellationMembership(tx, input, profile)),
    );
    console.log(
      'Node restored exact original membership/expiry/timestamp across SQL time zones; late rollback and consumed-proof refusal passed.',
    );
  } else if (mode === 'reject-stale') {
    await assert.rejects(
      db.get('writer').transaction((tx) => lockCancellationMembership(tx, input, profile)),
    );
    console.log('Node refused changed-and-restored external membership/email revisions.');
  } else throw new Error('Unknown native membership bridge mode.');
} finally {
  await db.close();
  await connection.end();
}
