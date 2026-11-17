import type { ImportApprovalIntent } from '../../src/pages/administration/order-imports/approval-journal';
import type {
  ImportApprovalResponse,
  ImportApprovalReason,
} from '../../src/pages/administration/order-imports/approval-client';
import type {
  OrderImportJob,
  OrderImportResult,
} from '../../src/pages/administration/order-imports/client';
export const approvalJobId = '11111111-1111-4111-8111-111111111111',
  approvalOperationId = '22222222-2222-4222-8222-222222222222',
  approvalCommandId = '33333333-3333-4333-8333-333333333333',
  approvalGrantId = '44444444-4444-4444-8444-444444444444';
export const approvalIntent = (
  changes: Partial<ImportApprovalIntent> = {},
): ImportApprovalIntent => ({
  version: 1,
  operatorId: '44',
  jobId: approvalJobId,
  operationId: approvalOperationId,
  commandId: approvalCommandId,
  reason: 'late-recording',
  ...changes,
});
export const approvalResult = (changes: Partial<OrderImportResult> = {}): OrderImportResult => ({
  sequence: 1,
  firstRow: 2,
  operationId: approvalOperationId,
  storeId: '1',
  counterId: '2',
  state: 'PENDING',
  orderId: null,
  receiptId: null,
  businessDate: '2026-06-15',
  errorCode: 'ORDER_IMPORT_APPROVAL_REQUIRED',
  updatedAt: '2026-11-17 12:00:00',
  ...changes,
});
export const approvalJob = (changes: Partial<OrderImportJob> = {}): OrderImportJob => ({
  id: approvalJobId,
  kind: 'offline',
  state: 'QUEUED',
  totalOrders: 1,
  importedOrders: 0,
  failedOrders: 0,
  cancelledOrders: 0,
  errorCode: 'ORDER_IMPORT_APPROVAL_REQUIRED',
  createdAt: '2026-11-17 12:00:00',
  updatedAt: '2026-11-17 12:00:00',
  completedAt: null,
  ...changes,
});
export function approvalResponse(
  commandId: string | null = null,
  grant = false,
  reason: ImportApprovalReason = 'late-recording',
  operationId = approvalOperationId,
): ImportApprovalResponse {
  const issuedAt = Date.now();
  return {
    commandId,
    review: {
      operationId,
      kind: 'offline',
      storeId: '1',
      counterId: '2',
      businessDate: '2026-06-15',
      currency: 'INR',
      lineValue: '50.98',
      lines: [{ productId: '9007199254740993', quantity: 2, unitPrice: '25.49' }],
    },
    approval: grant
      ? {
          id: approvalGrantId,
          operationId,
          actorId: '44',
          storeId: '1',
          counterId: '2',
          planHash: 'a'.repeat(64),
          businessDate: '2026-06-15',
          approverId: '44',
          reason,
          issuedAt,
          expiresAt: issuedAt + 3600000,
          close: { id: '123', version: 1, status: 'CLOSED' },
          status: 'approved',
        }
      : null,
  };
}
