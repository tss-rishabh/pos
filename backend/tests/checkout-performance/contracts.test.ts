import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  performanceInput,
  sourcePerformanceJson,
} from '../../src/modules/checkout-performance/contracts.js';
import { cashierPerformance } from '../../src/modules/operational-reports/performance-domain.js';

const empty = {
    product_main_list: '',
    user_behaviour: '',
    add_to_cart: '',
    proceed_to_payment: '',
    overall_performance_time: '',
  },
  vectors = [
    { name: 'empty-source-fields', performance: empty },
    {
      name: 'missing-connect-NaN',
      performance: { ...empty, overall_performance_time: 'NaN' },
      includeBaseline: true,
    },
    {
      name: 'native-rpc-decimals',
      performance: {
        ...empty,
        product_main_list: '10.25',
        user_behaviour: '20.50',
        add_to_cart: '30.75',
        overall_performance_time: '1000',
      },
    },
    {
      name: 'previous-fast-payment',
      performance: { ...empty, fast_payment: '25.25', overall_performance_time: '1234' },
    },
    {
      name: 'legacy-negative-poisons-report',
      performance: { ...empty, overall_performance_time: '-100' },
    },
  ],
  oracle = z
    .object({
      source: z.literal('78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'),
      cases: z.array(
        z.object({
          name: z.string(),
          serialized: z.string(),
          updates: z.array(
            z.object({
              where: z.object({ order_id: z.string() }),
              data: z.object({ performance_json: z.string() }),
            }),
          ),
          report: z.unknown(),
          reportError: z.string().nullable(),
        }),
      ),
    })
    .parse(
      JSON.parse(
        execFileSync('python3', ['tools/checkout-performance/source-oracle.py'], {
          input: JSON.stringify(vectors),
          encoding: 'utf8',
          timeout: 20000,
        }),
      ) as unknown,
    );
describe('source-native checkout performance format and report meaning', () => {
  afterAll(async () => {
    await mkdir('parity/evidence/checkout-performance', { recursive: true });
    const file = 'parity/evidence/checkout-performance/source-oracle.json',
      temporary = file + '.' + randomUUID() + '.tmp';
    await writeFile(
      temporary,
      JSON.stringify(
        {
          scope: 'generated-fixtures-only',
          ...oracle,
          corrections: [
            'Negative overall passes the legacy writer but raises ValueError in the source cashier reducer; new writes reject it and the client uses the existing NaN fallback.',
          ],
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    );
    await rename(temporary, file);
  });
  for (const [index, vector] of vectors.entries())
    it(vector.name, () => {
      const expected = oracle.cases[index]!;
      expect(expected.updates[0]?.data.performance_json).toBe(expected.serialized);
      if (vector.name === 'legacy-negative-poisons-report') {
        expect(expected.reportError).toBe('ValueError');
        expect(() =>
          performanceInput.parse({
            operationId: randomUUID(),
            orderId: '9007199254740993',
            performance: vector.performance,
          }),
        ).toThrow();
        expect(() =>
          cashierPerformance(
            [
              {
                orderId: '9007199254740993',
                cashierId: '7',
                cashierName: 'Fixture',
                performanceJson: expected.serialized,
                quantity: 2,
              },
            ],
            'rating',
            'desc',
          ),
        ).toThrowError();
        return;
      }
      const input = performanceInput.parse({
        operationId: randomUUID(),
        orderId: '9007199254740993',
        performance: vector.performance,
      });
      expect(sourcePerformanceJson(input.performance)).toBe(expected.serialized);
      const rows = [
        {
          orderId: '9007199254740993',
          cashierId: '7',
          cashierName: 'Fixture',
          performanceJson: expected.serialized,
          quantity: 2,
        },
      ];
      if (vector.includeBaseline)
        rows.push({
          orderId: '9007199254740994',
          cashierId: '8',
          cashierName: 'Baseline',
          performanceJson:
            '{"overall_performance_time":"60000","proceed_to_payment":"","add_to_cart":"","user_behaviour":""}',
          quantity: 1,
        });
      expect(cashierPerformance(rows, 'rating', 'desc')).toEqual(expected.report);
    });
  it('accepts the native255-byte ASCII boundary and rejects non-native strings/unknown payload fields', () => {
    const value = {
        product_main_list: '9999999999999999.99',
        user_behaviour: '9999999999999999.99',
        add_to_cart: '9999999999999999.99',
        proceed_to_payment: '9999999999999999.99',
        fast_payment: '9999999999999999.99',
        overall_performance_time: '9007199254740991',
      },
      input = { operationId: randomUUID(), orderId: '9007199254740993', performance: value };
    expect(
      Buffer.byteLength(sourcePerformanceJson(performanceInput.parse(input).performance), 'ascii'),
    ).toBe(255);
    for (const performance of [
      { ...empty, overall_performance_time: 'Infinity' },
      { ...empty, overall_performance_time: '9007199254740992' },
      { ...empty, add_to_cart: '1.2' },
      { ...empty, user_behaviour: 'NaN' },
      { ...empty, proceed_to_payment: '-1.00' },
      { ...empty, add_to_cart: 'email@example.test' },
      { ...empty, comment: 'private' },
      { ...value, add_to_cart: '99999999999999999.99' },
    ])
      expect(() => performanceInput.parse({ ...input, performance })).toThrow();
  });
});
