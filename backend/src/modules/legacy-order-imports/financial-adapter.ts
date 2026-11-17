import { and, eq } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import { checkoutRepository } from '../checkout/repository.js';
import { assertCheckoutProjection } from '../checkout/projection.js';
import { assertCashOrderSchema } from '../checkout/offline-cash/writer.js';
import {
  importFinancialResultSchema,
  type ImportFinancialAdapter,
  type ImportFinancialResult,
  type ImportFinancialScope,
} from './financial-contracts.js';
import {
  financialImportContract,
  importCompletedProofSchema,
  importPublicationReceiptSchema,
  importSettlementReceiptSchema,
  sourceRejectionReceiptSchema,
  sourceConfirmationReceiptSchema,
  type ImportFinancialState,
  type SourceOrderReceipt,
  type ImportCompletedProof,
} from './financial-adapter-contracts.js';
import {
  financialImportOrderBindings,
  financialImportProofs,
  financialImportSourceReceipts,
  financialImportStages,
} from './financial-adapter-schema.js';
import {
  financialImportHash,
  financialSourceHash,
  equalImportHash,
  importFinancialError,
} from './financial-adapter-crypto.js';
import { legacyImportFinancialJournal } from './financial-adapter-journal.js';
import {
  readSourceOrderReceipt,
  verifiedImportCompletion,
  recoverImportCompletion,
} from './financial-adapter-proof.js';
import { assertNativeImportOrder, settleNativeImport } from './financial-adapter-writer.js';
import type { LegacyImportFinancialOptions } from './financial-adapter-options.js';
import {
  legacyImportFinancialTransport,
  type LegacyImportFinancialTransport,
  type FinancialSourceCommand,
} from './financial-adapter-transport.js';
import {
  financialAdapterProfiles,
  type FinancialImportProfiles,
  type FinancialImportProfileContext,
} from './financial-adapter-profiles.js';
import { verifiedNativeAdmissionRejection } from './financial-adapter-admission.js';
import { assertCsvMembershipPublication } from './membership-profile/completion.js';
import { financialOrderPreparation } from './financial-adapter-preparation.js';
import type { FinancialOrderPreparationPort } from './financial-adapter-preparation-contracts.js';
import { usesCurrentFinancialReads } from './screening-transactions.js';

class PreparationCurrentReadsRequired extends Error {}

