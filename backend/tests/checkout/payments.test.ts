import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import {
  paymentAttemptSchema,
  paymentInputSchema,
  type PaymentAttempt,
  type PaytmTerminal,
} from '../../src/modules/checkout/payments/contracts.js';
import {
  paytmBody,
  paytmDecision,
  pythonJson,
  terminalGateway,
} from '../../src/modules/checkout/payments/gateway.js';
import {
  legacyPaymentSourceHash,
  type LegacyTerminalRecord,
} from '../../src/modules/checkout/payments/legacy.js';
import { operationHash } from '../../src/modules/checkout/crypto.js';
import { validatePaymentSplit } from '../../src/modules/checkout/payments/repository.js';
import {
  pineUploadPayload,
  pineStatusPayload,
  pineCancelPayload,
} from '../../src/modules/checkout/payloads.js';

const attempt: PaymentAttempt = paymentAttemptSchema.parse({
  id: crypto.randomUUID(),
  operatorId: '44',
  storeId: '1',
  counterId: '3',
  orderId: '8002',
  channel: 'paytm-card',
  onlineAmount: '59.95',
  cashAmount: '40.00',
  cashReceived: '100.00',
  machineId: '2',
  externalReference: null,
  transactionId: 'FIXTURE8002',
  providerReference: null,
  status: 'pending',
  busyOperationId: null,
  requestHash: '0'.repeat(64),
  errorCode: null,
  createdAt: '2026-11-16 12:00:00',
  updatedAt: '2026-11-16 12:00:00',
});
const machine: PaytmTerminal = {
  provider: 'paytm',
  id: '2',
  merchantKey: 'fixture-key-1234',
  mid: 'fixture-mid',
  tid: 'fixture-tid',
  channelId: 'fixture-channel',
};
describe('payment source parity and provider evidence', () => {
  it('matches six source-extracted Pine Labs and Paytm dispatch/status/cancel payloads', () => {
    const oracle: unknown = JSON.parse(
      execFileSync('python3', ['tools/checkout/legacy_oracle.py'], {
        input: JSON.stringify({ operation: 'terminal_payloads' }),
        encoding: 'utf8',
      }),
    );
    const pine = {
        merchantId: 'fixture-merchant',
        securityToken: 'fixture-secret',
        clientId: 'fixture-client',
        storePosCode: 'fixture-store',
      },
      calls: { path: string; payload: Record<string, unknown> }[] = [
        {
          path: 'V1/UploadBilledTransaction',
          payload: pineUploadPayload(pine, 'FIXTURE8002', '59.95', 1, '44', 5),
        },
        { path: 'V1/GetCloudBasedTxnStatus', payload: pineStatusPayload(pine, 'PLUTUS') },
        {
          path: 'V1/CancelTransaction',
          payload: pineCancelPayload(pine, 'PLUTUS', '59.95', false),
        },
        {
          path: 'V1/CancelTransactionForced',
          payload: pineCancelPayload(pine, 'PLUTUS', '59.95', true),
        },
      ],
      checksums: string[] = [];
    for (const channel of ['paytm-card', 'paytm-qr'] as const) {
      const body = paytmBody({ ...attempt, channel }, machine, '2026-11-16 12:00:00', true);
      checksums.push(pythonJson(body));
      calls.push({
        path: 'payment/request',
        payload: {
          head: {
            requestTimeStamp: '2026-11-16 12:00:00',
            channelId: machine.channelId,
            checksum: 'fixture-checksum',
            version: '3.1',
          },
          body,
        },
      });
    }
    expect({ calls, checksums }).toEqual(oracle);
  });
  it('requires provider settlement evidence to match merchant, terminal, transaction and amount', () => {
    const body = {
      paytmMid: machine.mid,
      paytmTid: machine.tid,
      merchantTransactionId: attempt.transactionId,
      transactionAmount: '5995',
      resultInfo: { resultCodeId: '0000' },
    };
    expect(paytmDecision({ body }, attempt, machine, false).status).toBe('paid');
    for (const mismatch of [
      { paytmMid: 'another-mid' },
      { paytmTid: 'another-terminal' },
      { merchantTransactionId: 'another-transaction' },
      { transactionAmount: '5994' },
    ])
      expect(() =>
        paytmDecision({ body: { ...body, ...mismatch } }, attempt, machine, false),
      ).toThrow('did not match');
    expect(
      paytmDecision({ body: { resultInfo: { resultCodeId: '0009' } } }, attempt, machine, true)
        .status,
    ).toBe('pending');
    for (const resultCodeId of ['0010', '0030', '0404', '0330', 'unknown'])
      expect(
        paytmDecision({ body: { resultInfo: { resultCodeId } } }, attempt, machine, false).status,
      ).not.toBe('paid');
  });
  it('validates exact cents, cash received, terminal assignment and external references before dispatch', () => {
    const input = paymentInputSchema.parse({
      operationId: crypto.randomUUID(),
      channel: 'cash',
      onlineAmount: '0.00',
      cashAmount: '0.30',
      cashReceived: '1.00',
    });
    expect(() => validatePaymentSplit(input, '0.30')).not.toThrow();
    expect(() => validatePaymentSplit(input, '0.31')).toThrow('authoritative');
    expect(() => validatePaymentSplit({ ...input, cashReceived: '0.29' }, '0.30')).toThrow(
      'Cash received',
    );
    expect(() =>
      validatePaymentSplit(
        { ...input, channel: 'pine-card', onlineAmount: '0.10', cashAmount: '0.20' },
        '0.30',
      ),
    ).toThrow('terminal');
    expect(() =>
      validatePaymentSplit(
        { ...input, channel: 'district', onlineAmount: '0.10', cashAmount: '0.20' },
        '0.30',
      ),
    ).toThrow('external transaction');
    expect(() => paymentInputSchema.parse({ ...input, is_verified: true })).toThrow();
  });
  it('does not equate a terminal upload or ambiguous cancellation with payment or cancellation', async () => {
    const config = readConfig({
        NODE_ENV: 'test',
        DEMO_MODE: 'true',
        SESSION_SECRET: 'fixture-payment-secret-'.repeat(3),
      }),
      responses = [
        { ResponseCode: 0, ResponseMessage: 'APPROVED', PlutusTransactionReferenceID: 'PLUTUS' },
        { ResponseCode: 1, ResponseMessage: 'CANNOT CANCEL AS TRANSACTION IS IN PROGRESS' },
      ],
      gateway = terminalGateway(
        config,
        { pineBaseUrl: 'https://provider.example.test/', autoCancelMinutes: 5 },
        async () =>
          new Response(JSON.stringify(responses.shift()), {
            headers: { 'Content-Type': 'application/json' },
          }),
      );
    const pine = {
        provider: 'pine' as const,
        id: '1',
        merchantId: 'fixture',
        securityToken: 'secret',
        clientId: 'fixture',
        storePosCode: 'fixture',
        imei: 'fixture',
      },
      state = { ...attempt, channel: 'pine-card' as const };
    const uploaded = await gateway.start(state, pine);
    expect(uploaded.status).toBe('pending');
    expect((await gateway.cancel({ ...state, providerReference: 'PLUTUS' }, pine)).status).toBe(
      'uncertain',
    );
    expect(() => gateway.cancel(attempt, machine)).toThrow('Cancel or void');
  });
});

