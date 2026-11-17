import type { Route } from '@playwright/test';
import { z } from 'zod';
import { expect } from 'vitest';
import {
  attestReturnSchema,
  cancelReturnSchema,
  prepareReturnSchema,
  type CashReturnView,
} from '../../src/pages/payment-reversals/intent-contracts';
import {
  correctionReceiptSchema,
  type CorrectionReceipt,
} from '../../src/pages/payment-reversals/client';
export const cashOrderId = '9007199254740993',
  originalCashId = '11111111-1111-4111-8111-111111111111';
type Kind = 'prepare' | 'arm' | 'attest' | 'cancel' | 'resolve';
export function cashReturnFixture() {
  return {
    view: null as CashReturnView | null,
    receipt: null as CorrectionReceipt | null,
    originalPayment: Object.freeze({
      id: originalCashId,
      orderId: cashOrderId,
      transactionId: 'ORIGINAL-CASH',
      channel: 'cash' as const,
      cashAmount: '99.95',
      onlineAmount: '0.00',
      status: 'paid' as const,
      errorCode: null,
    }),
    writes: [] as {
      kind: Kind;
      operationId: string;
      actorId: string;
      input: Record<string, unknown>;
    }[],
    reads: [] as { path: string; actorId: string }[],
    commands: new Map<string, { kind: Kind; actorId: string }>(),
    drop: null as { kind: Kind; outcome: 'absent' | 'committed' } | null,
    holdResolution: false,
    releaseResolution: () => undefined as void,
  };
}
export type CashReturnFixture = ReturnType<typeof cashReturnFixture>;
export const cashPending = (cash: CashReturnFixture) =>
  cash.view?.phase === 'RETURN_PENDING' || cash.view?.phase === 'ATTESTED';
export function currentCashPayment(cash: CashReturnFixture) {
  return cash.receipt
    ? { ...cash.originalPayment, status: 'reversed' as const, reversalId: cash.receipt.id }
    : cash.originalPayment;
}
const now = () => new Date().toISOString();
const notFound = (route: Route, code: string) =>
  route.fulfill({
    status: 404,
    json: { error: { code, message: 'The original reference was not found.' } },
  });