/** Every remote stage is checkpointed once. GET never starts an unstarted stage. */
export function legacyOrderImportFinancialAdapter(
  config: Config,
  db: Databases,
  options: LegacyImportFinancialOptions,
  transport: LegacyImportFinancialTransport = legacyImportFinancialTransport(config, options),
  profiles: FinancialImportProfiles = financialAdapterProfiles(),
  orderPreparation?: FinancialOrderPreparationPort,
): ImportFinancialAdapter {
  const journal = legacyImportFinancialJournal(
      config,
      db,
      options,
      profiles,
      Boolean(orderPreparation),
    ),
    now = options.clock ?? Date.now,
    preparation = financialOrderPreparation(
      options,
      journal,
      profiles,
      async (tx) => {
        transport.assertReady();
        await assertCashOrderSchema(tx, options.orderSchemaContract);
      },
      orderPreparation,
    );
  function observe(result: ImportFinancialResult, state: ImportFinancialState) {
    try {
      options.observe?.({
        module: 'legacy-order-imports',
        resource: 'financial-imports',
        eventId:
          result.status === 'completed'
            ? 'legacy-order-imports.financial-imports.completed'
            : result.status === 'rejected'
              ? 'legacy-order-imports.financial-imports.rejected'
              : 'legacy-order-imports.financial-imports.uncertain',
        eventInstanceId: crypto.randomUUID(),
        requestId: state.requestId,
        userId: state.scope.actorId,
        stage:
          result.status === 'unknown'
            ? result.stage
            : result.status === 'completed'
              ? 'publication'
              : state.stage === 'preparation'
                ? 'preparation'
                : 'order',
      });
    } catch {
      /* Financial state is durable even if a logger fails. */
    }
    return result;
  }
  const unknown = (state: ImportFinancialState): ImportFinancialResult => ({
    status: 'unknown',
    operationId: state.scope.operationId,
    stage: state.stage,
    orderId: state.orderId,
  });
  const completed = (proof: ImportCompletedProof): ImportFinancialResult => ({
    status: 'completed',
    operationId: proof.scope.operationId,
    orderId: proof.order.orderId,
    receiptId: proof.receiptId,
    businessDate: proof.businessDate,
    projectionHash: financialImportHash(options.secret, 'completed', proof),
  });
  async function nativeSource(tx: AdministrationTransaction, state: ImportFinancialState) {
    const receipt = await readSourceOrderReceipt(
      tx,
      state.scope.operationId,
      options.sourceProofKey ?? '',
    );
    if (!receipt) throw importFinancialError('ORDER_IMPORT_ORDER_UNCONFIRMED');
    const loaded = await journal.load(tx, state.scope);
    if (!loaded) throw importFinancialError('ORDER_IMPORT_FINANCIAL_SCOPE_INVALID');
    await profiles.lock(tx, loaded);
    await profiles.sourceReceipt(tx, loaded, receipt);
    const expected = await profiles.expectedQuantities(tx, loaded, receipt, 'staged');
    await assertNativeImportOrder(tx, state, loaded.plan, receipt, expected);
    return receipt;
  }
  async function publication(
    tx: AdministrationTransaction,
    state: ImportFinancialState,
    order: SourceOrderReceipt,
  ) {
    const [row] = await tx
      .select()
      .from(financialImportSourceReceipts)
      .where(
        and(
          eq(financialImportSourceReceipts.operationId, state.scope.operationId),
          eq(financialImportSourceReceipts.kind, 'publication'),
          eq(financialImportSourceReceipts.status, 'completed'),
        ),
      )
      .limit(1)
      .for('share');
    if (!row) return null;
    const proof = importPublicationReceiptSchema.parse(row.proof),
      kinds = proof.jobs.map((job) => job.kind);
    if (
      proof.operationId !== state.scope.operationId ||
      proof.orderId !== order.orderId ||
      proof.requestHash !== state.requestHash ||
      proof.requestHash !== row.requestHash ||
      proof.sourceHash !== order.effectsHash ||
      !kinds.includes('kinesis-chain') ||
      !kinds.includes('engagement') ||
      new Set(proof.jobs.map((job) => job.id)).size !== proof.jobs.length ||
      !equalImportHash(
        row.proofHash,
        financialSourceHash(options.sourceProofKey ?? '', 'publication', proof),
      )
    )
      throw importFinancialError('ORDER_IMPORT_PUBLICATION_UNCONFIRMED');
    return proof;
  }
  async function confirmation(
    tx: AdministrationTransaction,
    state: ImportFinancialState,
    order: SourceOrderReceipt,
  ) {
    const [row] = await tx
      .select()
      .from(financialImportSourceReceipts)
      .where(
        and(
          eq(financialImportSourceReceipts.operationId, state.scope.operationId),
          eq(financialImportSourceReceipts.kind, 'confirmation'),
          eq(financialImportSourceReceipts.status, 'completed'),
        ),
      )
      .limit(1)
      .for('share');
    const [stage] = await tx
      .select()
      .from(financialImportStages)
      .where(
        and(
          eq(financialImportStages.operationId, state.scope.operationId),
          eq(financialImportStages.kind, 'confirmation'),
        ),
      )
      .limit(1)
      .for('share');
    if (!row || !stage) throw importFinancialError('ORDER_IMPORT_CONFIRMATION_UNCONFIRMED');
    const proof = sourceConfirmationReceiptSchema.parse(row.proof);
    if (
      proof.operationId !== state.scope.operationId ||
      proof.orderId !== order.orderId ||
      proof.requestHash !== state.requestHash ||
      proof.nonce !== stage.nonce ||
      proof.customerId !== state.authority.customerId ||
      proof.storeId !== state.scope.storeId ||
      proof.counterId !== state.scope.counterId ||
      proof.headerHash !== order.headerHash ||
      row.requestHash !== state.requestHash ||
      !equalImportHash(
        row.proofHash,
        financialSourceHash(options.sourceProofKey ?? '', 'confirmation', proof),
      )
    )
      throw importFinancialError('ORDER_IMPORT_CONFIRMATION_UNCONFIRMED');
    return proof;
  }
  async function finish(
    tx: AdministrationTransaction,
    loaded: FinancialImportProfileContext,
  ): Promise<ImportFinancialResult | null> {
    const { state } = loaded;
    // A valid completed seal is discovered before current profile gates, even
    // if a lost commit acknowledgment left the journal marked unknown.
    const existing = await recoverImportCompletion(tx, loaded, options.secret);
    if (existing) {
      if (
        state.status !== 'completed' ||
        state.stage !== 'publication' ||
        state.orderId !== existing.order.orderId
      )
        await journal.save(tx, {
          ...state,
          status: 'completed',
          stage: 'publication',
          orderId: existing.order.orderId,
          errorCode: null,
          updatedAt: now(),
        });
      return completed(existing);
    }
    if (state.status === 'completed') throw importFinancialError('ORDER_IMPORT_RECEIPT_INVALID');
    const prepared = await preparation.recover(tx, loaded);
    if (prepared) return prepared;
    if (state.status === 'rejected') return null;
    // New completion still requires every current profile gate before Order.
    await profiles.lock(tx, loaded);
    const order = await readSourceOrderReceipt(
      tx,
      state.scope.operationId,
      options.sourceProofKey ?? '',
    );
    if (!order) return null;
    await profiles.sourceReceipt(tx, loaded, order);
    const [settlementRow] = await tx
      .select()
      .from(financialImportStages)
      .where(
        and(
          eq(financialImportStages.operationId, state.scope.operationId),
          eq(financialImportStages.kind, 'settlement'),
          eq(financialImportStages.status, 'confirmed'),
        ),
      )
      .limit(1)
      .for('share');
    if (!settlementRow) return null;
    if (loaded.plan.kind === 'offline') await confirmation(tx, state, order);
    const settlement = importSettlementReceiptSchema.parse(settlementRow.proof);
    if (
      !settlementRow.proofHash ||
      !equalImportHash(
        settlementRow.proofHash,
        financialImportHash(options.secret, 'stage-confirmation', {
          operationId: state.scope.operationId,
          kind: 'settlement',
          proof: settlement,
        }),
      ) ||
      settlement.operationId !== state.scope.operationId ||
      settlement.orderId !== order.orderId ||
      settlement.kind !== loaded.plan.kind ||
      settlement.recordedAt !== loaded.plan.createdAt ||
      order.requestHash !== state.requestHash ||
      order.customerId !== state.authority.customerId ||
      order.storeId !== state.scope.storeId ||
      order.counterId !== state.scope.counterId
    )
      throw importFinancialError('ORDER_IMPORT_SETTLEMENT_UNCONFIRMED');
    const published = await publication(tx, state, order);
    if (!published) return null;
    const expected = await profiles.expectedQuantities(tx, loaded, order, 'settled'),
      native = await assertNativeImportOrder(tx, state, loaded.plan, order, expected);
    if (
      (loaded.plan.kind === 'offline' &&
        (native.header.paymentStatus !== 4n ||
          native.header.status !== 3n ||
          Number(native.mapping.offline_payment) !== Number(settlement.cash) ||
          Number(native.mapping.offline_payment_recieved) !== Number(settlement.cashReceived) ||
          Number(native.mapping.online_other_payment) !== Number(settlement.manualOther) ||
          Number(native.mapping.online_payment) !== 0 ||
          native.mapping.transaction_id !== settlement.transactionId ||
          native.header.updatedAt !== loaded.plan.createdAt ||
          native.lineStates.some(
            (line) => line.status !== 'PLACED' || line.updatedAt !== loaded.plan.createdAt,
          ))) ||
      (loaded.plan.kind === 'shopify' &&
        (native.header.paymentStatus !== 1n ||
          native.header.status !== 1n ||
          Number(native.mapping.offline_payment) !== 0 ||
          Number(native.mapping.online_payment) !== 0 ||
          Number(native.mapping.online_other_payment) !== 0 ||
          native.lineStates.some((line) => line.status !== 'INCOMPLETE')))
    )
      throw importFinancialError('ORDER_IMPORT_SETTLEMENT_UNCONFIRMED');
    const [binding] = await tx
      .select()
      .from(financialImportOrderBindings)
      .where(eq(financialImportOrderBindings.orderId, order.orderId))
      .limit(1)
      .for('update');
    if (
      !binding ||
      binding.operationId !== state.scope.operationId ||
      binding.requestHash !== state.requestHash ||
      binding.status !== 'held'
    )
      throw importFinancialError('ORDER_IMPORT_ORDER_HELD');
    const membership = await profiles.completionSnapshot(tx, loaded, order);
    assertCsvMembershipPublication(membership, published);
    const proof = importCompletedProofSchema.parse({
      contract: financialImportContract,
      receiptId: crypto.randomUUID(),
      scope: state.scope,
      planHash: state.planHash,
      requestHash: state.requestHash,
      authority: state.authority,
      kind: loaded.plan.kind,
      businessDate: loaded.plan.createdAt.slice(0, 10),
      order,
      settlement,
      publication: published,
      ...(membership ? { membership } : {}),
      ...(state.correction ? { correction: state.correction } : {}),
      finalizedAt: now(),
    });
    await tx.insert(financialImportProofs).values({
      id: proof.receiptId,
      operationId: state.scope.operationId,
      orderId: order.orderId,
      requestHash: state.requestHash,
      data: proof,
      proofHash: financialImportHash(options.secret, 'completed', proof),
      finalizedAt: proof.finalizedAt,
    });
    await tx
      .update(financialImportOrderBindings)
      .set({
        status: 'completed',
        proofHash: financialImportHash(options.secret, 'order-binding', {
          orderId: order.orderId,
          operationId: state.scope.operationId,
          requestHash: state.requestHash,
        }),
      })
      .where(
        and(
          eq(financialImportOrderBindings.orderId, order.orderId),
          eq(financialImportOrderBindings.operationId, state.scope.operationId),
          eq(financialImportOrderBindings.requestHash, state.requestHash),
          eq(financialImportOrderBindings.status, 'held'),
        ),
      );
    await journal.confirm(tx, state, 'publication', published);
    await journal.save(tx, {
      ...state,
      orderId: order.orderId,
      status: 'completed',
      stage: 'publication',
      updatedAt: now(),
    });
    const verified = await verifiedImportCompletion(tx, state.scope.operationId, options.secret);
    if (!verified) throw importFinancialError('ORDER_IMPORT_RECEIPT_INVALID');
    await profiles.completed(tx, loaded, verified);
    return completed(verified);
  }
  async function read(
    scope: ImportFinancialScope,
    currentReads = false,
  ): Promise<ImportFinancialResult | null> {
    try {
      return await journal.transaction(async (tx) => {
        const loaded = await journal.load(tx, scope);
        if (!loaded) return null;
        // A retained preparation may outlive its deployment flags. Reopen only
        // this authenticated native read in an owned current-read transaction;
        // the first transaction performs no mutation and starts no work.
        if (loaded.state.preparationContract && !usesCurrentFinancialReads(tx))
          throw new PreparationCurrentReadsRequired();
        const admission = await verifiedNativeAdmissionRejection(tx, loaded.state, options.secret);
        if (admission)
          return { status: 'rejected', operationId: scope.operationId, code: admission.code };
        const receipt = await finish(tx, loaded);
        if (receipt) return receipt;
        const [negative] = await tx
          .select()
          .from(financialImportSourceReceipts)
          .where(
            and(
              eq(financialImportSourceReceipts.operationId, scope.operationId),
              eq(financialImportSourceReceipts.kind, 'order'),
              eq(financialImportSourceReceipts.status, 'rejected'),
            ),
          )
          .limit(1)
          .for('share');
        if (negative) {
          const proof = sourceRejectionReceiptSchema.parse(negative.proof);
          const [binding] = await tx
            .select({ id: financialImportOrderBindings.orderId })
            .from(financialImportOrderBindings)
            .where(eq(financialImportOrderBindings.operationId, scope.operationId))
            .limit(1)
            .for('share');
          if (
            binding ||
            proof.operationId !== scope.operationId ||
            proof.requestHash !== loaded.state.requestHash ||
            proof.namespace !== loaded.state.namespace ||
            negative.requestHash !== proof.requestHash ||
            !equalImportHash(
              negative.proofHash,
              financialSourceHash(options.sourceProofKey ?? '', 'rejection', proof),
            )
          )
            throw importFinancialError('ORDER_IMPORT_REJECTION_UNCONFIRMED');
          await profiles.rejected(tx, loaded, proof);
          await journal.save(tx, {
            ...loaded.state,
            status: 'rejected',
            errorCode: proof.code,
            updatedAt: now(),
          });
          return { status: 'rejected', operationId: scope.operationId, code: proof.code };
        }
        // No side effect is inferred from equal cart quantities, HTTP status or mutable paid flags.
        const order = await readSourceOrderReceipt(
          tx,
          scope.operationId,
          options.sourceProofKey ?? '',
        );
        return unknown({ ...loaded.state, orderId: order?.orderId ?? loaded.state.orderId });
      }, currentReads);
    } catch (error: unknown) {
      if (error instanceof PreparationCurrentReadsRequired && !currentReads)
        return read(scope, true);
      throw error;
    }
  }
  async function execute(
    reserved: FinancialImportProfileContext,
    firstCommand?: FinancialSourceCommand,
  ): Promise<ImportFinancialResult> {
    const scope = reserved.state.scope;
    try {
      const orderCommand = firstCommand ?? (await journal.dispatch(scope, 'order'));
      await transport.order(orderCommand);
      const order = await journal.transaction(async (tx) => {
        const loaded = await journal.load(tx, scope);
        if (!loaded) throw importFinancialError('ORDER_IMPORT_FINANCIAL_SCOPE_INVALID');
        const receipt = await nativeSource(tx, loaded.state);
        await journal.confirm(tx, loaded.state, 'order', receipt);
        await journal.save(tx, { ...loaded.state, orderId: receipt.orderId, updatedAt: now() });
        return receipt;
      });
      if (reserved.plan.kind === 'offline') {
        const command = await journal.dispatch(scope, 'confirmation');
        const customer = await checkoutRepository(db).customer(
          reserved.state.authority.customerId,
          'writer',
        );
        if (!customer) throw importFinancialError('ORDER_IMPORT_CUSTOMER_UNAVAILABLE');
        await transport.confirm(command, order, customer);
        await journal.transaction(async (tx) => {
          const loaded = await journal.load(tx, scope);
          if (!loaded) throw importFinancialError('ORDER_IMPORT_FINANCIAL_SCOPE_INVALID');
          await profiles.lock(tx, loaded);
          await assertCheckoutProjection(tx, {
            orderId: order.orderId,
            storeId: scope.storeId,
            counterId: scope.counterId,
            customerId: loaded.state.authority.customerId,
          });
          const proof = await confirmation(tx, loaded.state, order);
          await journal.confirm(tx, loaded.state, 'confirmation', proof);
        });
      }
      await journal.dispatch(scope, 'settlement');
      await journal.transaction(async (tx) => {
        const loaded = await journal.load(tx, scope);
        if (!loaded) throw importFinancialError('ORDER_IMPORT_FINANCIAL_SCOPE_INVALID');
        await profiles.lock(tx, loaded);
        const expected = await profiles.expectedQuantities(tx, loaded, order, 'settled');
        const settlement = await settleNativeImport(
          tx,
          loaded.state,
          loaded.plan,
          order,
          options,
          expected,
        );
        await journal.confirm(tx, loaded.state, 'settlement', settlement);
      });
      const publishCommand = await journal.dispatch(scope, 'publication');
      await transport.publication(publishCommand, order);
      return observe((await read(scope)) ?? unknown(reserved.state), reserved.state);
    } catch {
      await journal.uncertain(scope);
      return observe((await read(scope)) ?? unknown(reserved.state), reserved.state);
    }
  }
  return {
    preparationRecovery: preparation.recovery,
    ...(preparation.hooks ? { preparation: preparation.hooks } : {}),
    async authorizeStart(tx, input) {
      profiles.assertReady(input.plan);
      transport.assertReady();
      await assertCashOrderSchema(tx, options.orderSchemaContract);
      if (orderPreparation) await journal.load(tx, input);
      const result = await journal.approvals.authorizeStart(tx, input);
      return result.ready ? { ready: true } : result;
    },
    async start(input, execution) {
      if (orderPreparation) {
        const prepared = await preparation.prepare(input, execution);
        if (!prepared.command)
          return observe(
            (await read(prepared.context.state.scope)) ?? unknown(prepared.context.state),
            prepared.context.state,
          );
        return execute(prepared.context, prepared.command);
      }
      if (execution) throw importFinancialError('ORDER_IMPORT_PREPARATION_UNAVAILABLE', 503);
      const reserved = await journal.reserve(input, async (tx) => {
          // assertReady is configuration-only; no transport runs under SQL.
          transport.assertReady();
          await assertCashOrderSchema(tx, options.orderSchemaContract);
        }),
        scope = reserved.state.scope;
      if (reserved.admission)
        return observe(
          { status: 'rejected', operationId: scope.operationId, code: reserved.admission.code },
          reserved.state,
        );
      if (!reserved.created) return (await read(scope)) ?? unknown(reserved.state);
      return execute(reserved);
    },
    async read(scope) {
      const result = await read(scope);
      return result ? importFinancialResultSchema.parse(result) : null;
    },
  };
}
