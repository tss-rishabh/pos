import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../../domain/errors.js';
import { identifier } from '../../../domain/validation.js';
import { customerContextConfigured } from '../customer-context.js';
import type { CustomerContextConfiguration } from '../customer-context.js';
import { customerContactBindingSchema } from '../customer-contact-authority.js';
import { cartSchema, type CheckoutState } from '../contracts.js';
import type { Payload } from '../payloads.js';
import { publicScreeningBenefitsContract } from './benefit-contracts.js';

export const nodeScreeningWriterContract = 'pos-node-screening-writer-v1';
export const nodeScreeningWriterHeader = 'X-POS-Screening-Writer';
const keyDomain = `${nodeScreeningWriterContract}.capability-key`,
  tokenDomain = `${nodeScreeningWriterContract}\n`,
  hash = z.string().regex(/^[a-f0-9]{64}$/),
  epoch = z
    .string()
    .regex(/^(?:0|[1-9]\d{0,19})$/)
    .refine((value) => BigInt(value) <= 18446744073709551615n),
  sqlId = identifier.refine((value) => BigInt(value) <= 9223372036854775807n);
export const nodeScreeningWriterSchema = z
  .object({
    v: z.literal(1),
    contract: z.literal(nodeScreeningWriterContract),
    operationId: z.uuid(),
    checkoutId: z.uuid(),
    checkoutVersion: z.number().int().nonnegative().safe(),
    actorId: sqlId,
    actorVersion: hash,
    actorEpoch: epoch,
    customerId: sqlId,
    contact: customerContactBindingSchema,
    storeId: sqlId,
    counterId: sqlId,
    cartHash: hash,
    requestHash: hash,
    issuedAt: z.number().int().positive().safe(),
    expiresAt: z.number().int().positive().safe(),
    benefitsContract: z.literal(publicScreeningBenefitsContract).optional(),
    membershipHistoryHash: hash.optional(),
  })
  .strict()
  .refine(
    (value) => value.expiresAt > value.issuedAt && value.expiresAt <= value.issuedAt + 60000,
    'The source writer capability has an invalid time bound.',
  )
  .refine(
    (value) =>
      value.membershipHistoryHash === undefined ||
      value.benefitsContract === publicScreeningBenefitsContract,
    'Membership evidence requires the selected public profile.',
  );
export type NodeScreeningWriterCapability = z.infer<typeof nodeScreeningWriterSchema>;
export interface NodeScreeningWriterConfiguration extends CustomerContextConfiguration {
  screeningWriterContract?: string;
  screeningBenefitsContract?: typeof publicScreeningBenefitsContract;
}
const unavailable = () =>
  new AppError(
    503,
    'SCREENING_WRITER_UNAVAILABLE',
    'Screening checkout requires a verified source writer.',
  );
const invalid = () =>
  new AppError(
    409,
    'SCREENING_WRITER_SCOPE_CHANGED',
    'The sale changed. Refresh its final quote before continuing.',
  );
function key(environment: NodeScreeningWriterConfiguration): Buffer {
  if (
    environment.screeningWriterContract !== nodeScreeningWriterContract ||
    !customerContextConfigured(environment) ||
    !environment.customerContextKey
  )
    throw unavailable();
  return createHmac('sha256', environment.customerContextKey).update(keyDomain).digest();
}

type Portable =
  | ['null']
  | ['bool', boolean]
  | ['str', string]
  | ['f64', string]
  | ['list', Portable[]]
  | ['map', [string, Portable][]];
function utf8(value: string): Buffer {
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point !== undefined && point >= 0xd800 && point <= 0xdfff) throw invalid();
  }
  return Buffer.from(value, 'utf8');
}
/** Preserve source JSON numeric values, not JS/Python float spelling. */
export function screeningPortableHash(input: unknown): string {
  let nodes = 0,
    bytes = 0;
  function visit(value: unknown, depth: number): Portable {
    if (++nodes > 100000 || depth > 24) throw invalid();
    if (value === null) return ['null'];
    if (typeof value === 'boolean') return ['bool', value];
    if (typeof value === 'string') {
      bytes += utf8(value).byteLength;
      if (bytes > 2000000) throw invalid();
      return ['str', value];
    }
    if (typeof value === 'bigint') {
      if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER))
        return visit(value.toString(), depth + 1);
      value = Number(value);
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
        throw invalid();
      const raw = Buffer.alloc(8);
      raw.writeDoubleBE(value === 0 ? 0 : value);
      return ['f64', raw.toString('hex')];
    }
    if (Array.isArray(value)) return ['list', value.map((item: unknown) => visit(item, depth + 1))];
    if (
      typeof value !== 'object' ||
      value === null ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      throw invalid();
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    entries.sort(([left], [right]) => Buffer.compare(utf8(left), utf8(right)));
    return [
      'map',
      entries.map(([name, item]) => {
        bytes += utf8(name).byteLength;
        if (bytes > 2000000) throw invalid();
        return [name, visit(item, depth + 1)];
      }),
    ];
  }
  return createHash('sha256')
    .update(JSON.stringify(visit(input, 0)))
    .digest('hex');
}

