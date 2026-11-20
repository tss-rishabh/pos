import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import {
  performanceMessages,
  storeStatusMessages,
  summaryMessages,
  availabilityMessages,
  delayMessages,
  cancellationMessages,
  crmMessages,
  crmAge,
  nextStoreIds,
  type SlotFact,
  type StoreFact,
  type ScheduledArtifact,
  type ScheduledKind,
  type AvailabilityFact,
} from '../../src/modules/operational-reports/scheduled-domain.js';
import { goldenStdout } from '../golden/load.js';
const now = Temporal.Instant.from('2026-11-17T08:00:00Z'),
  date = '2026-11-16',
  stores: StoreFact[] = [
    { id: '1', name: 'Fixture test', type: 'STORE' },
    { id: '2', name: 'Fixture one', type: 'STORE' },
    { id: '3', name: 'Fixture two', type: 'CORE_WAREHOUSE' },
    { id: '4', name: 'Fixture offline', type: 'OFFICE' },
  ],
  slots: SlotFact[] = stores.flatMap((store, index) =>
    ['MON', 'TUE'].map((day, ordinal) => ({
      id: String(index * 2 + ordinal + 1),
      storeId: store.id,
      weekday: day as 'MON' | 'TUE',
      available: index !== 2,
      start: '10:00:00',
      end: '21:00:00',
    })),
  );
