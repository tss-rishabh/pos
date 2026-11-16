import { z } from 'zod';
import type { Principal } from '../../api/types';
import { captureOperatorScope } from '../../api/client';
import { confirmedPaymentSchema, type ConfirmedPayment } from '../checkout/receipts';
import { currentInvoiceSession, invoiceIdentity } from './session';
const exchangeInvoiceEvidence = z
  .object({
    source: z.literal('exchange'),
    exchangeId: z.uuid(),
    orderId: z
      .string()
      .regex(/^[1-9]\d{0,18}$/)
      .refine((value) => BigInt(value) <= 9223372036854775807n),
  })
  .strict();
export type AutomaticExchangeInvoiceEvidence = z.infer<typeof exchangeInvoiceEvidence>;
type AutomaticInvoiceEvidence = ConfirmedPayment | AutomaticExchangeInvoiceEvidence;
export interface AutomaticInvoiceRequest {
  readonly id: string;
  readonly ownerId: string;
  readonly storeId: string;
  readonly receipt: AutomaticInvoiceEvidence;
}
type Active = { signal: AbortSignal; identity: string; createdAt: number };
const active = new WeakMap<AutomaticInvoiceRequest, Active>(),
  attempted = new Set<string>(),
  lifetime = 60_000;
function brandAutomaticInvoice(
  user: Principal,
  storeId: string,
  receipt: AutomaticInvoiceEvidence,
): AutomaticInvoiceRequest | null {
  if (
    !/^[1-9]\d{0,18}$/.test(storeId) ||
    BigInt(storeId) > 9223372036854775807n ||
    !((user.role === 1 && user.userType === 1) || user.storeIds.includes(storeId))
  )
    return null;
  const request = Object.freeze({
    id: crypto.randomUUID(),
    ownerId: user.id,
    storeId,
    receipt: Object.freeze(receipt),
  });
  active.set(request, {
    signal: captureOperatorScope(user.id),
    identity: invoiceIdentity(user),
    createdAt: Date.now(),
  });
  return request;
}
/** Only a new paid callback creates this capability; restored JSON cannot recreate it. */
export function createAutomaticInvoiceRequest(
  user: Principal,
  storeId: string,
  raw: ConfirmedPayment,
): AutomaticInvoiceRequest | null {
  try {
    return brandAutomaticInvoice(user, storeId, confirmedPaymentSchema.parse(raw));
  } catch {
    return null;
  }
}
/** A completed exchange binds its actual child order, without inventing payment fields.
 * The protected document endpoint independently requires current paid authorization. */
export function createAutomaticExchangeInvoiceRequest(
  user: Principal,
  storeId: string,
  raw: AutomaticExchangeInvoiceEvidence,
): AutomaticInvoiceRequest | null {
  try {
    return brandAutomaticInvoice(user, storeId, exchangeInvoiceEvidence.parse(raw));
  } catch {
    return null;
  }
}
export function currentAutomaticInvoice(request: AutomaticInvoiceRequest, user: Principal) {
  const value = active.get(request),
    elapsed = value ? Date.now() - value.createdAt : -1;
  return (
    !!value &&
    !value.signal.aborted &&
    elapsed >= 0 &&
    elapsed <= lifetime &&
    request.ownerId === user.id &&
    value.identity === invoiceIdentity(user)
  );
}
/** Claim before print. Persist only an opaque scope hash, never receipt/HTML/contacts. */
export async function claimAutomaticInvoicePrint(
  request: AutomaticInvoiceRequest,
  user: Principal,
  signal: AbortSignal,
): Promise<boolean> {
  if (!currentAutomaticInvoice(request, user)) return false;
  const original = active.get(request)!,
    scoped = AbortSignal.any([signal, original.signal]);
  await currentInvoiceSession(user, request.storeId, scoped);
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify([
        request.receipt.source === 'exchange'
          ? 'pos-exchange-invoice-auto-v1'
          : 'pos-invoice-auto-v1',
        request.ownerId,
        request.storeId,
        request.receipt.orderId,
        request.receipt.source === 'exchange'
          ? request.receipt.exchangeId
          : request.receipt.receiptId,
      ]),
    ),
  );
  scoped.throwIfAborted();
  if (!currentAutomaticInvoice(request, user)) return false;
  const key =
    'pos-invoice-print:' +
    Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, '0')).join('');
  try {
    if (attempted.has(key) || sessionStorage.getItem(key) === '1') return false;
    sessionStorage.setItem(key, '1');
    attempted.add(key);
    return true;
  } catch {
    return false;
  }
}