/** Exact retained source financial/selection data; no price or tax calculation. */
export function screeningQuoteSnapshot(input: unknown) {
  const cart = cartSchema.parse(input),
    meta = z
      .object({ items: z.array(z.record(z.string(), z.unknown())).max(1000) })
      .parse(cart.meta);
  const names = new Set<string>();
  const rows = meta.items.filter((row) => {
    if (typeof row.name !== 'string' || names.has(row.name)) throw invalid();
    names.add(row.name);
    return row.name !== 'payment_details';
  });
  if (!names.has('calculations')) throw invalid();
  rows.sort((left, right) => Buffer.compare(utf8(String(left.name)), utf8(String(right.name))));
  const lines = (items: Record<string, unknown>[]) =>
    items.map((item) =>
      Object.fromEntries(
        Object.entries(item).filter(([name]) => !['stock', 'variant', 'images'].includes(name)),
      ),
    );
  return {
    products: lines(cart.products.items),
    giftvouchers: lines(cart.giftvouchers?.items ?? []),
    complementary_products: lines(cart.complementary_products?.items ?? []),
    meta: rows,
    selected_products: cart.selected_products ?? null,
  };
}

export function signNodeScreeningWriter(
  environment: NodeScreeningWriterConfiguration,
  input: {
    state: CheckoutState;
    operationId: string;
    actorVersion: string;
    actorEpoch: string;
    contact: z.infer<typeof customerContactBindingSchema>;
    payload: Payload;
    now?: number;
  },
): { header: string; value: NodeScreeningWriterCapability } {
  key(environment);
  const { state } = input,
    now = input.now ?? Date.now();
  if (
    state.phase !== 'quoted' ||
    !state.quote ||
    state.orderId ||
    state.busyOperationId !== input.operationId ||
    state.draftImport?.status !== 'complete' ||
    (state.orderCopy && state.orderCopy.status !== 'acknowledged')
  )
    throw invalid();
  const value = nodeScreeningWriterSchema.parse({
      v: 1,
      contract: nodeScreeningWriterContract,
      operationId: input.operationId,
      checkoutId: state.id,
      checkoutVersion: state.version,
      actorId: state.operatorId,
      actorVersion: input.actorVersion,
      actorEpoch: input.actorEpoch,
      customerId: state.customerId ?? state.operatorCustomerId,
      contact: input.contact,
      storeId: state.storeId,
      counterId: state.counterId,
      cartHash: screeningPortableHash(screeningQuoteSnapshot(state.quote)),
      requestHash: screeningPortableHash(input.payload),
      issuedAt: now,
      expiresAt: now + 60000,
      ...(environment.screeningBenefitsContract
        ? { benefitsContract: environment.screeningBenefitsContract }
        : {}),
    }),
    sealed = sealNodeScreeningWriter(environment, value);
  return sealed;
}

/** Internal reseal of the same opaque operation. Callers must retain native
 * prepared authority; this function performs no authorization or renewal. */
export function sealNodeScreeningWriter(
  environment: NodeScreeningWriterConfiguration,
  supplied: NodeScreeningWriterCapability,
): { header: string; value: NodeScreeningWriterCapability } {
  const secret = key(environment),
    value = nodeScreeningWriterSchema.parse(supplied),
    raw = Buffer.from(JSON.stringify(value), 'utf8').toString('base64url'),
    signature = createHmac('sha256', secret)
      .update(tokenDomain + raw)
      .digest('hex');
  return { header: `${raw}.${signature}`, value };
}

/** Private fixture/reader check; never reissues or extends an old capability. */
export function verifyNodeScreeningWriter(
  environment: NodeScreeningWriterConfiguration,
  header: string,
  now = Date.now(),
): NodeScreeningWriterCapability {
  const secret = key(environment),
    parts = header.split('.');
  if (
    header.length > 4096 ||
    parts.length !== 2 ||
    !/^[A-Za-z0-9_-]+$/.test(parts[0] ?? '') ||
    !/^[a-f0-9]{64}$/.test(parts[1] ?? '')
  )
    throw invalid();
  const raw = parts[0]!,
    signature = parts[1]!,
    expected = createHmac('sha256', secret)
      .update(tokenDomain + raw)
      .digest();
  if (
    !timingSafeEqual(expected, Buffer.from(signature, 'hex')) ||
    Buffer.from(raw, 'base64url').toString('base64url') !== raw
  )
    throw invalid();
  let value: NodeScreeningWriterCapability;
  try {
    value = nodeScreeningWriterSchema.parse(
      JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')),
    );
  } catch {
    throw invalid();
  }
  if (value.issuedAt > now || value.expiresAt <= now) throw invalid();
  return value;
}