describe('actual source scheduled-report method fixtures', () => {
  it('matches source report text, channel selection, transfer counts, timing and CRM age', () => {
    const cases: {
        kind: ScheduledKind;
        rows: unknown[];
        orders?: unknown[];
        stores: StoreFact[];
        slots: SlotFact[];
        artifact: ScheduledArtifact;
        previousDays?: number;
        sendToSlack?: boolean;
        includeCompleted?: boolean;
      }[] = [],
      add = (
        kind: ScheduledKind,
        rows: unknown[],
        artifact: ScheduledArtifact,
        extra: Record<string, unknown> = {},
      ) => cases.push({ kind, rows, stores, slots, artifact, ...extra });
    for (const createdAt of [
      '2026-11-16 08:00:00',
      '2026-11-16 10:15:00',
      '2026-11-15 23:00:00',
      '2026-11-17 12:00:00',
    ]) {
      const rows = [
        {
          orderId: '1001',
          createdAt,
          storeId: '2',
          storeName: 'Fixture one',
          acceptedAt: '2026-11-16 11:30:00',
        },
        {
          orderId: '1002',
          createdAt: '2026-11-16 12:00:00',
          storeId: '9',
          storeName: null,
          acceptedAt: '2026-11-16 13:00:00',
        },
      ];
      add('hyperlocal-performance', rows, performanceMessages(date, rows, slots));
    }
    add('hyperlocal-performance', [], performanceMessages(date, [], slots));
    add('hyperlocal-store-status', [], storeStatusMessages('2026-11-17', stores, slots));
    add('hyperlocal-store-status', [], storeStatusMessages('2026-11-17', stores, []), {
      slots: [],
    });
    for (const isTransfer of [false, true]) {
      const rows = [
        {
          orderId: '1001',
          storeId: '2',
          action: 'ACCEPTED',
          isTransfer,
          mainStoreId: '3',
          nextStoreIds: [],
        },
        {
          orderId: '1002',
          storeId: '3',
          action: 'CONVERT_ONLINE',
          isTransfer,
          mainStoreId: null,
          nextStoreIds: ['2', '2', '1'],
        },
        {
          orderId: '1003',
          storeId: '3',
          action: 'DECLINED',
          isTransfer,
          mainStoreId: null,
          nextStoreIds: ['2'],
        },
        {
          orderId: '1004',
          storeId: '2',
          action: 'NO_ACTION',
          isTransfer: false,
          mainStoreId: null,
          nextStoreIds: [],
        },
      ];
      add('hyperlocal-summary', rows, summaryMessages(date, rows, stores, slots));
    }
    add('hyperlocal-summary', [], summaryMessages(date, [], stores, slots));
    const availability: AvailabilityFact[] = [
      {
        orderId: '1',
        cartType: 'VALID',
        stockThreshold: 'NOT_GUILTY',
        storeAvailability: 'NOT_GUILTY',
        slotVisible: true,
        isApp: true,
      },
      {
        orderId: '1',
        cartType: 'VALID',
        stockThreshold: 'NOT_GUILTY',
        storeAvailability: 'NOT_GUILTY',
        slotVisible: true,
        isApp: true,
      },
      {
        orderId: '2',
        cartType: 'VALID',
        stockThreshold: 'NOT_GUILTY',
        storeAvailability: 'NOT_GUILTY',
        slotVisible: true,
        isApp: false,
      },
      {
        orderId: '3',
        cartType: 'VALID',
        stockThreshold: 'GUILTY',
        storeAvailability: 'GUILTY',
        slotVisible: true,
        isApp: false,
      },
      {
        orderId: '4',
        cartType: 'MIXED',
        stockThreshold: 'GUILTY',
        storeAvailability: 'NOT_GUILTY',
        slotVisible: false,
        isApp: false,
      },
      {
        orderId: '5',
        cartType: 'VALID',
        stockThreshold: 'NOT_GUILTY',
        storeAvailability: 'GUILTY',
        slotVisible: true,
        isApp: false,
      },
      {
        orderId: '6',
        cartType: 'MIXED',
        stockThreshold: 'NOT_GUILTY',
        storeAvailability: 'NOT_GUILTY',
        slotVisible: false,
        isApp: false,
      },
      {
        orderId: '7',
        cartType: 'INVALID',
        stockThreshold: 'NOT_GUILTY',
        storeAvailability: 'NOT_GUILTY',
        slotVisible: false,
        isApp: false,
      },
    ];
    for (const rows of [availability, []]) {
      const orders = [
        { orderId: '1', isApp: true },
        { orderId: '9', isApp: false },
      ];
      add('hyperlocal-availability', rows, availabilityMessages(date, rows, orders), { orders });
    }
    for (const rows of [
      [
        { orderId: '9007199254740993', totalDelay: '00:05:59' },
        { orderId: '1001', totalDelay: '25:30:12' },
      ],
      [],
    ])
      add('hyperlocal-delivery-delays', rows, delayMessages(date, rows));
    for (const rows of [
      [
        {
          storeName: 'Fixture one',
          orderId: '1001',
          reason: 'Fixture reason',
          comment: null,
          convertedAt: '2026-11-16 12:30:00',
        },
      ],
      [],
    ])
      add('hyperlocal-cancellations', rows, cancellationMessages(date, rows));
    for (const includeCompleted of [false, true])
      for (const sendToSlack of [false, true])
        for (const rows of [
          [
            { orderId: '1001', ticketId: '901', status: 'OPEN', createdAt: '2026-11-15T07:59:59Z' },
            {
              orderId: '1002',
              ticketId: '902',
              status: 'CLOSED',
              createdAt: '2026-11-17T07:59:59Z',
            },
          ],
          [],
        ])
          add('crm-tickets', rows, crmMessages(date, 3, sendToSlack, includeCompleted, rows, now), {
            previousDays: 3,
            sendToSlack,
            includeCompleted,
          });
    const expected = JSON.parse(
      goldenStdout(
        'operational-reports',
        'scheduled-domain',
        JSON.stringify({
          cases: cases.map(({ artifact: _, ...value }) => ({ ...value, now: now.toString() })),
        }),
      ),
    ) as {
      messages: ScheduledArtifact['messages'];
      updates: { ticketId: string; status: string; age: string }[];
    }[];
    expect(cases.map((value) => value.artifact.messages)).toEqual(
      expected.map((value) => value.messages),
    );
    for (let index = 0; index < cases.length; index++) {
      const value = cases[index]!;
      if (value.kind === 'crm-tickets')
        expect(expected[index]?.updates).toEqual(
          (value.rows as { ticketId: string; status: string; createdAt: string }[]).map((row) => ({
            ticketId: row.ticketId,
            status: row.status,
            age: crmAge(row.createdAt, now).milliseconds,
          })),
        );
    }
    expect(cases).toHaveLength(24);
  });
  it('escapes untrusted Slack links/mentions and preserves long transfer IDs', () => {
    const message = cancellationMessages(date, [
      {
        storeName: '<@here>',
        orderId: '1',
        reason: 'A&B',
        comment: '<https://private.example.test|x>',
        convertedAt: '2026-11-16 10:00:00',
      },
    ]).messages[0]?.text;
    expect(message).toContain('&lt;@here&gt;');
    expect(message).toContain('A&amp;B');
    expect(message).not.toContain('<https://');
    expect(nextStoreIds('[9007199254740993,2,2]')).toEqual(['9007199254740993', '2', '2']);
    expect(() => nextStoreIds('["bad"]')).toThrow();
    expect(() =>
      availabilityMessages(
        date,
        Array.from({ length: 6000 }, () => ({
          orderId: '9007199254740993',
          cartType: 'VALID',
          stockThreshold: 'NOT_GUILTY',
          storeAvailability: 'NOT_GUILTY',
          slotVisible: true,
          isApp: true,
        })),
        [],
      ),
    ).toThrowError('Report source groups require reconciliation before delivery.');
  });
  it('formats acceptance rates as CPython f"{rate:.2f}" (half-even on the exact float)', () => {
    // report/views.py:1830,1844. 1/32*100 is exactly 3.125: CPython prints 3.12, toFixed 3.13.
    const rows = Array.from({ length: 32 }, (_, index) => ({
      orderId: String(index + 1),
      storeId: '2',
      action: index ? 'DECLINED' : 'ACCEPTED',
      isTransfer: false,
      mainStoreId: null,
      nextStoreIds: [],
    }));
    const text = summaryMessages(date, rows, stores, slots).messages[0]!.text;
    expect(text).toContain('Acceptance Rate: *3.12%*');
    expect(text).toContain('Overall Accepted Rate:* *3.12%*');
  });
});
