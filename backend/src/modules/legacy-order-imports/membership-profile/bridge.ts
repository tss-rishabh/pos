import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { operationHash } from '../../checkout/crypto.js';
import { equalImportHash, importFinancialError } from '../financial-adapter-crypto.js';
import {
  assertQualifiedCsvMembershipHistory,
  csvMembershipHistoryContract,
  csvMembershipHistoryHash,
  csvMembershipHistoryRequestSchema,
  qualifiedCsvMembershipHistorySchema,
  type CsvMembershipHistoryPort,
  type CsvMembershipHistoryRequest,
} from './history.js';
import { csvMembershipSourceInstant } from './bigquery.js';

export const csvMembershipPrefetchContract = 'pos-csv-membership-prefetch-v1';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const csvMembershipPrefetchCapabilitySchema = z
  .object({
    contract: z.literal(csvMembershipPrefetchContract),
    scope: csvMembershipHistoryRequestSchema,
    sourceTimeZone: z.string().min(1).max(128),
    generationId: hash,
    documentHash: hash,
    expiresAt: z.number().int().safe().positive(),
    signature: hash,
  })
  .strict();
export const csvMembershipPrefetchSchema = z
  .object({
    document: qualifiedCsvMembershipHistorySchema,
    capability: csvMembershipPrefetchCapabilitySchema,
  })
  .strict();
export type CsvMembershipPrefetch = z.infer<typeof csvMembershipPrefetchSchema>;
export interface CsvMembershipPrefetchOptions {
  historyKey: string;
  memberProductIds: readonly string[];
  sourceTimeZone: string;
  maxLagSeconds?: number;
  clock?: () => number;
}
function invalid() {
  return importFinancialError('ORDER_IMPORT_MEMBERSHIP_PREFETCH_INVALID');
}
function safe<T>(schema: z.ZodType<T>, value: unknown): T {
  try {
    return schema.parse(value);
  } catch {
    throw invalid();
  }
}
const shallowHandoff = z.object({ document: z.unknown(), capability: z.unknown() }).strict();
function key(value: string) {
  if (!/^[!-~]{32,4096}$/.test(value)) throw invalid();
}
function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function capabilityHash(
  value: Omit<CsvMembershipPrefetch['capability'], 'signature'>,
  historyKey: string,
) {
  key(historyKey);
  return operationHash('legacy-order-imports.membership-prefetch.v1', value, historyKey);
}
/** Called with a trusted *execution* clock outside SQL, never CSV businessDate.
 * Only the history criteria clock is frozen to this retained second on source
 * replay. Do not replace order_date or a financial/header timestamp with it. */
export function requestForCsvMembershipDispatch(
  scope: Pick<
    CsvMembershipHistoryRequest,
    'operationId' | 'requestHash' | 'planHash' | 'customerId'
  >,
  options: { sourceTimeZone: string; clock?: () => number },
): CsvMembershipHistoryRequest {
  try {
    const now = (options.clock ?? Date.now)();
    if (!Number.isSafeInteger(now) || now <= 0) throw invalid();
    const point = Temporal.Instant.fromEpochMilliseconds(now)
      .toZonedDateTimeISO(options.sourceTimeZone)
      .toPlainDateTime()
      .round({ smallestUnit: 'second', roundingMode: 'floor' });
    const asOf = point.toString({ smallestUnit: 'second' }).replace('T', ' ');
    if (now - csvMembershipSourceInstant(asOf, options.sourceTimeZone) >= 1000) throw invalid();
    return csvMembershipHistoryRequestSchema.parse({
      contract: csvMembershipHistoryContract,
      ...scope,
      asOf,
      cutoff: point.subtract({ days: 45 }).toString({ smallestUnit: 'second' }).replace('T', ' '),
    });
  } catch {
    throw invalid();
  }
}
/** Complete BQ I/O happens here before financial source dispatch. Serialize and
 * retain both members of this handoff under the original operation/capability;
 * a lost source reply is original GET recovery, never a new generation/POST. */
