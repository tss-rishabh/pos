import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect } from 'vitest';
import {
  correctionInputSchema,
  type CorrectionInput,
  type CorrectionReceipt,
  type CorrectionReview,
  type CorrectionFence,
} from '../../src/pages/administration/order-imports/correction-client';

export const jobId = 'd591b0a0-09e3-46d2-af31-f60de9e937b6',
  operationId = 'dd8623de-c90f-44ef-89a5-384685f1a654',
  siblingOperation = '1dc1d36a-b8dc-45f5-a67d-bdd8eb0c2fb3';
const stamp = '2026-11-17 12:00:00.000';
export function originalJob() {
  return {
    id: jobId,
    kind: 'offline',
    state: 'PARTIAL',
    totalOrders: 2,
    importedOrders: 1,
    failedOrders: 1,
    cancelledOrders: 0,
    errorCode: null,
    createdAt: stamp,
    updatedAt: stamp,
    completedAt: stamp,
  };
}
export function originalRows() {
  return [
    {
      sequence: 1,
      firstRow: 2,
      operationId,
      storeId: '1',
      counterId: '2',
      state: 'FAILED',
      orderId: null,
      receiptId: null,
      businessDate: null,
      errorCode: 'ORDER_IMPORT_ORIGINAL_TENDER_MISMATCH',
      updatedAt: stamp,
    },
    {
      sequence: 2,
      firstRow: 3,
      operationId: siblingOperation,
      storeId: '1',
      counterId: '2',
      state: 'IMPORTED',
      orderId: '9007199254741999',
      receiptId: '06996747-6d19-4519-bdd0-6de31ef57ce2',
      businessDate: '2026-06-15',
      errorCode: null,
      updatedAt: stamp,
    },
  ];
}
export function originalReview(): CorrectionReview {
  return {
    jobId,
    operationId,
    enabled: true,
    eligible: true,
    blocker: null,
    reviewHash: 'a'.repeat(64),
    original: {
      sequence: 1,
      firstRow: 2,
      state: 'FAILED',
      errorCode: 'ORDER_IMPORT_ORIGINAL_TENDER_MISMATCH',
      kind: 'offline',
      storeId: '1',
      counterId: '2',
      businessDateTime: '2026-06-15 12:00:00',
      payment: 'cash',
      lineValue: '50.98',
      lines: [{ row: 2, productId: '9007199254740993', quantity: 2, unitPrice: '25.49' }],
    },
    calculation: {
      payable: '50.00',
      calculationHash: 'b'.repeat(64),
      profileQualified: true,
      profileCode: null,
    },
    successor: null,
  };
}
export async function correctionBrowserFixture(page: Page) {
  page.setDefaultTimeout(7000);
  const state = {
    review: originalReview(),
    posts: [] as CorrectionInput[],
    gets: [] as string[],
    otherMutations: [] as string[],
    approvals: [] as { commandId: string; reason: string }[],
    receipts: new Map<string, CorrectionReceipt>(),
    fences: new Map<string, CorrectionFence>(),
    drop: 'none' as 'none' | 'before' | 'after',
    recovery: 'native' as 'native' | '404' | '500',
    successorReadFails: false,
    errors: [] as string[],
  };
  page.on('pageerror', (error) => state.errors.push(error.message));
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname,
      method = request.method(),
      owner = request.headers()['x-operator-id'];
    if (owner !== '44')
      return route.fulfill({
        status: 403,
        json: { error: { code: 'STORE_ACCESS_DENIED', message: 'Current manager scope changed.' } },
      });
    if (method === 'GET') state.gets.push(path);
    if (path.endsWith('/capabilities'))
      return route.fulfill({
        json: {
          ready: true,
          canPreview: true,
          kinds: ['offline', 'shopify'],
          maximumFileBytes: 5242880,
          maximumRows: 50000,
          maximumStores: 100,
        },
      });
    const command = /\/orders\/([^/]+)\/corrections\/([^/]+)$/.exec(path),
      base = /\/orders\/([^/]+)\/corrections$/.exec(path);
    if (command && method === 'GET') {
      if (state.recovery !== 'native')
        return route.fulfill({
          status: Number(state.recovery),
          json: { error: { code: 'UNCONFIRMED', message: 'The original outcome is unconfirmed.' } },
        });
      const id = command[2]!,
        receipt = state.receipts.get(id);
      if (receipt) return route.fulfill({ json: { status: 'accepted', receipt } });
      const fence = state.fences.get(id) ?? {
        contract: 'pos-import-correction-command-v1' as const,
        status: 'not-created' as const,
        id,
        originalJobId: jobId,
        originalOperationId: operationId,
        managerId: '44',
        recordedAt: Date.now(),
        noSuccessorQueued: true as const,
        latePostsFenced: true as const,
      };
      state.fences.set(id, fence);
      return route.fulfill({ json: fence });
    }
    if (base) {
      if (method === 'GET')
        return route.fulfill({
          json: { ...state.review, successor: [...state.receipts.values()].at(-1) ?? null },
        });
      const input = correctionInputSchema.parse(request.postDataJSON() as unknown);
      state.posts.push(input);
      const saved = await page.evaluate(() =>
        Object.entries(localStorage)
          .filter(([key]) => key.startsWith('pos-order-import-correction:'))
          .map(([, value]) => value),
      );
      expect(saved.some((raw) => (JSON.parse(raw) as { id: string }).id === input.id)).toBe(true);
      expect(saved.join('')).not.toMatch(
        /historicalTenderAmount|unitPrice|csv|email|25\.49|50\.98/,
      );
      if (state.fences.has(input.id))
        return route.fulfill({
          status: 409,
          json: {
            error: {
              code: 'ORDER_IMPORT_CORRECTION_COMMAND_FENCED',
              message: 'The original command was fenced.',
            },
          },
        });
      if (state.drop === 'before') return route.abort('failed');
      const receipt: CorrectionReceipt = {
        id: input.id,
        originalJobId: jobId,
        originalOperationId: operationId,
        successorJobId: input.successorJobId,
        successorOperationId: input.successorOperationId,
        managerId: '44',
        originalLineValue: state.review.original.lineValue,
        correctedLineValue: state.review.original.lineValue,
        historicalTenderAmount: input.historicalTenderAmount,
        recordedAt: Date.now(),
        requiresApproval: true,
        financialExecution: 'pending-approval',
      };
      state.receipts.set(input.id, receipt);
      if (state.drop === 'after') return route.abort('failed');
      return route.fulfill({ status: 202, json: receipt });
    }
    const approval = /\/orders\/([^/]+)\/approvals(?:\/([^/]+))?$/.exec(path);
    if (approval) {
      const receipt = [...state.receipts.values()].find(
        (value) => value.successorOperationId === approval[1],
      );
      if (!receipt)
        return route.fulfill({
          status: 404,
          json: { error: { code: 'NOT_FOUND', message: 'No approval scope.' } },
        });
      let commandId = approval[2] ?? null;
      if (method === 'POST') {
        const body = request.postDataJSON() as { commandId: string; reason: string };
        state.approvals.push(body);
        commandId = body.commandId;
      }
      const prior = commandId
          ? state.approvals.find((value) => value.commandId === commandId)
          : null,
        issuedAt = Date.now();
      return route.fulfill({
        json: {
          commandId,
          review: {
            operationId: receipt.successorOperationId,
            kind: 'offline',
            storeId: '1',
            counterId: '2',
            businessDate: '2026-06-15',
            currency: 'INR',
            lineValue: receipt.correctedLineValue,
            correction: {
              id: receipt.id,
              historicalTenderAmount: receipt.historicalTenderAmount,
              sourcePayable: state.review.calculation!.payable,
            },
            lines: state.review.original.lines.map((line) => ({
              productId: line.productId,
              quantity: line.quantity,
              unitPrice: line.unitPrice,
            })),
          },
          approval: prior
            ? {
                id: randomUUID(),
                operationId: receipt.successorOperationId,
                actorId: '44',
                storeId: '1',
                counterId: '2',
                planHash: 'c'.repeat(64),
                businessDate: '2026-06-15',
                approverId: '44',
                reason: prior.reason,
                issuedAt,
                expiresAt: issuedAt + 3600000,
                close: null,
                status: 'approved',
              }
            : null,
        },
      });
    }
    const receipt = [...state.receipts.values()].find((value) =>
      path.includes(value.successorJobId),
    );
    if (method === 'GET' && path.endsWith('/results'))
      return route.fulfill({
        json: {
          data: receipt
            ? [
                {
                  ...originalRows()[0]!,
                  operationId: receipt.successorOperationId,
                  state: 'PENDING',
                  errorCode: 'ORDER_IMPORT_APPROVAL_REQUIRED',
                },
              ]
            : originalRows(),
          nextAfter: null,
        },
      });
    if (method === 'GET' && path === '/api/v1/admin/order-imports/' + jobId)
      return route.fulfill({ json: originalJob() });
    if (receipt && method === 'GET') {
      if (state.successorReadFails)
        return route.fulfill({
          status: 503,
          json: {
            error: {
              code: 'SOURCE_UNAVAILABLE',
              message: 'The successor status is temporarily unavailable.',
            },
          },
        });
      return route.fulfill({
        json: {
          ...originalJob(),
          id: receipt.successorJobId,
          state: 'QUEUED',
          totalOrders: 1,
          importedOrders: 0,
          failedOrders: 0,
          errorCode: 'ORDER_IMPORT_APPROVAL_REQUIRED',
          completedAt: null,
        },
      });
    }
    if (method !== 'GET') state.otherMutations.push(path);
    return route.fulfill({
      status: 404,
      json: { error: { code: 'NOT_FOUND', message: 'Unknown fixture resource.' } },
    });
  });
  return state;
}
