import { describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import {
  PaymentOutcomeUnknown,
  channelForMode,
  paymentInputSchema,
  paymentModeOf,
  type PaytmTerminal,
  type PineTerminal,
} from '../../src/modules/checkout/payments/contracts.js';
import {
  paytmBody,
  pythonJson,
  terminalGateway,
} from '../../src/modules/checkout/payments/gateway.js';
import {
  classifyPaytmRequest,
  classifyPaytmStatus,
  classifyPineCancel,
  classifyPineStatus,
  classifyPineUpload,
  legacyPayDict,
  legacyPaymentMessage,
  legacyTransactionId,
  pythonFloat,
  pythonRepr,
} from '../../src/modules/checkout/payments/legacy.js';
import { validatePaymentSplit } from '../../src/modules/checkout/payments/repository.js';
import {
  pineUploadPayload,
  pineStatusPayload,
  pineCancelPayload,
} from '../../src/modules/checkout/payloads.js';
import { goldenStdout } from '../golden/load.js';

const paytm: PaytmTerminal = {
  provider: 'paytm',
  id: '2',
  merchantKey: 'fixture-key-1234',
  mid: 'fixture-mid',
  tid: 'fixture-tid',
  channelId: 'fixture-channel',
};
const pine: PineTerminal = {
  provider: 'pine',
  id: '1',
  merchantId: 'fixture',
  securityToken: 'secret',
  clientId: 'fixture',
  storePosCode: 'fixture',
  imei: 'fixture',
};
const reply = (responseMessage: string, responseCode: number | null = 1) => ({
  responseCode,
  responseMessage,
  plutusId: 'PLUTUS',
  apiResponse: '',
});
const paytmReply = (resultCode: string) => ({ resultCode, resultMessage: '', apiResponse: '' });

describe('payment source parity', () => {
  it('matches six source-extracted Pine Labs and Paytm dispatch/status/cancel payloads', () => {
    const oracle: unknown = JSON.parse(
      goldenStdout('checkout', 'payments', JSON.stringify({ operation: 'terminal_payloads' })),
    );
    const machine = {
        merchantId: 'fixture-merchant',
        securityToken: 'fixture-secret',
        clientId: 'fixture-client',
        storePosCode: 'fixture-store',
      },
      calls: { path: string; payload: Record<string, unknown> }[] = [
        {
          path: 'V1/UploadBilledTransaction',
          payload: pineUploadPayload(machine, 'FIXTURE8002', '59.95', 1, '44', 5),
        },
        { path: 'V1/GetCloudBasedTxnStatus', payload: pineStatusPayload(machine, 'PLUTUS') },
        {
          path: 'V1/CancelTransaction',
          payload: pineCancelPayload(machine, 'PLUTUS', '59.95', false),
        },
        {
          path: 'V1/CancelTransactionForced',
          payload: pineCancelPayload(machine, 'PLUTUS', '59.95', true),
        },
      ],
      checksums: string[] = [];
    for (const mode of ['CARD', 'QR'] as const) {
      const body = paytmBody(paytm, 'FIXTURE8002', '2026-11-16 12:00:00', {
        onlineAmount: '59.95',
        mode,
      });
      checksums.push(pythonJson(body));
      calls.push({
        path: 'payment/request',
        payload: {
          head: {
            requestTimeStamp: '2026-11-16 12:00:00',
            channelId: paytm.channelId,
            checksum: 'fixture-checksum',
            version: '3.1',
          },
          body,
        },
      });
    }
    expect({ calls, checksums }).toEqual(oracle);
    // terminal_helpers.py:455-459: the status body carries no terminal id.
    expect(Object.keys(paytmBody(paytm, 'T1', '2026-11-16 12:00:00'))).toEqual([
      'paytmMid',
      'transactionDateTime',
      'merchantTransactionId',
    ]);
  });
  it('treats definitive terminal rejections as re-initiable failures, as legacy does', () => {
    expect(classifyPineUpload(reply('APPROVED', 0))).toMatchObject({
      status: 'pending',
      legacyStatus: 'Approved',
    });
    for (const [message, legacy] of [
      ['PLEASE APPROVE OPEN TXN FIRST', 'Open'],
      ['TXN ALREADY COMPLETED', 'Already Completed'],
      ['INVALID MERCHANT', 'Invalid Merchant'],
      ['SOMETHING ELSE', 'SOMETHING ELSE'],
      ['Failed', 'Failed'],
    ] as const)
      expect(classifyPineUpload(reply(message))).toMatchObject({
        status: 'failed',
        legacyStatus: legacy,
      });
    expect(classifyPaytmRequest(paytmReply('0009')).status).toBe('pending');
    for (const [code, legacy] of [
      ['0333', 'Open'],
      ['0233', 'Duplicate Order ID'],
      ['0007', 'Terminal Not In Active State'],
      ['0002', 'Request parameters are not valid'],
    ] as const)
      expect(classifyPaytmRequest(paytmReply(code))).toMatchObject({
        status: 'failed',
        legacyStatus: legacy,
      });
    expect(classifyPineStatus(reply('INVALID PLUTUS TXN REF ID'))).toEqual({
      status: 'failed',
      legacyStatus: 'INVALID PLUTUS ID',
      message: 'Time Out, Initialize Transaction Again',
    });
    expect(classifyPineStatus(reply('TXN APPROVED')).status).toBe('paid');
    expect(classifyPineStatus(reply('TXN UPLOADED')).status).toBe('pending');
    expect(classifyPineStatus(reply('OTHER')).legacyStatus).toBe('Failed');
    expect(classifyPaytmStatus(paytmReply('0000')).status).toBe('paid');
    expect(classifyPaytmStatus(paytmReply('0404')).status).toBe('failed');
    expect(classifyPaytmStatus(paytmReply('0010')).status).toBe('pending');
    expect(classifyPineCancel(reply('APPROVED', 0))?.status).toBe('cancelled');
    expect(classifyPineCancel(reply('TRANSACTION NOT FOUND'))?.status).toBe('pending');
    expect(classifyPineCancel(reply('Failed', null))).toBeNull();
  });
  it('keeps only timeouts, transport errors, 5xx and unreadable replies unknown', async () => {
    const config = readConfig({
      NODE_ENV: 'test',
      DEMO_MODE: 'true',
      SESSION_SECRET: 'fixture-payment-secret-'.repeat(3),
    });
    const gatewayWith = (respond: () => Promise<Response>) =>
      terminalGateway(
        config,
        { pineBaseUrl: 'https://provider.example.test/', autoCancelMinutes: 5 },
        respond,
      );
    const json = (value: unknown, status = 200) =>
      Promise.resolve(
        new Response(JSON.stringify(value), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    const upload = (gateway: ReturnType<typeof gatewayWith>) =>
      gateway.pineUpload(pine, 'T1', '10.00', 1, '44');
    await expect(
      upload(gatewayWith(() => json({ ResponseCode: 1, ResponseMessage: 'INVALID MERCHANT' }))),
    ).resolves.toMatchObject({ responseMessage: 'INVALID MERCHANT' });
    await expect(upload(gatewayWith(() => json({}, 401)))).resolves.toMatchObject({
      responseMessage: 'Failed',
    });
    for (const respond of [
      () => json({}, 503),
      () => Promise.resolve(new Response('not json')),
      () => json({ ResponseCode: 0, ResponseMessage: 'APPROVED' }),
      () => Promise.reject(new TypeError('fetch failed')),
    ])
      await expect(upload(gatewayWith(respond))).rejects.toBeInstanceOf(PaymentOutcomeUnknown);
    const approved = await upload(
      gatewayWith(() =>
        json({ ResponseCode: 0, ResponseMessage: 'APPROVED', PlutusTransactionReferenceID: 77 }),
      ),
    );
    expect(approved).toMatchObject({ plutusId: '77' });
    expect(approved.apiResponse).toBe(
      "{'ResponseCode': 0, 'ResponseMessage': 'APPROVED', 'PlutusTransactionReferenceID': 77}",
    );
  });
  it('routes every active mode the legacy way instead of dropping unknown ones', () => {
    expect([1, 10, 1001, 1003, 1004, 1005, 1006, 7, 1002].map(channelForMode)).toEqual([
      'pine-card',
      'pine-upi',
      'other',
      'paytm-card',
      'paytm-qr',
      'district',
      'pincode',
      'pine',
      'pine',
    ]);
    expect(paymentModeOf({ channel: 'pine', paymentMode: 7 })).toBe(7);
    const base = {
      operationId: crypto.randomUUID(),
      onlineAmount: '10.00',
      cashAmount: '0.00',
      cashReceived: '0.00',
    };
    expect(paymentInputSchema.safeParse({ ...base, channel: 'pine', paymentMode: 7 }).success).toBe(
      true,
    );
    expect(paymentInputSchema.safeParse({ ...base, channel: 'pine' }).success).toBe(false);
    expect(
      paymentInputSchema.safeParse({ ...base, channel: 'pine-card', paymentMode: 7 }).success,
    ).toBe(false);
  });
  it('validates the exact legacy pay amount and form rules', () => {
    const input = paymentInputSchema.parse({
      operationId: crypto.randomUUID(),
      channel: 'cash',
      onlineAmount: '0.00',
      cashAmount: '0.30',
      cashReceived: '1.00',
    });
    expect(() => validatePaymentSplit(input, '0.30')).not.toThrow();
    expect(() => validatePaymentSplit(input, 0.3)).not.toThrow();
    expect(() => validatePaymentSplit(input, '0.31')).toThrow('Incorrect Pay amount.');
    expect(() => validatePaymentSplit({ ...input, cashReceived: '0.29' }, '0.30')).toThrow(
      'Cash received',
    );
    expect(() => validatePaymentSplit({ ...input, cashReceived: '0' }, '0.30')).not.toThrow();
    expect(() =>
      validatePaymentSplit(
        { ...input, channel: 'district', onlineAmount: '0.10', cashAmount: '0.20' },
        '0.30',
      ),
    ).toThrow('Provide District Transaction ID');
    expect(() => paymentInputSchema.parse({ ...input, is_verified: true })).toThrow();
  });
});

describe('legacy record shapes', () => {
  it('derives the transaction id as Helpers.get_transaction_id does', () => {
    const base = {
      orderId: '8002',
      orderRefNo: 'TSS-0001-ABC',
      inactivePineCreated: 0,
      inactivePaytmCreated: 0,
      activePaytmCreated: 0,
    };
    expect(legacyTransactionId(base)).toBe('TSS-0001-ABC');
    expect(legacyTransactionId({ ...base, orderRefNo: 'AB-1' })).toBe('8002');
    expect(legacyTransactionId({ ...base, orderRefNo: '' })).toBe('8002');
    expect(legacyTransactionId({ ...base, inactivePineCreated: 1 })).toBe('TSS-0001-ABC-2');
    expect(legacyTransactionId({ ...base, inactivePineCreated: 1, inactivePaytmCreated: 2 })).toBe(
      'TSS-0001-ABC-5',
    );
    expect(legacyTransactionId({ ...base, inactivePaytmCreated: 1, activePaytmCreated: 1 })).toBe(
      'TSS0001ABC2',
    );
  });
  it('writes Python repr text for pay_dict and api_response', () => {
    expect(pythonFloat(100)).toBe('100.0');
    expect(pythonFloat(99.5)).toBe('99.5');
    expect(pythonFloat(0.1 + 0.2)).toBe('0.30000000000000004');
    expect(
      legacyPayDict([
        ['cash payment', 40],
        ['online payment', 59.95],
        ['total amount on counter', 40 + 59.95],
      ]),
    ).toBe("{'cash payment': 40.0, 'online payment': 59.95, 'total amount on counter': 99.95}");
    expect(pythonRepr({ a: null, b: true, c: "it's", d: [1, 2.5] })).toBe(
      `{'a': None, 'b': True, 'c': "it's", 'd': [1, 2.5]}`,
    );
  });
  it('composes the legacy payment message', () => {
    expect(
      legacyPaymentMessage({ online: '0', cashReceived: '500', cash: '450', change: '50' }),
    ).toBe(
      '#Card/UPI Received: 0\n#Cash Received:500\n#Cash To Be Accepted:450\n#Cash To Be Return:50',
    );
  });
});