describe('versioned legacy terminal source fingerprints', () => {
  const secret = 'isolated-fingerprint-secret-'.repeat(3);
  const row: LegacyTerminalRecord = {
    provider: 'pine',
    id: '9007199254740993',
    storeId: '1',
    transactionId: 'OLD1',
    providerReference: null,
    storePosCode: 'fixture',
    imei: 'device',
    mid: '',
    tid: '',
    onlineAmount: '59.95',
    cashAmount: '40.00',
    cashReceived: '100.00',
    paymentMode: 1,
    platform: 'txn_created',
  };
  it('hashes only versioned financial and terminal fields, independently of SELECT aliases', () => {
    const selected = {
      ...row,
      reference: '',
      code: 'fixture',
      api_response: 'must-not-enter-hash',
    };
    expect(legacyPaymentSourceHash(selected, secret, 1)).toBe(
      legacyPaymentSourceHash(row, secret, 1),
    );
    for (const changed of [
      { onlineAmount: '59.94' },
      { storeId: '2' },
      { providerReference: 'another-reference' },
      { imei: 'another-device' },
      { platform: 'txn_completed' },
    ])
      expect(legacyPaymentSourceHash({ ...row, ...changed }, secret, 1)).not.toBe(
        legacyPaymentSourceHash(row, secret, 1),
      );
  });
  it('verifies initial versionless Pine aliases and Paytm records without changing their stored contract', () => {
    expect(legacyPaymentSourceHash(row, secret)).toBe(
      operationHash('payment.legacy.source', { ...row, reference: '', code: 'fixture' }, secret),
    );
    const paytm: LegacyTerminalRecord = {
      ...row,
      provider: 'paytm',
      providerReference: 'OLD1',
      storePosCode: '',
      imei: '',
      mid: 'merchant',
      tid: 'terminal',
      paymentMode: 1003,
    };
    expect(legacyPaymentSourceHash(paytm, secret)).toBe(
      operationHash('payment.legacy.source', paytm, secret),
    );
    expect(legacyPaymentSourceHash(row, secret)).not.toBe(legacyPaymentSourceHash(row, secret, 1));
  });
});
