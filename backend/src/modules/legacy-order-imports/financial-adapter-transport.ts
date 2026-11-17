import type { Config } from '../../config.js';
import { boundedJson } from '../../domain/http-json.js';
import { stringifyNumericJson } from '../upstream.js';
import { confirmationPayload, wireId } from '../checkout/payloads.js';
import { issueCustomerToken } from '../checkout/crypto.js';
import type { CustomerIdentity } from '../checkout/contracts.js';
import type { LegacyOrderImportPlan } from './plans.js';
import type { LegacyImportFinancialOptions } from './financial-adapter-options.js';
import type { ImportFinancialState, SourceOrderReceipt } from './financial-adapter-contracts.js';
import {
  financialImportContract,
  financialSourceContract,
  financialPublicationContract,
  financialConfirmationContract,
} from './financial-adapter-contracts.js';
import { financialSourceHash, importFinancialError } from './financial-adapter-crypto.js';
import { assertCheckoutProjectionReady } from '../checkout/projection.js';
import { assertRefundAllocationReady } from '../checkout/refund-allocation.js';
import type { CsvMembershipPrefetch } from './membership-profile/bridge.js';
import type { CsvCouponPrefetch } from './benefit-profile/bridge.js';
import { operationHash } from '../checkout/crypto.js';
import { financialImportHash, equalImportHash } from './financial-adapter-crypto.js';
import {
  sourceOrderPreparationContract,
  sourceOrderPreviewSchema,
  type SourceOrderPreview,
  type SourceOrderPreparationInput,
} from './source-order-preparation-contracts.js';
export interface FinancialSourceCommand {
  state: ImportFinancialState;
  succession?: import('./authority-succession/contracts.js').ImportSuccessionEnvelope;
  plan: LegacyOrderImportPlan;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  /** Server-prepared warehouse evidence; never a client input or an SQL reader. */
  membershipHistory?: CsvMembershipPrefetch;
  couponHistory?: CsvCouponPrefetch;
}
export interface LegacyImportFinancialTransport {
  assertReady(): void;
  order(input: FinancialSourceCommand): Promise<void>;
  confirm(
    input: FinancialSourceCommand,
    order: SourceOrderReceipt,
    customer: CustomerIdentity,
  ): Promise<void>;
  publication(input: FinancialSourceCommand, order: SourceOrderReceipt): Promise<void>;
}
export function legacyImportFinancialTransport(
  config: Config,
  options: LegacyImportFinancialOptions,
): LegacyImportFinancialTransport {
  const fetcher = options.fetcher ?? fetch;
  function secureUrl(raw: string | undefined, expectedPath?: string) {
    if (!raw) throw importFinancialError('ORDER_IMPORT_SOURCE_UNAVAILABLE', 503);
    const url = new URL(raw);
    if (
      (url.protocol !== 'https:' &&
        !(
          config.NODE_ENV === 'test' &&
          url.protocol === 'http:' &&
          ['127.0.0.1', 'localhost'].includes(url.hostname)
        )) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (expectedPath && url.pathname !== expectedPath)
    )
      throw importFinancialError('ORDER_IMPORT_SOURCE_UNAVAILABLE', 503);
    return url;
  }
  function ready() {
    if (
      options.contract !== financialImportContract ||
      options.sourceContract !== financialSourceContract ||
      options.publicationContract !== financialPublicationContract ||
      options.confirmationContract !== financialConfirmationContract ||
      !/^[!-~]{32,4096}$/.test(options.sourceAuthKey ?? '') ||
      !/^[!-~]{32,4096}$/.test(options.sourceProofKey ?? '') ||
      options.sourceAuthKey === options.sourceProofKey ||
      options.sourceAuthKey === options.secret ||
      options.sourceProofKey === options.secret ||
      [
        options.checkout?.hs256,
        options.checkout?.hs512,
        options.checkout?.checkoutProjectionKey,
      ].some(
        (key) => Boolean(key) && (key === options.sourceAuthKey || key === options.sourceProofKey),
      ) ||
      !options.checkout?.checkoutProjectionKey ||
      !options.checkout.paymentOrderUrl ||
      !options.checkout.hs256 ||
      !options.checkout.hs512 ||
      options.stockContract !== 'pos-stock-projection-70b801-v1' ||
      !options.stockProcedure ||
      options.orderSchemaContract !== 'pos-offline-cash-order-schema-v1'
    )
      throw importFinancialError('ORDER_IMPORT_SOURCE_UNAVAILABLE', 503);
    assertCheckoutProjectionReady(options.checkout ?? {});
    assertRefundAllocationReady(options.checkout ?? {});
    secureUrl(options.sourceUrl, '/internal/pos/legacy-order-imports');
    secureUrl(options.checkout.paymentOrderUrl);
  }
  async function send(url: URL, body: unknown, headers: Record<string, string>) {
    const response = await fetcher(url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
      body: stringifyNumericJson(body),
    });
    // An HTTP rejection alone does not prove that a source transaction/effect did
    // not commit. Only the original native receipt can establish that outcome.
    if (!response.ok) {
      await response.body?.cancel();
      throw importFinancialError('ORDER_IMPORT_SOURCE_REPLY_UNCERTAIN');
    }
    await boundedJson(response, 16000);
  }
  function capability(
    input: FinancialSourceCommand,
    phase: 'order' | 'confirmation' | 'publication',
    orderId: string | null,
  ) {
    if (
      phase === 'order' &&
      'preparationContract' in input.state &&
      input.state.preparationContract !== undefined &&
      input.state.preparationContract !== sourceOrderPreparationContract
    )
      throw importFinancialError('ORDER_IMPORT_PREPARATION_INVALID');
    const value = {
      contract: financialSourceContract,
      phase,
      operationId: input.state.scope.operationId,
      requestHash: input.state.requestHash,
      planHash: input.state.planHash,
      namespace: input.state.namespace,
      planDigest: financialSourceHash(options.sourceAuthKey ?? '', 'plan', input.plan),
      scope: input.state.scope,
      authority: input.state.authority,
      orderId,
      nonce: input.nonce,
      issuedAt: input.issuedAt,
      expiresAt:
        phase === 'order'
          ? Math.min(
              input.expiresAt,
              input.membershipHistory?.capability.expiresAt ?? input.expiresAt,
              input.couponHistory?.capability.expiresAt ?? input.expiresAt,
            )
          : input.expiresAt,
      ...(input.succession ? { succession: input.succession } : {}),
      ...(phase === 'order' &&
      'preparationContract' in input.state &&
      input.state.preparationContract
        ? { preparationContract: sourceOrderPreparationContract }
        : {}),
      ...(phase === 'order' && input.state.correction
        ? {
            correctionHash: financialSourceHash(
              options.sourceAuthKey ?? '',
              'correction',
              input.state.correction,
            ),
          }
        : {}),
      ...(phase === 'order' && input.membershipHistory
        ? {
            membershipHistoryHash: financialSourceHash(
              options.sourceAuthKey ?? '',
              'membership-history',
              input.membershipHistory,
            ),
          }
        : {}),
      ...(phase === 'order' && input.state.benefitContracts
        ? { benefitContracts: input.state.benefitContracts }
        : {}),
      ...(phase === 'order' && input.couponHistory
        ? {
            couponHistoryHash: financialSourceHash(
              options.sourceAuthKey ?? '',
              'coupon-history',
              input.couponHistory,
            ),
          }
        : {}),
    };
    return {
      ...value,
      signature: financialSourceHash(options.sourceAuthKey ?? '', 'capability', value),
    };
  }
  const headers = (input: FinancialSourceCommand) => ({
    'X-POS-Legacy-Import-Key': options.sourceAuthKey ?? '',
    'X-POS-Operator-ID': input.succession?.data.managerId ?? input.state.scope.actorId,
    'X-Request-ID': input.state.requestId,
  });
  return {
    assertReady: ready,
    async order(input) {
      ready();
      const url = secureUrl(options.sourceUrl, '/internal/pos/legacy-order-imports');
      url.pathname += `/${input.state.scope.operationId}/order`;
      await send(
        url,
        {
          capability: capability(input, 'order', null),
          plan: input.plan,
          ...(input.membershipHistory ? { membershipHistory: input.membershipHistory } : {}),
          ...(input.couponHistory ? { couponHistory: input.couponHistory } : {}),
        },
        headers(input),
      );
    },
    async confirm(input, order, customer) {
      ready();
      const env = options.checkout!;
      const token = issueCustomerToken(
          customer,
          { hs256: env.hs256, hs512: env.hs512 },
          input.issuedAt,
        ),
        proof = capability(input, 'confirmation', order.orderId);
      await send(
        secureUrl(env.paymentOrderUrl),
        confirmationPayload(
          wireId(order.orderId),
          14,
          true,
          'placed_order',
          BigInt(input.state.scope.storeId),
        ),
        {
          Authorization: `Bearer ${token}`,
          'X-POS-Projection-Key': env.checkoutProjectionKey ?? '',
          'X-POS-Legacy-Import-Key': options.sourceAuthKey ?? '',
          'X-POS-Legacy-Import-Capability': Buffer.from(JSON.stringify(proof)).toString(
            'base64url',
          ),
          'X-POS-Operator-ID': input.succession?.data.managerId ?? input.state.scope.actorId,
          'X-Request-ID': input.state.requestId,
        },
      );
    },
    async publication(input, order) {
      ready();
      const url = secureUrl(options.sourceUrl, '/internal/pos/legacy-order-imports');
      url.pathname += `/${input.state.scope.operationId}/publication`;
      await send(
        url,
        { capability: capability(input, 'publication', order.orderId), orderId: order.orderId },
        headers(input),
      );
    },
  };
}

