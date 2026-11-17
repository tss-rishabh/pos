import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { HasProduct, MUser, Order } from '../../../db/legacy-schema.js';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import { checkoutHeaderHashSql } from '../../checkout/projection.js';
import { cancellationMembershipHashSql } from '../../checkout/cancellations/membership.js';
import { assertNativeMembershipFence } from '../../checkout/cancellations/membership-fence.js';
import {
  cancellationMembershipProvenance,
  cancellationMembershipVersions,
  cancellationMembershipRows,
} from '../../checkout/cancellations/benefit-schema.js';
import { financialImportSourceReceipts } from '../financial-adapter-schema.js';
import { operationHash } from '../../checkout/crypto.js';
import type { ImportFinancialState, SourceOrderReceipt } from '../financial-adapter-contracts.js';
import type { LegacyOrderImportPlan } from '../plans.js';
import {
  activatedMembershipContract,
  csvMembershipContract,
  csvMembershipError,
  csvMembershipProvenanceSchema,
  membershipProvenanceHash,
  stagedMembershipContract,
  verifyCsvMembershipDescriptor,
} from './domain.js';

export interface CsvMembershipOptions {
  contract: string;
  sourceProofKey: string;
  membershipProofKey: string;
  freshReaderContract: string;
  productIds: readonly string[];
  freeProductId: string;
}
/** Invoke inside the caller's writer transaction, before original confirmation/settlement.
 * New work checks the current revision. Historical completed reads keep the
 * immutable sealed import proof and must not re-run current entitlement checks.
 */
export async function assertCsvMembershipProfile(
  tx: AdministrationTransaction,
  input: {
    state: ImportFinancialState;
    plan: LegacyOrderImportPlan;
    order: SourceOrderReceipt;
    phase: 'staged' | 'settled';
  },
  options: CsvMembershipOptions,
) {
  const { state, plan, order } = input;
  const [sealed] = await tx
    .select()
    .from(financialImportSourceReceipts)
    .where(
      and(
        eq(financialImportSourceReceipts.operationId, state.scope.operationId),
        eq(financialImportSourceReceipts.kind, 'membership'),
        sql`OCTET_LENGTH(${financialImportSourceReceipts.proof})<=262144`,
      ),
    )
    .limit(1)
    .for('share');
  const hasMember = order.lines.some((row) => options.productIds.includes(row.productId));
  if (!hasMember && !sealed) return null;
  if (
    !sealed ||
    sealed.status !== 'completed' ||
    sealed.requestHash !== state.requestHash ||
    options.contract !== csvMembershipContract ||
    options.freshReaderContract !== 'pos-membership-fresh-reader-v1'
  )
    throw csvMembershipError();
  const result = verifyCsvMembershipDescriptor({
    state,
    plan,
    order,
    value: sealed.proof,
    seal: sealed.proofHash,
    ...options,
  });
  const [header] = await tx
    .select({ hash: sql<string>`${sql.raw(checkoutHeaderHashSql)}`, customerId: Order.user })
    .from(Order)
    .where(eq(Order.id, BigInt(order.orderId)))
    .limit(1)
    .for('update');
  if (!header || String(header.customerId) !== order.customerId) throw csvMembershipError();
  const [customer] = await tx
    .select({
      email: MUser.email,
      active: MUser.status,
      blocked: MUser.is_block,
      disabled: MUser.is_disabled,
    })
    .from(MUser)
    .where(eq(MUser.id, header.customerId))
    .limit(1)
    .for('update');
  if (
    !customer?.email ||
    customer.active !== 1 ||
    (customer.blocked ?? 0) !== 0 ||
    (customer.disabled ?? 0) !== 0
  )
    throw csvMembershipError();
  const duplicates = await tx
    .select({ id: MUser.id })
    .from(MUser)
    .where(eq(MUser.email, customer.email))
    .orderBy(asc(MUser.id))
    .limit(2)
    .for('share');
  if (duplicates.length !== 1 || duplicates[0]!.id !== header.customerId)
    throw csvMembershipError();
  await assertNativeMembershipFence(tx);
  const [current] = await tx
    .select()
    .from(cancellationMembershipProvenance)
    .where(eq(cancellationMembershipProvenance.orderId, BigInt(order.orderId)))
    .limit(1)
    .for('update');
  const [version] = await tx
    .select()
    .from(cancellationMembershipVersions)
    .where(eq(cancellationMembershipVersions.customerId, header.customerId))
    .limit(1)
    .for('update');
  if (!current || !version) throw csvMembershipError();
  const parsed = csvMembershipProvenanceSchema.safeParse({
    ...current,
    orderId: String(current.orderId),
    customerId: String(current.customerId),
    revision: String(current.revision),
  });
  if (!parsed.success) throw csvMembershipError();
  const member = parsed.data,
    staged = result.receipt.provenance;
  if (
    member.proofHash !== membershipProvenanceHash(member, options.membershipProofKey) ||
    member.revision !== String(version.revision) ||
    member.orderId !== staged.orderId ||
    member.customerId !== staged.customerId ||
    member.headerHash !== header.hash ||
    member.headerHash !== staged.headerHash ||
    member.operationId !== staged.operationId ||
    member.createdAt !== staged.createdAt ||
    member.entityDigest !== staged.entityDigest ||
    member.entityDigest !==
      operationHash(
        'pending-cancellation.membership-entity.v1',
        customer.email,
        options.membershipProofKey,
      ) ||
    JSON.stringify(member.before) !== JSON.stringify(staged.before) ||
    member.contract !==
      (input.phase === 'staged' || plan.kind === 'shopify'
        ? stagedMembershipContract
        : activatedMembershipContract) ||
    (member.contract === stagedMembershipContract && member.proofHash !== staged.proofHash)
  )
    throw csvMembershipError();
  const rows = await tx
    .select({
      attribute: cancellationMembershipRows.attribute,
      value: cancellationMembershipRows.value,
      active: cancellationMembershipRows.active,
      createdAt: sql<string>`DATE_FORMAT(TIMESTAMPADD(SECOND,UNIX_TIMESTAMP(${cancellationMembershipRows.createdAt}),'1970-01-01 00:00:00'),'%Y-%m-%d %H:%i:%s')`,
      updatedAt: sql<string>`DATE_FORMAT(TIMESTAMPADD(SECOND,UNIX_TIMESTAMP(${cancellationMembershipRows.updatedAt}),'1970-01-01 00:00:00'),'%Y-%m-%d %H:%i:%s')`,
      hash: sql<string>`${sql.raw(cancellationMembershipHashSql)}`,
    })
    .from(cancellationMembershipRows)
    .where(
      and(
        eq(cancellationMembershipRows.entity, customer.email),
        inArray(cancellationMembershipRows.attribute, ['EXCLUSIVE_EXPIRY', 'EXCLUSIVE_MEMBER']),
      ),
    )
    .orderBy(asc(cancellationMembershipRows.attribute))
    .limit(3)
    .for('update');
  if (JSON.stringify(rows) !== JSON.stringify(member.confirmed)) throw csvMembershipError();
  for (const extra of result.receipt.additionalLines) {
    const [line] = await tx
      .select({
        price: HasProduct.price,
        quantity: HasProduct.qty,
        product: HasProduct.product,
        order: HasProduct.order,
      })
      .from(HasProduct)
      .where(eq(HasProduct.id, BigInt(extra.id)))
      .limit(1)
      .for('update');
    if (
      !line ||
      line.price !== 0 ||
      line.quantity !== 1n ||
      String(line.product) !== extra.productId ||
      String(line.order) !== order.orderId
    )
      throw csvMembershipError();
  }
  return result;
}
