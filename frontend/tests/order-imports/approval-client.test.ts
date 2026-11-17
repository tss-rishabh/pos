import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setRequestOperator } from '../../src/api/client';
import {
  checkedImportApproval,
  importApprovalResponseSchema,
  readImportApproval,
  requestImportApproval,
} from '../../src/pages/administration/order-imports/approval-client';
import {
  approvalJobId,
  approvalOperationId,
  approvalCommandId,
  approvalGrantId,
  approvalResponse,
} from './approval-fixtures';
describe('scoped import approval transport', () => {
  const scope = {
    jobId: approvalJobId,
    operationId: approvalOperationId,
    expected: {
      kind: 'offline' as const,
      storeId: '1',
      counterId: '2',
      businessDate: '2026-06-15',
    },
  };
  beforeEach(() => setRequestOperator('44'));
  afterEach(() => {
    setRequestOperator(null);
    vi.unstubAllGlobals();
  });
  it('keeps grant and command IDs separate and requires exact operation/scope/reason bindings', () => {
    const value = approvalResponse(approvalCommandId, true);
    expect(value.approval?.id).toBe(approvalGrantId);
    expect(value.approval?.id).not.toBe(approvalCommandId);
    expect(checkedImportApproval(value, '44', scope, approvalCommandId, 'late-recording')).toEqual(
      value,
    );
    for (const changed of [
      { ...value, commandId: null },
      { ...value, review: { ...value.review, operationId: crypto.randomUUID() } },
      { ...value, review: { ...value.review, storeId: '2' } },
      { ...value, approval: { ...value.approval!, counterId: '3' } },
      { ...value, approval: { ...value.approval!, reason: 'source-reconciliation' as const } },
    ])
      expect(() =>
        checkedImportApproval(changed, '44', scope, approvalCommandId, 'late-recording'),
      ).toThrow();
  });
  it('transports only command/reason and never renews during a GET', async () => {
    const requests: { path: string; method: string; body: unknown; owner: string | null }[] = [],
      fetcher = vi.fn(async (path: string, options: RequestInit) => {
        requests.push({
          path,
          method: options.method ?? 'GET',
          body: options.body ? (JSON.parse(String(options.body)) as unknown) : null,
          owner: new Headers(options.headers).get('X-Operator-ID'),
        });
        return Response.json(
          approvalResponse(
            path.endsWith(approvalCommandId) || options.method === 'POST'
              ? approvalCommandId
              : null,
            options.method === 'POST',
          ),
        );
      });
    vi.stubGlobal('fetch', fetcher);
    await readImportApproval('44', scope);
    await readImportApproval('44', scope, approvalCommandId);
    await requestImportApproval('44', scope, {
      commandId: approvalCommandId,
      reason: 'late-recording',
    });
    expect(requests.map((value) => [value.method, value.body])).toEqual([
      ['GET', null],
      ['GET', null],
      ['POST', { commandId: approvalCommandId, reason: 'late-recording' }],
    ]);
    expect(requests.every((value) => value.owner === '44')).toBe(true);
    expect(requests[1]?.path).toContain('/approvals/' + approvalCommandId);
  });
  it('rejects missing POST receipts, extra input and inconsistent one-hour expiry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(approvalResponse(approvalCommandId))),
    );
    await expect(
      requestImportApproval('44', scope, {
        commandId: approvalCommandId,
        reason: 'late-recording',
      }),
    ).rejects.toThrow(/unconfirmed/);
    const extraInput = {
      commandId: approvalCommandId,
      reason: 'late-recording' as const,
      storeId: '1',
      lineValue: '50.98',
    };
    await expect(requestImportApproval('44', scope, extraInput)).rejects.toThrow();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    const value = approvalResponse(approvalCommandId, true);
    expect(
      importApprovalResponseSchema.safeParse({
        ...value,
        approval: { ...value.approval!, expiresAt: value.approval!.issuedAt + 7200000 },
      }).success,
    ).toBe(false);
    expect(
      importApprovalResponseSchema.safeParse({ ...value, customerEmail: 'private@example.test' })
        .success,
    ).toBe(false);
  });
});
