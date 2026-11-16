import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import type { Principal } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import { currentRequestTrace } from '../../../observability/context.js';
import { cashDigest, offlineCashSigner } from './crypto.js';
import { offlineCashRepository } from './repository.js';
import type { StockProcedure } from '../../administration/stock-procedure.js';
import { cashSourceTemplate, type CashTemplateSource } from './template.js';
import { assertCashOrderSchema, cashOrderSchemaContract } from './writer.js';
import type { CashOrderImportInput } from './attribution.js';
import type { CashPriceSnapshot } from './contracts.js';
import {
  assertOfflineCashReady,
  offlineCashEnvironment,
  offlineCashPriceSource,
  type OfflineCashEnvironment,
  type OfflineCashPriceSource,
} from './gateway.js';

export interface OfflineCashServiceOptions {
  environment?: OfflineCashEnvironment;
  repository?: ReturnType<typeof offlineCashRepository>;
  prices?: OfflineCashPriceSource;
  templates?: CashTemplateSource;
  stockProcedure?: StockProcedure;
  clock?: () => number;
}
export function offlineCashService(
  config: Config,
  db: Databases,
  options: OfflineCashServiceOptions = {},
) {
  const environment = options.environment || offlineCashEnvironment(),
    clock = options.clock || Date.now;
  let cachedSigner: ReturnType<typeof offlineCashSigner> | undefined;
  const signer = () =>
    (cachedSigner ||= offlineCashSigner(environment.OFFLINE_CASH_SIGNING_KEY_PEM || ''));
  const repository =
    options.repository ||
    offlineCashRepository(db, config, {
      verifyAuthorization: (envelope) => signer().verify(envelope),
      authorizationPublicKey: () => signer().publicKey,
      sourceImportReady:
        !!options.stockProcedure &&
        environment.UPSTREAM_POS_OFFLINE_CASH_IMPORT_CONTRACT === 'pos-offline-cash-import-v1' &&
        environment.UPSTREAM_POS_OFFLINE_CASH_TEMPLATE_CONTRACT ===
          'pos-offline-cash-template-v1' &&
        environment.OFFLINE_CASH_ORDER_SCHEMA_CONTRACT === cashOrderSchemaContract &&
        !!environment.TSS_OFFLINE_CASH_TEMPLATE_URL,
    });
  const prices = options.prices || offlineCashPriceSource(config, environment);
  const templates =
    options.templates ||
    cashSourceTemplate(config, {
      url: environment.TSS_OFFLINE_CASH_TEMPLATE_URL,
      key: environment.TSS_OFFLINE_CASH_SOURCE_KEY,
      contract: environment.UPSTREAM_POS_OFFLINE_CASH_TEMPLATE_CONTRACT,
    });
  function importerReady() {
    assertOfflineCashReady(environment);
    if (
      !options.stockProcedure ||
      environment.UPSTREAM_POS_OFFLINE_CASH_TEMPLATE_CONTRACT !== 'pos-offline-cash-template-v1' ||
      !environment.TSS_OFFLINE_CASH_TEMPLATE_URL ||
      environment.OFFLINE_CASH_ORDER_SCHEMA_CONTRACT !== cashOrderSchemaContract
    )
      throw new AppError(
        503,
        'OFFLINE_CASH_IMPORT_NOT_CONFIGURED',
        'Offline cash requires verified source-template, strict-mode order schema and transaction-scoped stock import contracts.',
      );
    return options.stockProcedure;
  }
  return {
    repository,
    async importReceipt(
      user: Principal,
      storeId: string,
      receiptId: string,
      input: CashOrderImportInput,
    ) {
      const current = await repository.get(user, storeId, receiptId);
      if (current.status === 'imported')
        return repository.importOrder(user, storeId, receiptId, input, null, null);
      const stockProcedure = importerReady();
      const template = await templates(receiptId, user.id);
      return repository.importOrder(user, storeId, receiptId, input, template, {
        stockProcedure,
        stockContract: 'pos-stock-projection-70b801-v1',
        orderSchemaContract: environment.OFFLINE_CASH_ORDER_SCHEMA_CONTRACT,
        signer: signer(),
        actorId: user.id,
        finalizedAt: clock(),
        ...(currentRequestTrace()?.requestId
          ? { requestId: currentRequestTrace()!.requestId }
          : {}),
      });
    },
    async authorize(
      user: Principal,
      storeId: string,
      input: { deviceId: string; counterId: string; productIds: string[] },
    ) {
      importerReady();
      await db
        .get('writer')
        .transaction((tx) =>
          assertCashOrderSchema(tx, environment.OFFLINE_CASH_ORDER_SCHEMA_CONTRACT),
        );
      const ready = assertOfflineCashReady(environment),
        { active, ...context } = await repository.authorizationContext(
          user,
          storeId,
          input.counterId,
          input.deviceId,
        );
      const coversRequested = (snapshot: CashPriceSnapshot) => {
        const covered = new Set([
          ...snapshot.products.map((product) => product.productId),
          ...snapshot.excludedProductIds,
        ]);
        if (input.productIds.some((id) => !covered.has(id)))
          throw new AppError(
            409,
            'OFFLINE_CASH_ACTIVE_AUTHORIZATION_CONFLICT',
            'This device already has a fixed cash price authorization. Keep it until expiry or reconcile it before requesting different items.',
          );
      };
      if (active) {
        coversRequested(active.snapshot);
        return active;
      }
      const now = clock(),
        instant = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(
          config.BUSINESS_TIMEZONE,
        ),
        businessDate = instant.toPlainDate().toString(),
        expiresAt = Math.min(
          now + ready.ttlSeconds * 1000,
          instant.startOfDay().add({ days: 1 }).epochMilliseconds - 1000,
        );
      if (expiresAt - now < 60_000)
        throw new AppError(
          409,
          'OFFLINE_CASH_DAY_END',
          'Reconnect after the business day changes before enabling offline cash.',
        );
      const snapshot = await prices({
        snapshotId: randomUUID(),
        operatorId: user.id,
        storeId,
        counterId: input.counterId,
        productIds: [...input.productIds],
        quantities: Array.from({ length: ready.maxQuantity }, (_value, index) => index + 1),
        businessDate,
        issuedAt: now,
        expiresAt,
      });
      if (clock() >= expiresAt)
        throw new AppError(
          409,
          'OFFLINE_CASH_AUTHORIZATION_EXPIRED',
          'The offline authorization window expired while prices were loading. Try again.',
        );
      const id = randomUUID(),
        envelope = signer().authorize({
          version: 1,
          id,
          deviceId: input.deviceId,
          ...context,
          operatorId: user.id,
          storeId,
          counterId: input.counterId,
          businessDate,
          issuedAt: now,
          expiresAt,
          snapshotId: snapshot.id,
          snapshotHash: cashDigest(snapshot),
          stockPolicy: 'cached-stock-manager',
          mode: 'cash-only',
          currency: 'INR',
          receiptPrefix: 'OC-' + id.replace(/-/g, '').toUpperCase(),
          receiptCount: ready.receiptCount,
          maxReceiptUnits: 1000,
          maxReceiptCents: ready.maxReceiptCents,
          maxTotalCents: ready.maxTotalCents,
        });
      const saved = await repository.saveAuthorization(user, envelope, snapshot);
      if (!saved)
        throw new AppError(
          409,
          'OFFLINE_CASH_AUTHORIZATION_EXPIRED',
          'The device authorization expired before it could be saved. Reconnect to enable cash again.',
        );
      coversRequested(saved.snapshot);
      return saved;
    },
  };
}