/** A separate purpose: no order-stage nonce, dispatch, financial endpoint or
 * retry. Core owns the native RUNNING attempt and calls this outside SQL. */
export function legacyImportPreparationTransport(
  config: Pick<Config, 'NODE_ENV'>,
  options: Pick<
    LegacyImportFinancialOptions,
    'secret' | 'sourceUrl' | 'sourceAuthKey' | 'sourceProofKey' | 'fetcher' | 'clock'
  >,
) {
  const clock = options.clock ?? Date.now,
    fetcher = options.fetcher ?? fetch;
  const proof = (kind: string, value: unknown, key: string) =>
    operationHash('legacy-order-imports.source.' + kind + '.v1', value, key);
  return {
    async preview(
      input: SourceOrderPreparationInput,
      supplied: {
        signal: AbortSignal;
        membershipHistory?: CsvMembershipPrefetch;
        couponHistory?: CsvCouponPrefetch;
      },
    ): Promise<SourceOrderPreview> {
      supplied.signal.throwIfAborted();
      let base: URL;
      try {
        base = new URL(options.sourceUrl ?? '');
        if (
          (base.protocol !== 'https:' &&
            !(
              config.NODE_ENV === 'test' &&
              base.protocol === 'http:' &&
              ['127.0.0.1', 'localhost'].includes(base.hostname)
            )) ||
          base.username ||
          base.password ||
          base.search ||
          base.hash ||
          base.pathname !== '/internal/pos/legacy-order-imports' ||
          !/^[!-~]{32,4096}$/.test(options.sourceAuthKey ?? '') ||
          !/^[!-~]{32,4096}$/.test(options.sourceProofKey ?? '') ||
          new Set([options.secret, options.sourceAuthKey, options.sourceProofKey]).size !== 3
        )
          throw new Error();
      } catch {
        throw importFinancialError('ORDER_IMPORT_PREPARATION_UNAVAILABLE', 503);
      }
      const issuedAt = clock(),
        expiresAt = Math.min(input.expiresAt, issuedAt + 60000);
      if (
        !Number.isSafeInteger(issuedAt) ||
        !Number.isSafeInteger(expiresAt) ||
        expiresAt <= issuedAt
      )
        throw importFinancialError('ORDER_IMPORT_PREPARATION_EXPIRED');
      const value = {
        contract: sourceOrderPreparationContract,
        purpose: 'source-cart-preview',
        operationId: input.state.scope.operationId,
        attemptId: input.attemptId,
        requestHash: input.state.requestHash,
        planHash: input.state.planHash,
        namespace: input.state.namespace,
        planDigest: proof('plan', input.plan, options.sourceAuthKey!),
        authorityHash: financialImportHash(
          options.secret,
          'preparation-authority',
          input.state.authority,
        ),
        scope: input.state.scope,
        authority: input.state.authority,
        issuedAt,
        expiresAt,
        attemptExpiresAt: input.expiresAt,
        ...(supplied.membershipHistory
          ? {
              membershipHistoryHash: proof(
                'membership-history',
                supplied.membershipHistory,
                options.sourceAuthKey!,
              ),
            }
          : {}),
        ...(input.state.benefitContracts ? { benefitContracts: input.state.benefitContracts } : {}),
        ...(supplied.couponHistory
          ? {
              couponHistoryHash: proof(
                'coupon-history',
                supplied.couponHistory,
                options.sourceAuthKey!,
              ),
            }
          : {}),
      };
      const requestBody = stringifyNumericJson({
        capability: {
          ...value,
          signature: proof('preparation-capability', value, options.sourceAuthKey!),
        },
        plan: input.plan,
        ...(supplied.membershipHistory ? { membershipHistory: supplied.membershipHistory } : {}),
        ...(supplied.couponHistory ? { couponHistory: supplied.couponHistory } : {}),
      });
      if (Buffer.byteLength(requestBody) > 1400000)
        throw importFinancialError('ORDER_IMPORT_PREPARATION_INVALID');
      const response = await fetcher(
        new URL(base.href + '/' + value.operationId + '/preparation'),
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.any([
            supplied.signal,
            AbortSignal.timeout(Math.min(30000, expiresAt - issuedAt)),
          ]),
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-POS-Legacy-Import-Key': options.sourceAuthKey!,
            'X-POS-Operator-ID': input.state.scope.actorId,
            'X-Request-ID': input.state.requestId,
          },
          body: requestBody,
        },
      ).catch(() => {
        supplied.signal.throwIfAborted();
        throw importFinancialError('ORDER_IMPORT_PREPARATION_UNAVAILABLE', 503);
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw importFinancialError('ORDER_IMPORT_PREPARATION_UNAVAILABLE', 503);
      }
      const raw = await boundedJson(response, 16000).catch(() => {
        supplied.signal.throwIfAborted();
        throw importFinancialError('ORDER_IMPORT_PREPARATION_INVALID');
      });
      const parsed = sourceOrderPreviewSchema.safeParse(raw);
      supplied.signal.throwIfAborted();
      if (!parsed.success) throw importFinancialError('ORDER_IMPORT_PREPARATION_INVALID');
      const result = parsed.data,
        { signature, ...body } = result,
        now = clock();
      if (
        !equalImportHash(signature, proof('preparation-result', body, options.sourceProofKey!)) ||
        result.operationId !== value.operationId ||
        result.attemptId !== value.attemptId ||
        result.requestHash !== value.requestHash ||
        result.planHash !== value.planHash ||
        result.scope.actorId !== value.scope.actorId ||
        result.scope.operationId !== value.scope.operationId ||
        result.scope.storeId !== value.scope.storeId ||
        result.scope.counterId !== value.scope.counterId ||
        result.authorityHash !== value.authorityHash ||
        result.planDigest !== value.planDigest ||
        result.attemptExpiresAt !== value.attemptExpiresAt ||
        result.expiresAt !== expiresAt ||
        result.issuedAt < issuedAt ||
        result.issuedAt > now ||
        now >= expiresAt ||
        result.membershipHistoryHash !== (value.membershipHistoryHash ?? null) ||
        result.benefitContracts?.automaticCoupon !== value.benefitContracts?.automaticCoupon ||
        result.benefitContracts?.complementary !== value.benefitContracts?.complementary ||
        result.couponHistoryHash !==
          (value.benefitContracts?.automaticCoupon ? (value.couponHistoryHash ?? null) : undefined)
      )
        throw importFinancialError('ORDER_IMPORT_PREPARATION_INVALID');
      return result;
    },
  };
}
