import { readConfig } from '../../src/config.js';
import { readWholeOrderStatusOptions } from '../../src/modules/legacy-order-status/options.js';
import {
  wholeOrderStatusContract,
  immutableScopeHash,
  statusDigest,
  sourceStatusBody,
  statusCapabilitySchema,
  statusCapabilitySignature,
  type StatusSnapshot,
  type StatusReceipt,
} from '../../src/modules/legacy-order-status/domain.js';
import type { StatusCommand } from '../../src/modules/legacy-order-status/transport.js';
export const config = readConfig({
  NODE_ENV: 'test',
  SESSION_SECRET: 'synthetic-status-session-key-'.repeat(2),
  MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
  MYSQL_PRIMARY_READER_URL: 'mysql://root@127.0.0.1/pos_rewrite_whole_status_test',
  MYSQL_WRITER_URL: 'mysql://root@127.0.0.1/pos_rewrite_whole_status_test',
});
export const options = readWholeOrderStatusOptions({
  WHOLE_ORDER_STATUS_CONTRACT: wholeOrderStatusContract,
  BACKEND_SYNC_API_BASE_URL: 'https://sync.synthetic.invalid/api/',
  BACKEND_SYNC_REPO_API_KEY: 'synthetic-private-sync-key',
  WHOLE_ORDER_STATUS_RECEIPT_KEY: 'synthetic-status-receipt-key-'.repeat(2),
});
export const snapshot: StatusSnapshot = {
  orderId: '9007199254740993',
  customerId: '7',
  storeId: '1',
  counterId: '1',
  reference: 'SYNTHETIC-STATUS',
  locationCode: 'SYN',
  storeRowIds: ['11'],
  lines: [
    { id: '9007199254741001', productId: '501', subProductId: '0', quantity: '3' },
    { id: '9007199254741002', productId: '501', subProductId: '0', quantity: '1' },
    { id: '9007199254741003', productId: '999', subProductId: '0', quantity: '0' },
  ],
};
export const command: StatusCommand = {
  id: '4918d168-c62e-4ed7-b8ae-89b0a5e70019',
  effectKey: statusDigest([snapshot.orderId, 'PACK', immutableScopeHash(snapshot)]),
  operatorId: '1',
  authVersion: 'a'.repeat(64),
  storeId: '1',
  orderId: snapshot.orderId,
  platform: 'PACK',
  source: 'manual',
  returnOperationId: null,
  requestId: 'synthetic-status-request',
  snapshot,
  scopeHash: immutableScopeHash(snapshot),
  requestHash: statusDigest(sourceStatusBody(snapshot, 'PACK')),
  state: 'SENDING',
  attempts: 1,
  receipt: null,
  errorCode: null,
  claimedAt: '2026-11-17 06:00:00.000',
  createdAt: '2026-11-17 06:00:00.000',
  updatedAt: '2026-11-17 06:00:00.000',
};
export function queuedReceipt(value: StatusCommand = command): StatusReceipt {
  return {
    contract: wholeOrderStatusContract,
    operationId: value.id,
    requestHash: value.requestHash,
    scopeHash: value.scopeHash,
    state: 'queued',
    acceptedAt: '2026-11-17T06:00:00Z',
    completedAt: null,
    taskId: 'synthetic-task-001',
    stages: [],
  };
}
export function capabilityResponse(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
  value: StatusCommand = command,
) {
  if (!String(input).endsWith('/capabilities')) return null;
  const body = statusCapabilitySchema.parse({
    contract: wholeOrderStatusContract,
    profile: 'pinned-store-chain-v1',
    sourcePin: '70b80159016db39a73572f80bfa87c47201c0a9f',
    operationId: value.id,
    scopeHash: value.scopeHash,
    requestHash: value.requestHash,
    challenge: new Headers(init?.headers).get('x-pos-status-challenge'),
  });
  return Response.json(body, {
    headers: {
      'x-pos-status-capability': statusCapabilitySignature(
        options.WHOLE_ORDER_STATUS_RECEIPT_KEY!,
        body,
      ),
    },
  });
}