function receipt(cash: CashReturnFixture, actorId: string) {
  const value = cash.view;
  if (!value?.attestation)
    throw new Error('Financial recording requires a durable prior attestation.');
  return correctionReceiptSchema.parse({
    id: value.correctionId,
    contract: 'pos-payment-correction-v1',
    status: 'recorded',
    orderId: cashOrderId,
    storeId: '1',
    counterId: '3',
    operatorId: actorId,
    originalPaymentId: originalCashId,
    originalPaymentHash: 'b'.repeat(64),
    transactionId: 'ORIGINAL-CASH',
    originalCash: '99.95',
    originalCashReceived: '100.00',
    originalFundingAt: '2026-11-17 12:00:00',
    orderDate: '2026-11-17',
    returnedCash: '99.95',
    cashReturnReceiptId: value.cashReturnReceiptId,
    reason: value.reason,
    recordedAt: now().slice(0, 19).replace('T', ' '),
    recordedInstant: now(),
    businessDate: value.attestation.evidence.businessDate,
    cashReturn: value.attestation.evidence,
    headerHash: 'c'.repeat(64),
    lines: [{ id: '9007199254740995', productId: '10', quantity: '2', inputHash: 'd'.repeat(64) }],
    stockChanged: false,
    benefitsChanged: false,
    providerRefunded: false,
    goodsRetainedAtCounter: true,
  });
}
/** Controlled BFF responses; actual OrdersPage and its real children make every request. */
export async function handleCashReturn(route: Route, cash: CashReturnFixture, actorId: string) {
  const req = route.request(),
    path = new URL(req.url()).pathname,
    base = `/api/v1/stores/1/orders/${cashOrderId}`;
  if (!path.includes('/cash-return-') && !path.includes('/payment-reversals')) return false;
  expect(req.headers()['x-operator-id']).toBe(actorId);
  expect(['44', '55']).toContain(actorId);
  if (req.method() === 'GET') {
    cash.reads.push({ path, actorId });
    if (path === '/api/v1/stores/1/cash-return-intents') {
      await route.fulfill({
        json: {
          data:
            cash.view && !['RECORDED', 'CANCELLED'].includes(cash.view.phase) ? [cash.view] : [],
          nextCursor: null,
        },
      });
      return true;
    }
    if (path === '/api/v1/stores/1/cash-return-claims') {
      await route.fulfill({ json: { data: [], nextCursor: null } });
      return true;
    }
    if (path === base + '/payment-reversals') {
      await route.fulfill({
        json: {
          orderId: cashOrderId,
          storeId: '1',
          counterId: '3',
          eligible: !cash.view,
          blocker: cash.view ? 'CASH_RETURN_RECONCILIATION_REQUIRED' : null,
          snapshotHash: cash.view ? null : 'a'.repeat(64),
          originalPaymentId: cash.view ? null : originalCashId,
          returnedCash: cash.view ? null : '99.95',
          latest: cash.receipt,
          activeIntent: cash.view,
        },
      });
      return true;
    }
    if (path.startsWith(base + '/payment-reversals/')) {
      if (cash.receipt) await route.fulfill({ json: cash.receipt });
      else await notFound(route, 'PAYMENT_REVERSAL_NOT_FOUND');
      return true;
    }
    if (path.startsWith(base + '/cash-return-intents/')) {
      if (!cash.view) {
        await notFound(route, 'CASH_RETURN_INTENT_NOT_FOUND');
        return true;
      }
      if (path.includes('/operations/')) {
        const operationId = z.uuid().parse(path.split('/').at(-1)),
          command = cash.commands.get(operationId);
        if (command)
          await route.fulfill({
            json: { operationId, ...command, intent: cash.view, newlyArmed: false },
          });
        else await notFound(route, 'CASH_RETURN_OPERATION_NOT_FOUND');
        return true;
      }
      await route.fulfill({ json: cash.view });
      return true;
    }
    throw new Error('Unexpected cash-return read resource.');
  }
  if (req.method() !== 'POST' || !path.startsWith(base + '/cash-return-intents'))
    throw new Error('Unexpected cash-return mutation resource.');
  const kind: Kind = path.endsWith('/armings')
      ? 'arm'
      : path.endsWith('/attestations')
        ? 'attest'
        : path.endsWith('/cancellations')
          ? 'cancel'
          : path.endsWith('/reconciliations')
            ? 'resolve'
            : 'prepare',
    input =
      kind === 'prepare'
        ? prepareReturnSchema.parse(req.postDataJSON() as unknown)
        : kind === 'attest'
          ? attestReturnSchema.parse(req.postDataJSON() as unknown)
          : kind === 'cancel'
            ? cancelReturnSchema.parse(req.postDataJSON() as unknown)
            : z
                .object({ operationId: z.uuid() })
                .strict()
                .parse(req.postDataJSON() as unknown),
    operationId = input.operationId;
  cash.writes.push({ kind, operationId, actorId, input });
  if (kind === 'resolve' && cash.holdResolution)
    await new Promise<void>((resolve) => {
      cash.releaseResolution = resolve;
    });
  const replay = cash.commands.has(operationId),
    drop = cash.drop?.kind === kind ? cash.drop : null;
  if (!drop || drop.outcome === 'committed') {
    if (!replay) {
      if (kind === 'prepare') {
        const body = prepareReturnSchema.parse(input);
        expect(cash.view).toBeNull();
        expect(body.returnedCash).toBe('99.95');
        expect(body.originalPaymentId).toBe(originalCashId);
        cash.view = {
          id: body.operationId,
          contract: 'pos-cash-return-intent-v1',
          revision: 1,
          phase: 'PREPARED',
          orderId: cashOrderId,
          storeId: '1',
          counterId: '3',
          preparedBy: actorId,
          preparedAt: now(),
          correctionId: body.correctionId,
          cashReturnReceiptId: body.cashReturnReceiptId,
          originalPaymentId: originalCashId,
          returnedCash: '99.95',
          reason: body.reason,
          armed: null,
          attestation: null,
          cancellation: null,
          resolution: null,
        };
      } else {
        const value = cash.view;
        if (!value) throw new Error('Preparation is required before this command.');
        if (kind === 'arm') {
          expect(value.phase).toBe('PREPARED');
          value.phase = 'RETURN_PENDING';
          value.armed = { actorId, at: now() };
        }
        if (kind === 'attest') {
          expect(value.phase).toBe('RETURN_PENDING');
          const body = attestReturnSchema.parse(input),
            at = now();
          value.phase = 'ATTESTED';
          value.attestation = {
            actorId,
            at,
            evidenceId: body.evidenceId,
            evidence: {
              intentId: value.id,
              attestationId: body.operationId,
              returnedBy: value.armed!.actorId,
              attestedBy: actorId,
              returnedInstant: body.returnedAt,
              returnedAt: body.returnedAt.slice(0, 19).replace('T', ' '),
              businessDate: body.returnedAt.slice(0, 10),
              businessTimezone: 'UTC',
              preparedHash: 'e'.repeat(64),
            },
          };
        }
        if (kind === 'cancel') {
          expect(value.phase).toBe('PREPARED');
          const body = cancelReturnSchema.parse(input);
          value.phase = 'CANCELLED';
          value.cancellation = {
            actorId,
            at: now(),
            reason: body.reason,
            evidenceId: body.evidenceId,
          };
        }
        if (kind === 'resolve') {
          expect(value.phase).toBe('ATTESTED');
          expect(operationId).toBe(value.correctionId);
          cash.receipt = receipt(cash, actorId);
          value.phase = 'RECORDED';
          value.resolution = { actorId, at: now(), correctionId: operationId };
        }
        value.revision++;
      }
      cash.commands.set(operationId, { kind, actorId });
    }
  }
  if (drop) {
    cash.drop = null;
    await route.abort('failed');
    return true;
  }
  await route.fulfill({
    json:
      kind === 'resolve'
        ? cash.receipt
        : { operationId, kind, actorId, intent: cash.view, newlyArmed: kind === 'arm' && !replay },
  });
  return true;
}