export async function prefetchCsvMembershipHistory(
  reader: CsvMembershipHistoryPort,
  input: CsvMembershipHistoryRequest,
  options: CsvMembershipPrefetchOptions,
): Promise<CsvMembershipPrefetch> {
  key(options.historyKey);
  const scope = freeze(safe(csvMembershipHistoryRequestSchema, input));
  const document = assertQualifiedCsvMembershipHistory(
    await reader.read(scope),
    scope,
    options.historyKey,
    options.memberProductIds,
    (options.clock ?? Date.now)(),
  );
  const lag = options.maxLagSeconds ?? 60;
  if (!Number.isSafeInteger(lag) || lag < 1 || lag > 60) throw invalid();
  const expiresAt = Math.min(
    document.fetchedAt + 60000,
    csvMembershipSourceInstant(scope.asOf, options.sourceTimeZone) + lag * 1000,
  );
  const { signature: _documentSignature, ...body } = document;
  const capability: Omit<CsvMembershipPrefetch['capability'], 'signature'> = {
    contract: csvMembershipPrefetchContract,
    scope,
    sourceTimeZone: options.sourceTimeZone,
    generationId: document.generationId,
    documentHash: operationHash(
      'legacy-order-imports.membership-document.v1',
      document,
      options.historyKey,
    ),
    expiresAt,
  };
  if (document.signature !== csvMembershipHistoryHash(body, options.historyKey)) throw invalid();
  const prepared = {
    document,
    capability: { ...capability, signature: capabilityHash(capability, options.historyKey) },
  };
  assertCsvMembershipPrefetch(prepared, scope, options);
  return freeze(prepared);
}
/** Safe for an in-transaction evaluator: pure parsing/HMAC/time checks only.
 * No database, SDK, HTTP, refresh, resend or zero-history fallback. */
export function assertCsvMembershipPrefetch(
  supplied: unknown,
  input: CsvMembershipHistoryRequest,
  options: CsvMembershipPrefetchOptions,
): CsvMembershipPrefetch {
  key(options.historyKey);
  const shallow = safe(shallowHandoff, supplied),
    cap = safe(csvMembershipPrefetchCapabilitySchema, shallow.capability),
    scope = safe(csvMembershipHistoryRequestSchema, input),
    now = (options.clock ?? Date.now)();
  // Bound nested history work before the deep handoff schema. This helper is
  // also used for retained journal documents; a trusted signature never makes
  // an unbounded parse or a historical SQL fallback acceptable.
  const document = (() => {
    try {
      return assertQualifiedCsvMembershipHistory(
        shallow.document,
        scope,
        options.historyKey,
        options.memberProductIds,
        now,
      );
    } catch {
      throw invalid();
    }
  })();
  const value: CsvMembershipPrefetch = { document, capability: cap },
    { signature, ...capability } = cap;
  const lag = options.maxLagSeconds ?? 60;
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(lag) ||
    lag < 1 ||
    lag > 60 ||
    JSON.stringify(scope) !== JSON.stringify(capability.scope) ||
    capability.sourceTimeZone !== options.sourceTimeZone ||
    capability.generationId !== value.document.generationId ||
    !equalImportHash(signature, capabilityHash(capability, options.historyKey)) ||
    !equalImportHash(
      capability.documentHash,
      operationHash(
        'legacy-order-imports.membership-document.v1',
        value.document,
        options.historyKey,
      ),
    ) ||
    now >= capability.expiresAt ||
    capability.expiresAt >
      Math.min(
        value.document.fetchedAt + 60000,
        csvMembershipSourceInstant(scope.asOf, options.sourceTimeZone) + lag * 1000,
      )
  )
    throw invalid();
  return value;
}
export function inMemoryCsvMembershipHistory(
  supplied: unknown,
  options: CsvMembershipPrefetchOptions,
): CsvMembershipHistoryPort {
  // The handoff can come from a trusted sealed journal, not an unbounded browser
  // body. Copy it once so a mutable caller cannot swap a generation after setup.
  const initial = safe(shallowHandoff, supplied),
    cap = safe(csvMembershipPrefetchCapabilitySchema, initial.capability);
  const prepared = freeze(assertCsvMembershipPrefetch(supplied, cap.scope, options));
  return {
    async read(input) {
      return assertCsvMembershipPrefetch(prepared, input, options).document;
    },
  };
}
