import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  paymentReversalInputSchema,
  paymentReversalOptions,
} from '../../src/modules/checkout/payment-reversals/contracts.js';
const resultSchema = z.object({
  sourceRevision: z.string(),
  methodHash: z.string(),
  results: z.array(
    z.object({
      response: z.object({ status: z.string() }),
      order: z.object({ payment_statuses: z.number(), order_statuses: z.number() }),
      mapping: z.object({ offline_payment: z.number(), online_payment: z.number() }),
      lines: z.array(z.object({ status: z.string() })),
      comments: z.array(z.object({ status_id: z.number() })),
      effects: z.array(z.array(z.unknown())),
    }),
  ),
});
describe('literal payment-status source characterization and strict correction boundary', () => {
  it('executes five original source cases, proving flag parity and the unsafe deletion/unconfirmed-provider differences', () => {
    const oracle = resultSchema.parse(
      JSON.parse(
        execFileSync('python3', ['tools/payment-reversals/source_oracle.py'], {
          input: JSON.stringify([
            { input: { pay_type: '0', offline_payment: '0', online_payment: '0' } },
            {
              input: {
                pay_type: '1',
                offline_payment: '100',
                online_payment: '0',
                p_status: '4',
                o_status: '3',
              },
            },
            {
              input: {
                pay_type: '1',
                offline_payment: '99',
                online_payment: '0',
                p_status: '4',
                o_status: '3',
              },
            },
            {
              input: { pay_type: '0', offline_payment: '9999', online_payment: '88' },
              lineStatus: 'RETURNED',
            },
            {
              input: {
                pay_type: '1',
                offline_payment: '0',
                online_payment: '100',
                p_status: '4',
                o_status: '3',
              },
            },
          ]),
          encoding: 'utf8',
        }),
      ) as unknown,
    );
    expect(oracle.sourceRevision).toBe('78d5b63d6a149a6bf2c748fa1d191799c59ecb8a');
    expect(oracle.methodHash).toMatch(/^[a-f0-9]{64}$/);
    const [reversed, paid, invalid, unsafe, online] = oracle.results;
    expect(reversed?.order).toMatchObject({ payment_statuses: 1, order_statuses: 1 });
    expect(reversed?.lines[0]?.status).toBe('PLACED');
    expect(reversed?.comments.map((value) => value.status_id)).toEqual([1]);
    expect(reversed?.effects.some((value) => value[0] === 'kinesis')).toBe(false);
    expect(paid?.response.status).toBe('success');
    expect(paid?.effects.some((value) => value[0] === 'kinesis')).toBe(true);
    expect(invalid?.response.status).toBe('fail');
    expect(invalid?.mapping.offline_payment).toBe(100);
    expect(unsafe?.response.status).toBe('success');
    expect(unsafe?.mapping.offline_payment).toBe(9999);
    expect(unsafe?.lines[0]?.status).toBe('PLACED');
    expect(online?.response.status).toBe('success');
  });
  it('never accepts original arbitrary status/provider flags or an unacknowledged cash return', () => {
    const input = {
      operationId: crypto.randomUUID(),
      originalPaymentId: crypto.randomUUID(),
      counterId: '3',
      snapshotHash: 'a'.repeat(64),
      cashReturnReceiptId: crypto.randomUUID(),
      returnedCash: '100.00',
      confirmCashReturned: true,
      confirmNoHandover: true,
      reason: 'customer-payment-correction',
    };
    expect(paymentReversalInputSchema.safeParse(input).success).toBe(true);
    for (const extra of [
      { p_status: 4 },
      { pay_type: 0 },
      { confirmCashReturned: false },
      { confirmNoHandover: false },
      { providerRefunded: true },
      { returnedCash: '1.234' },
    ])
      expect(paymentReversalInputSchema.safeParse({ ...input, ...extra }).success).toBe(false);
    expect(
      paymentReversalOptions({
        POS_PAYMENT_REVERSAL_CONTRACT: '',
        POS_PAYMENT_CORRECTION_FINANCE_CONTRACT: '',
      }),
    ).toEqual({ contract: undefined, financeContract: undefined });
  });
});
