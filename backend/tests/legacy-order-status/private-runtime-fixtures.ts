import { createHmac } from 'node:crypto';
import { command, options } from './fixtures.js';

export function privateRuntimeEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    SESSION_SECRET: 'synthetic-private-runtime-session-'.repeat(2),
    MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
    MYSQL_WRITER_URL: 'mysql://root@127.0.0.1/pos_rewrite_whole_status_test',
    MYSQL_PRIMARY_READER_URL: 'mysql://root@127.0.0.1/pos_rewrite_whole_status_test',
    MYSQL_DATA_READER_URL: 'mysql://root@127.0.0.1/pos_rewrite_whole_status_test',
    WHOLE_ORDER_STATUS_RECEIVER_ENABLED: 'true',
    WHOLE_ORDER_STATUS_RECEIVER_PORT: '0',
    WHOLE_ORDER_STATUS_CONTRACT: options.WHOLE_ORDER_STATUS_CONTRACT,
    BACKEND_SYNC_API_BASE_URL: options.BACKEND_SYNC_API_BASE_URL,
    BACKEND_SYNC_REPO_API_KEY: options.BACKEND_SYNC_REPO_API_KEY,
    WHOLE_ORDER_STATUS_RECEIPT_KEY: options.WHOLE_ORDER_STATUS_RECEIPT_KEY,
    WHOLE_ORDER_STATUS_VENDOR_SHIPPED_URL: 'https://vendor.synthetic.invalid/status',
    WHOLE_ORDER_STATUS_VENDOR_DELIVERED_URL: 'https://vendor.synthetic.invalid/deliver',
    WHOLE_ORDER_STATUS_VENDOR_API_OWNER: 'synthetic-owner',
    WHOLE_ORDER_STATUS_VENDOR_API_KEY: 'synthetic-vendor-key',
    TSS_EVENTS_URL: 'https://events.synthetic.invalid',
    TSS_EVENTS_APP_ID: 'synthetic-app',
    TSS_EVENTS_APP_KEY: 'synthetic-events-key',
    POS_PAYMENT_CORRECTION_PROOF_KEY_V1: 'synthetic-cash-return-proof-key-'.repeat(2),
    LEGACY_ORDER_IMPORT_ENCRYPTION_KEY_V1: 'synthetic-import-proof-key-'.repeat(2),
    ...extra,
  };
}

export function privateReceiverHeaders(value = command) {
  const scope = Buffer.from(
    JSON.stringify({
      contract: 'pos-whole-order-status-v1',
      operationId: value.id,
      operatorId: value.operatorId,
      authVersion: value.authVersion,
      storeId: value.storeId,
      counterId: value.snapshot.counterId,
      scopeHash: value.scopeHash,
      requestHash: value.requestHash,
      requestId: value.requestId,
    }),
  ).toString('base64url');
  return {
    'x-api-key': options.BACKEND_SYNC_REPO_API_KEY!,
    'idempotency-key': value.id,
    'x-pos-status-scope': scope,
    'x-pos-status-proof': createHmac('sha256', options.WHOLE_ORDER_STATUS_RECEIPT_KEY!)
      .update('pos-whole-order-status-request-v1\0' + scope)
      .digest('base64url'),
  };
}
