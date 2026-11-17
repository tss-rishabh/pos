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
export interface FinancialSourceCommand {
  state: ImportFinancialState;
  plan: LegacyOrderImportPlan;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
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
      expiresAt: input.expiresAt,
      ...(phase === 'order' && input.state.correction
        ? {
            correctionHash: financialSourceHash(
              options.sourceAuthKey ?? '',
              'correction',
              input.state.correction,
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
    'X-POS-Operator-ID': input.state.scope.actorId,
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
        { capability: capability(input, 'order', null), plan: input.plan },
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
          'X-POS-Operator-ID': input.state.scope.actorId,
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
