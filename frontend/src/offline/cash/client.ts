import { post, request } from '../../api/client';
import {
  cashAuthorizationBundleSchema,
  cashDeviceRegistrationReplySchema,
  cashReceiptAcceptanceSchema,
  cashReceiptDetailSchema,
  cashReceiptPageSchema,
  type DevicePublicKey,
  type SignedCashReceipt,
} from './contracts';

const root = (storeId: string) => `/api/v1/stores/${encodeURIComponent(storeId)}`;
export const registerCashDevice = (
  operatorId: string,
  storeId: string,
  counterId: string,
  deviceId: string,
  publicKey: DevicePublicKey,
) =>
  post(
    root(storeId) + '/offline-cash-devices',
    { counterId, deviceId, publicKey },
    cashDeviceRegistrationReplySchema,
    operatorId,
  );
export const requestCashAuthorization = (
  operatorId: string,
  storeId: string,
  counterId: string,
  deviceId: string,
  productIds: string[],
) =>
  post(
    root(storeId) + '/offline-cash-authorizations',
    { deviceId, counterId, productIds },
    cashAuthorizationBundleSchema,
    operatorId,
  );
export const acceptCashReceipt = (
  operatorId: string,
  storeId: string,
  envelope: SignedCashReceipt,
  options: { signal?: AbortSignal } = {},
) =>
  request(
    root(storeId) + '/offline-cash-receipts',
    { method: 'POST', body: JSON.stringify(envelope), operatorId, signal: options.signal },
    cashReceiptAcceptanceSchema,
  );
export const readCashReceipt = (
  operatorId: string,
  storeId: string,
  receiptId: string,
  options: { signal?: AbortSignal } = {},
) =>
  request(
    root(storeId) + '/offline-cash-receipts/' + encodeURIComponent(receiptId),
    { operatorId, signal: options.signal },
    cashReceiptDetailSchema,
  );
export const listCashReceipts = (
  operatorId: string,
  storeId: string,
  status: 'accepted' | 'conflicted' | 'importing' | 'imported',
  cursor: { acceptedAt: number; receiptId: string } | null = null,
) =>
  request(
    root(storeId) +
      '/offline-cash-receipts?' +
      new URLSearchParams({
        status,
        limit: '25',
        ...(cursor ? { after: String(cursor.acceptedAt), afterId: cursor.receiptId } : {}),
      }),
    { operatorId },
    cashReceiptPageSchema,
  );
export const acknowledgeCashReceipt = (
  operatorId: string,
  storeId: string,
  receiptId: string,
  operationId: string,
  expectedVersion: number,
  reason: string,
) =>
  post(
    root(storeId) + '/offline-cash-receipts/' + encodeURIComponent(receiptId) + '/manager-reviews',
    { operationId, expectedVersion, reason },
    cashReceiptAcceptanceSchema,
    operatorId,
  );
export interface CashImportApprovalRequest {
  operationId: string;
  expectedVersion: number;
  reason: string;
  orderCreatedAt?: string;
}
export interface CashOrderImportRequest {
  operationId: string;
  expectedVersion: number;
  approvalId?: string;
}
export const approveCashReceiptImport = (
  operatorId: string,
  storeId: string,
  receiptId: string,
  input: CashImportApprovalRequest,
) =>
  post(
    root(storeId) + '/offline-cash-receipts/' + encodeURIComponent(receiptId) + '/import-approvals',
    input,
    cashReceiptAcceptanceSchema,
    operatorId,
  );
export const importCashReceiptOrder = (
  operatorId: string,
  storeId: string,
  receiptId: string,
  input: CashOrderImportRequest,
  options: { signal?: AbortSignal } = {},
) =>
  request(
    root(storeId) + '/offline-cash-receipts/' + encodeURIComponent(receiptId) + '/order-imports',
    { method: 'POST', body: JSON.stringify(input), operatorId, signal: options.signal },
    cashReceiptAcceptanceSchema,
  );
