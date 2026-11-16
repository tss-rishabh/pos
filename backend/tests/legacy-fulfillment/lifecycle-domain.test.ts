import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Temporal } from '@js-temporal/polyfill';
import { readConfig } from '../../src/config.js';
import { boundedJson } from '../../src/domain/http-json.js';
import { cancellationSets } from '../../src/modules/legacy-fulfillment/lifecycle/authority.js';
import {
  deliverySnapshot,
  providerRequest,
  type ProviderKind,
} from '../../src/modules/legacy-fulfillment/lifecycle/contracts.js';
import {
  passDecision,
  providerRequestHash,
  scheduleArrival,
} from '../../src/modules/legacy-fulfillment/lifecycle/domain.js';
import { pythonRoundMoney } from '../../src/modules/legacy-fulfillment/lifecycle/money.js';
import { readLegacyLifecycleOptions } from '../../src/modules/legacy-fulfillment/lifecycle/options.js';
import {
  createLegacyProvider,
  providerHttpRequest,
} from '../../src/modules/legacy-fulfillment/lifecycle/provider.js';

const uuid = '00000000-0000-4000-a000-000000000001',
  orderId = '9007199254740993';
function oracle(cases: unknown[]) {
  const result = spawnSync('python3', ['tools/legacy-fulfillment/lifecycle-oracle.py'], {
    input: JSON.stringify(cases),
    encoding: 'utf8',
    timeout: 20000,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as unknown;
}
const config = {
    ...readConfig({
      NODE_ENV: 'test',
      DEMO_MODE: 'true',
      SESSION_SECRET: 'lifecycle-payload-test-'.repeat(4),
    }),
    DEMO_MODE: false,
  },
  options = readLegacyLifecycleOptions({
    TSS_OBERVER_URL: 'https://observer.example.test/',
    TSS_OBERVER_APP_ID: 'fixture-observer',
    TSS_OBERVER_APP_KEY: 'fixture-observer-key',
    MAIN_API_V2_URL: 'https://api.example.test/',
    ORDER_PRODUCER_URL: 'https://producer.example.test/',
    ORDER_PRODUCER_APP_ID: 'fixture-producer',
    ORDER_PRODUCER_APP_KEY: 'fixture-producer-key',
    MJML_HOST: 'https://mail.example.test/',
  }),
  request = (kind: ProviderKind, split = false) =>
    providerRequest.parse({
      id: uuid,
      commandId: uuid,
      kind,
      orderId,
      storeId: '1',
      customerId: '7',
      productId: '10',
      split,
      reason: 'Fixture reason',
      platform: 'webhook',
      newOrderId: '9007199254741993',
      subject: 'Fixture subject',
      description: 'Fixture description',
      customerName: 'Fixture',
    });
const callSchema = z.object({
  url: z.string(),
  headers: z.record(z.string(), z.string()),
  body: z.string(),
});
describe('pinned local-delivery payload and scheduling contracts', () => {
  it('preserves the exact pinned exception-date formatter response for SQL NULL and existing dates', () => {
    expect(
      oracle([
        { kind: 'exception-date', values: [null, '2026-11-16 13:30:00', '2025-01-01 00:00:00'] },
      ]),
    ).toEqual([[null, '2026-11-16 13:30:00', '2025-01-01 00:00:00']]);
  });
  it('matches transfer selection and timeout decisions from the actual source task, retaining the source positional-argument anomaly as evidence', () => {
    const cases = [
      { nextIds: '[2,3]', transferred: 0, automatic: false, cutoff: false, split: 1 },
      { nextIds: '[2,3]', transferred: 0, automatic: true, cutoff: false, split: 1 },
      { nextIds: '[2,3]', transferred: 0, automatic: true, cutoff: true, split: 1 },
      { nextIds: '[2,3]', transferred: 1, automatic: false, cutoff: false, split: 1 },
      { nextIds: '[]', transferred: 0, automatic: false, cutoff: false, split: 0 },
      { nextIds: 'invalid', transferred: 0, automatic: false, cutoff: false, split: 1 },
      { nextIds: '[2,3]', transferred: 0, automatic: false, cutoff: true, split: 0 },
    ];
    const results = z
      .array(
        z.object({
          result: z.tuple([z.string(), z.string()]),
          held: z.array(
            z.object({ kind: z.enum(['hold', 'release']), args: z.array(z.unknown()) }),
          ),
          notices: z.array(z.unknown()),
          jobs: z.array(z.object({ args: z.array(z.unknown()), countdown: z.number() })),
          slack: z.array(z.unknown()),
        }),
      )
      .parse(
        oracle(
          cases.map((value) => ({
            ...value,
            kind: 'transfer',
            now: '2026-11-16T13:30:00',
            orderId,
          })),
        ),
      );
    for (const [index, value] of cases.entries()) {
      const source = results[index]!,
        next = value.nextIds.startsWith('[') ? (JSON.parse(value.nextIds) as number[]) : [],
        actual = passDecision({
          nextStoreIds: next.map(String),
          isTransferred: !!value.transferred,
          automatic: value.automatic,
          cutoff: value.cutoff,
        });
      expect(actual).toBe(source.result[1]);
      expect(source.slack).toHaveLength(value.automatic ? 1 : 0);
      if (actual === 'transfer') {
        expect(source.notices).toHaveLength(2);
        expect(source.held).toHaveLength((value.split ? 2 : 3) * 3);
        expect(
          source.held.filter((row) => row.kind === 'release').map((row) => row.args[0]),
        ).toEqual(value.split ? [10, 11] : [10, 11, 12]);
        expect(source.jobs[0]!.countdown).toBe(value.cutoff ? 12600 : 3600);
        // Legacy scheduled-transfer positional slot 5 is staff_user, but receives reason_dropdown.
        expect(source.jobs[0]!.args[5]).toBe('Fixture category');
      } else expect(source.jobs[0]!.countdown).toBe(0);
    }
  });
  it('preserves store hold/release/consume arithmetic and rejects insufficient quantities in the pinned source helper', () => {
    const cases = [
      { action: 'hold_stock', stock: 5, held: null, quantity: 2 },
      { action: 'hold_stock', stock: 3, held: 2, quantity: 1 },
      { action: 'unhold_stock', stock: 2, held: 3, quantity: 2, consume: true },
      { action: 'unhold_stock', stock: 2, held: 1, quantity: 1, consume: true },
      { action: 'unhold_stock', stock: 2, held: 3, quantity: 2 },
      { action: 'unhold_stock', stock: 4, held: 1, quantity: 1 },
      { action: 'hold_stock', stock: 1, held: 0, quantity: 2 },
      { action: 'unhold_stock', stock: 2, held: 1, quantity: 2 },
    ];
    const result = z
      .array(
        z.object({
          result: z.object({ status: z.enum(['success', 'fail']) }),
          stock: z.number(),
          held: z.number().nullable(),
          logs: z.array(z.unknown()),
        }),
      )
      .parse(oracle(cases.map((value) => ({ ...value, kind: 'hold' }))));
    expect(result.map((row) => [row.stock, row.held, row.result.status])).toEqual([
      [3, 2, 'success'],
      [2, 3, 'success'],
      [2, 1, 'success'],
      [2, 0, 'success'],
      [4, 1, 'success'],
      [5, 0, 'success'],
      [1, 0, 'fail'],
      [2, 1, 'fail'],
    ]);
    expect(result.slice(0, 6).every((row) => row.logs.length === 1)).toBe(true);
    expect(result.slice(6).every((row) => row.logs.length === 0)).toBe(true);
  });
  it('preserves nine source payload profiles including form-origin string IDs, numeric customer/SKU IDs and the numeric new-order communication ID', async () => {
    const cases = [
        { kind: 'borzo-create' as const, method: 'create_borzo_order', args: [orderId, '1'] },
        { kind: 'online-convert' as const, method: 'place_online_order', args: [7, orderId, 0] },
        {
          kind: 'online-convert' as const,
          method: 'place_online_order',
          args: [7, orderId, 1],
          split: true,
        },
        {
          kind: 'cancel-order' as const,
          method: 'hl_order_cancel_refund',
          args: [7, orderId, 'Fixture reason', 'webhook', 0],
        },
        {
          kind: 'cancel-item' as const,
          method: 'hl_order_cancel_refund',
          args: [7, orderId, 'Fixture reason', 'webhook', 1],
          products: [10],
          split: true,
        },
        {
          kind: 'split-charge-refund' as const,
          method: 'refund_hl_charges_split',
          args: [orderId],
        },
        { kind: 'order-producer' as const, method: 'push_order_kinesis', args: [orderId] },
        {
          kind: 'new-order-email' as const,
          method: 'new_order_create_communication',
          args: [1008],
          newOrderId: '1008',
        },
        {
          kind: 'support-ticket' as const,
          method: 'create_od_ticket',
          args: [orderId, 'Fixture', 'Fixture subject', 'Fixture description'],
        },
      ],
      source = z
        .array(z.object({ calls: z.array(callSchema) }))
        .parse(oracle(cases.map((value) => ({ ...value, kind: 'payload' }))));
    for (const [index, value] of cases.entries()) {
      const actual = providerHttpRequest(
          {
            ...request(value.kind, value.split === true),
            ...(value.newOrderId ? { newOrderId: value.newOrderId } : {}),
          },
          config,
          options,
          'fixture-token',
        ),
        expected = source[index]!.calls[0]!;
      expect(actual.url.href).toBe(expected.url);
      expect(actual.headers).toMatchObject(expected.headers);
      expect(await boundedJson(new Response(actual.body))).toEqual(
        await boundedJson(new Response(expected.body)),
      );
      const kinds = (body: string) =>
        Object.fromEntries(
          Object.entries(z.record(z.string(), z.unknown()).parse(JSON.parse(body) as unknown)).map(
            ([key, value]) => [key, typeof value],
          ),
        );
      expect(kinds(actual.body)).toEqual(kinds(expected.body));
    }
  }, 25000);
  it('preserves advance slots, cutoff enabled/disabled, future dates, absent slots and fractional-second truncation from the actual arrival handler', () => {
    const cases = [
        {
          now: '2026-11-16T13:30:00',
          orderStart: '2026-11-16 10:00:00',
          slotStart: '10:00:00',
          cutoff: true,
        },
        {
          now: '2026-11-16T09:00:00',
          orderStart: '2026-11-16 11:00:00',
          slotStart: '10:00:00',
          cutoff: true,
        },
        {
          now: '2026-11-16T13:30:00',
          orderStart: '2026-11-17 11:00:00',
          slotStart: '10:00:00',
          cutoff: true,
        },
        {
          now: '2026-11-16T09:00:00.750',
          orderStart: '2026-11-16 11:00:00',
          slotStart: '10:00:00',
          cutoff: false,
        },
        {
          now: '2026-11-16T18:00:00',
          orderStart: '2026-11-16 10:00:00',
          slotStart: '10:00:00',
          cutoff: true,
        },
        {
          now: '2026-11-16T13:30:00',
          orderStart: '2026-11-17 11:00:00',
          slotStart: null,
          cutoff: false,
        },
        {
          now: '2026-11-21T13:30:00',
          orderStart: '2026-11-22 11:00:00',
          slotStart: '12:00:00',
          cutoff: false,
        },
        {
          now: '2026-11-16T16:59:59.999',
          orderStart: '2026-11-16 10:00:00',
          slotStart: null,
          cutoff: true,
        },
      ],
      source = z
        .array(
          z.object({
            advance: z.boolean(),
            successTimestamp: z.string().nullable(),
            jobs: z.array(z.object({ name: z.string(), countdown: z.number() })),
          }),
        )
        .parse(
          oracle(
            cases.map((value) => ({
              ...value,
              kind: 'arrival',
              orderId,
              storeId: '1',
              notify: true,
              buffer: 3600,
            })),
          ),
        );
    cases.forEach((value, index) => {
      const now = Temporal.Instant.from(value.now + 'Z'),
        result = scheduleArrival({
          now,
          zone: 'UTC',
          orderStart: value.orderStart,
          slotStart: value.slotStart,
          cutoff: value.cutoff,
          cutoffTime: '17:00',
          bufferSeconds: 3600,
        }),
        expected = source[index]!;
      expect(result.advance).toBe(expected.advance);
      expect(result.successTimestamp).toBe(expected.successTimestamp);
      expect(result.transferAt).toBe(
        now.epochMilliseconds +
          Math.max(0, expected.jobs.find((job) => job.name === 'auto-transfer')!.countdown) * 1000,
      );
      if (result.advance)
        expect(result.notificationAt).toBe(
          now.epochMilliseconds +
            Math.max(
              0,
              expected.jobs.find((job) => job.name === 'advance-notification')!.countdown,
            ) *
              1000,
        );
    });
  }, 25000);
  it('retains source binary floating wallet-history rounding and a stable bound provider hash after MySQL key reordering', () => {
    const values = [
        2.675,
        2.685,
        1.005,
        -2.675,
        60.125,
        5e-324,
        -0.00001,
        123456789.555,
        1e20,
        Number.MAX_VALUE,
      ],
      expected = z.array(z.array(z.number())).parse(oracle([{ kind: 'round', values }]))[0]!;
    expect(values.map(pythonRoundMoney)).toEqual(expected);
    const value = request('borzo-create'),
      reordered = Object.fromEntries(Object.entries(value).reverse());
    expect(providerRequestHash(providerRequest.parse(reordered))).toBe(providerRequestHash(value));
  }, 25000);
  it('prevents mixed-platform SKU sweeps and implicit special-SKU effects, while preserving unique authorized SKU groups and cutoff transfer choices', () => {
    const line = (id: string, sku: string, platform = '4') => ({
        id,
        productId: sku,
        quantity: 1,
        platform,
        status: 'PLACED',
      }),
      snapshot = (lines: ReturnType<typeof line>[]) =>
        deliverySnapshot.parse({
          orderId: '1',
          customerId: '7',
          ownerStoreId: '1',
          split: true,
          nextStoreIds: [],
          rawNextIds: '[]',
          startTimeslot: null,
          isTransferred: false,
          lines,
        });
    expect(
      cancellationSets(snapshot([line('1', '10'), line('2', '10'), line('3', '11', '1')]), [
        '999',
        '998',
      ]),
    ).toEqual(['10']);
    expect(() =>
      cancellationSets(snapshot([line('1', '10'), line('2', '10', '1')]), ['999', '998']),
    ).toThrow('scopes each exact order line');
    expect(() =>
      cancellationSets(snapshot([line('1', '10'), line('2', '999', '1')]), ['999', '998']),
    ).toThrow();
    expect(() =>
      cancellationSets(snapshot([line('1', '10'), line('2', '999')]), ['999', '998']),
    ).toThrow();
    expect(
      passDecision({ nextStoreIds: ['2'], isTransferred: false, automatic: false, cutoff: true }),
    ).toBe('transfer');
    expect(
      passDecision({ nextStoreIds: ['2'], isTransferred: false, automatic: true, cutoff: true }),
    ).toBe('convert');
    expect(
      passDecision({ nextStoreIds: ['2'], isTransferred: true, automatic: false, cutoff: false }),
    ).toBe('convert');
  });
  it('bounds real HTTP responses, preserves64-bit courier IDs and never turns a transport failure into a safe retry assertion', async () => {
    const calls: string[] = [],
      fetcher: typeof fetch = async (input) => {
        calls.push(String(input));
        return new Response(
          '{"is_successful":true,"order":{"order_id":9007199254742999,"points":[{"tracking_url":"https://tracking.example.test/source"},{"tracking_url":"javascript:unsafe()"}]}}',
          { status: 200 },
        );
      },
      provider = createLegacyProvider(config, options, fetcher);
    expect(
      await provider.send(request('borzo-create'), undefined, 'fixture-request'),
    ).toMatchObject({
      kind: 'courier-created',
      courierOrderId: '9007199254742999',
      destinationTracking: null,
    });
    expect(calls).toHaveLength(1);
    const unknown = createLegacyProvider(config, options, async () => {
      throw new Error('fixture-sensitive-upstream-body');
    });
    await expect(
      unknown.send(request('borzo-create'), undefined, 'fixture-request'),
    ).rejects.toMatchObject({ code: 'PROVIDER_OUTCOME_UNKNOWN' });
    expect(await unknown.reconcile(request('borzo-create'), 'fixture-request')).toEqual({
      status: 'unknown',
    });
    const demo = createLegacyProvider({ ...config, DEMO_MODE: true }, options, fetcher);
    expect(demo.ready('borzo-create')).toBe(false);
    await expect(
      demo.send(request('borzo-create'), undefined, 'fixture-request'),
    ).rejects.toMatchObject({ code: 'UPSTREAM_NOT_SENT' });
    expect(calls).toHaveLength(1);
  });
});
