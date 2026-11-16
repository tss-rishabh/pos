import { z } from 'zod';
import type { Config } from '../../../config.js';
import { AppError } from '../../../domain/errors.js';
import { boundedJson } from '../../../domain/http-json.js';
import { currentRequestTrace } from '../../../observability/context.js';
import { MAX_CASH_CENTS, cashPriceSnapshotSchema, type CashPriceSnapshot } from './contracts.js';

export interface OfflineCashPriceRequest {
  snapshotId: string;
  operatorId: string;
  storeId: string;
  counterId: string;
  productIds: string[];
  quantities: number[];
  businessDate: string;
  issuedAt: number;
  expiresAt: number;
}
export type OfflineCashPriceSource = (input: OfflineCashPriceRequest) => Promise<CashPriceSnapshot>;
const environmentSchema = z.object({
  OFFLINE_CASH_SIGNING_KEY_PEM: z.string().min(32).optional(),
  OFFLINE_CASH_MAX_RECEIPT_CENTS: z.coerce.number().int().min(100).max(MAX_CASH_CENTS).optional(),
  OFFLINE_CASH_MAX_TOTAL_CENTS: z.coerce.number().int().min(100).max(MAX_CASH_CENTS).optional(),
  OFFLINE_CASH_RECEIPT_COUNT: z.coerce.number().int().min(1).max(1000).optional(),
  OFFLINE_CASH_AUTH_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(8 * 3600)
    .optional(),
  OFFLINE_CASH_MAX_QUANTITY: z.coerce.number().int().min(1).max(99).default(20),
  TSS_OFFLINE_CASH_PRICING_URL: z.url().optional(),
  TSS_OFFLINE_CASH_TEMPLATE_URL: z.url().optional(),
  UPSTREAM_POS_OFFLINE_CASH_TEMPLATE_CONTRACT: z.literal('pos-offline-cash-template-v1').optional(),
  OFFLINE_CASH_ORDER_SCHEMA_CONTRACT: z.literal('pos-offline-cash-order-schema-v1').optional(),
  TSS_OFFLINE_CASH_SOURCE_KEY: z
    .string()
    .regex(/^[\x21-\x7e]{32,4096}$/)
    .optional(),
  UPSTREAM_POS_OFFLINE_CASH_PRICING_CONTRACT: z.literal('pos-offline-cash-prices-v1').optional(),
  UPSTREAM_POS_OFFLINE_CASH_IMPORT_CONTRACT: z.literal('pos-offline-cash-import-v1').optional(),
});
export type OfflineCashEnvironment = z.infer<typeof environmentSchema>;
export function offlineCashEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): OfflineCashEnvironment {
  return environmentSchema.parse(
    Object.fromEntries(Object.entries(env).filter(([, value]) => value !== '')),
  );
}
export function assertOfflineCashReady(environment: OfflineCashEnvironment) {
  if (
    !environment.OFFLINE_CASH_SIGNING_KEY_PEM ||
    !environment.OFFLINE_CASH_MAX_RECEIPT_CENTS ||
    !environment.OFFLINE_CASH_MAX_TOTAL_CENTS ||
    !environment.OFFLINE_CASH_RECEIPT_COUNT ||
    !environment.OFFLINE_CASH_AUTH_TTL_SECONDS ||
    !environment.TSS_OFFLINE_CASH_PRICING_URL ||
    !environment.TSS_OFFLINE_CASH_SOURCE_KEY ||
    environment.UPSTREAM_POS_OFFLINE_CASH_PRICING_CONTRACT !== 'pos-offline-cash-prices-v1' ||
    environment.UPSTREAM_POS_OFFLINE_CASH_IMPORT_CONTRACT !== 'pos-offline-cash-import-v1' ||
    environment.OFFLINE_CASH_MAX_TOTAL_CENTS < environment.OFFLINE_CASH_MAX_RECEIPT_CENTS
  )
    throw new AppError(
      503,
      'OFFLINE_CASH_NOT_CONFIGURED',
      'Offline cash requires configured authorization limits and verified pricing/import contracts.',
    );
  return {
    signingKey: environment.OFFLINE_CASH_SIGNING_KEY_PEM,
    maxReceiptCents: environment.OFFLINE_CASH_MAX_RECEIPT_CENTS,
    maxTotalCents: environment.OFFLINE_CASH_MAX_TOTAL_CENTS,
    receiptCount: environment.OFFLINE_CASH_RECEIPT_COUNT,
    ttlSeconds: environment.OFFLINE_CASH_AUTH_TTL_SECONDS,
    maxQuantity: environment.OFFLINE_CASH_MAX_QUANTITY,
    priceUrl: environment.TSS_OFFLINE_CASH_PRICING_URL,
    sourceKey: environment.TSS_OFFLINE_CASH_SOURCE_KEY,
  };
}

export function offlineCashPriceSource(
  config: Pick<Config, 'NODE_ENV'>,
  environment: OfflineCashEnvironment,
  fetcher: typeof fetch = fetch,
): OfflineCashPriceSource {
  return async (input) => {
    const ready = assertOfflineCashReady(environment),
      url = new URL(ready.priceUrl);
    if (
      (url.protocol !== 'https:' &&
        !(
          config.NODE_ENV === 'test' &&
          url.protocol === 'http:' &&
          ['127.0.0.1', 'localhost'].includes(url.hostname)
        )) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    )
      throw new AppError(
        503,
        'OFFLINE_CASH_NOT_CONFIGURED',
        'The offline pricing endpoint must use an approved secure URL.',
      );
    try {
      const response = await fetcher(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-POS-Offline-Key': ready.sourceKey,
          'X-POS-Operator-ID': input.operatorId,
          'X-Request-ID': currentRequestTrace()?.requestId || crypto.randomUUID(),
        },
        body: JSON.stringify(input),
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('Rejected source snapshot.');
      }
      const result = cashPriceSnapshotSchema.parse(await boundedJson(response, 8_000_000));
      const expected = [...input.productIds].sort(),
        actual = [
          ...result.products.map((product) => product.productId),
          ...result.excludedProductIds,
        ].sort();
      if (
        result.id !== input.snapshotId ||
        result.storeId !== input.storeId ||
        result.counterId !== input.counterId ||
        result.businessDate !== input.businessDate ||
        result.issuedAt !== input.issuedAt ||
        result.expiresAt !== input.expiresAt ||
        JSON.stringify(expected) !== JSON.stringify(actual) ||
        result.products.some(
          (product) =>
            JSON.stringify(
              product.quantities.map((price) => price.quantity).sort((a, b) => a - b),
            ) !== JSON.stringify([...input.quantities].sort((a, b) => a - b)),
        )
      )
        throw new Error('Mismatched source snapshot.');
      return result;
    } catch {
      throw new AppError(
        503,
        'OFFLINE_CASH_PRICING_UNAVAILABLE',
        'The source-authorized offline price snapshot could not be confirmed. No offline cash authorization was issued.',
      );
    }
  };
}
