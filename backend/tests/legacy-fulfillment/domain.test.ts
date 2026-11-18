import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  legacyAuditComment,
  legacyCancellationAudit,
  legacyRtoPlan,
  legacyTrackingUrl,
  sourceLegacyStatus,
} from '../../src/modules/legacy-fulfillment/domain.js';
import { goldenSpawnResult } from '../golden/load.js';

function source(cases: unknown[]) {
  const result = goldenSpawnResult('legacy-fulfillment', 'domain', JSON.stringify(cases));
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as unknown;
}
describe('old Borzo source methods and explicit RTO correction', () => {
  it('preserves source status branches while withholding stored raw provider errors', () => {
    const logs = [
      null,
      ...['ACCEPTED', 'DECLINED', 'NO_ACTION', 'CREATION_FAILED', 'CONVERT_ONLINE'].flatMap(
        (action) => [0, 1].map((createdInBorzo) => ({ action, createdInBorzo })),
      ),
    ];
    const expected = z
      .array(z.object({ status: z.string(), message: z.string(), error: z.string() }))
      .parse(
        source(
          logs.map((log) => ({
            kind: 'status',
            log: log
              ? {
                  action: log.action,
                  is_created_in_borzo: log.createdInBorzo,
                  error_msg: 'provider raw fixture detail',
                }
              : null,
          })),
        ),
      );
    logs.forEach((log, index) => {
      const actual = sourceLegacyStatus(log);
      expect(actual.status).toBe(expected[index]!.status);
      expect(actual.message).toBe(expected[index]!.message);
      if (log?.action !== 'CREATION_FAILED') expect(actual.error).toBe(expected[index]!.error);
      else expect(actual.error).not.toContain('provider raw fixture detail');
    });
  });
  it('retains exact source business comments and validates the255-character final attribution boundary', () => {
    const cases = ['', 'Checked parcel', 'Euro € note', '<script>literal text</script>'].flatMap(
        (note) => ['packing', 'rto-receipt'].map((kind) => ({ kind, note, firstName: 'Fixture' })),
      ),
      output = z
        .array(
          z.object({
            transactions: z.array(
              z.tuple([
                z.number(),
                z.number(),
                z.number(),
                z.number(),
                z.record(z.string(), z.unknown()),
                z.string(),
              ]),
            ),
          }),
        )
        .parse(source(cases));
    cases.forEach((value, index) =>
      expect(
        legacyAuditComment(value.kind as 'packing' | 'rto-receipt', value.note, 'Fixture'),
      ).toBe(output[index]!.transactions[0]![5]),
    );
    expect(() => legacyAuditComment('packing', 'x'.repeat(255), 'Fixture')).toThrow(
      'legacy audit limit',
    );
    expect(
      legacyAuditComment(
        'packing',
        'x'.repeat(255 - legacyAuditComment('packing', '', 'Fixture').length),
        'Fixture',
      ),
    ).toHaveLength(255);
  });
  it('preserves each normal per-HP stock/audit step and demonstrates the old repeated/split stock defects separately', () => {
    const lines = [
        { hasProductId: '1', productId: '10', subProductId: '0', quantity: '2', platform: '4' },
        { hasProductId: '2', productId: '10', subProductId: '0', quantity: '1', platform: '4' },
        { hasProductId: '3', productId: '11', subProductId: '0', quantity: '5', platform: '1' },
      ],
      stocks = [
        { productId: '10', stock: 3 },
        { productId: '11', stock: 4 },
      ],
      plan = legacyRtoPlan(false, lines, stocks);
    const output = z
      .array(
        z.object({
          effects: z.array(
            z.object({ productId: z.string(), before: z.number(), after: z.number() }),
          ),
          stocks: z.array(z.object({ productId: z.string(), stock: z.number() })),
        }),
      )
      .parse(
        source(
          [1, 2].map((repeat) => ({
            kind: 'rto-receipt',
            firstName: 'Fixture',
            note: 'Package received',
            lines,
            stocks: stocks.map((row) => ({
              product_id: row.productId,
              store_id: 1,
              stock: row.stock,
            })),
            repeat,
          })),
        ),
      );
    expect(
      plan.steps.map(({ productId, before, after }) => ({ productId, before, after })),
    ).toEqual(output[0]!.effects);
    expect(plan.totalUnits).toBe('8');
    expect(output[1]!.stocks).toEqual([
      { productId: '10', stock: 9 },
      { productId: '11', stock: 14 },
    ]);
    const split = legacyRtoPlan(true, lines, stocks);
    expect(split.totalUnits).toBe('3');
    expect(split.steps.map((row) => row.hasProductId)).toEqual(['1', '2']);
    expect(split.excludedLineCount).toBe(1);
    expect(output[0]!.stocks[1]!.stock).toBe(9);
  });
  it('rejects unsafe quantity, duplicate/missing associations, ambiguous SKU and overflowing stock; tracking stays inert HTTPS', () => {
    const line = {
        hasProductId: '1',
        productId: '10',
        subProductId: '0',
        quantity: '2',
        platform: '4',
      },
      stocks = [{ productId: '10', stock: 1 }];
    for (const lines of [[{ ...line, quantity: '-1' }], [line, line]])
      expect(() => legacyRtoPlan(false, lines, stocks)).toThrow();
    expect(() => legacyRtoPlan(true, [{ ...line, platform: '1' }], stocks)).toThrow();
    expect(() => legacyRtoPlan(false, [line], [])).toThrow();
    expect(
      legacyRtoPlan(false, [{ ...line, subProductId: '12' }], stocks).steps[0]?.productId,
    ).toBe('10');
    expect(() => legacyRtoPlan(false, [line], [...stocks, ...stocks])).toThrow();
    expect(() => legacyRtoPlan(false, [line], [{ productId: '10', stock: 2147483647 }])).toThrow();
    expect(legacyTrackingUrl('javascript:alert(1)')).toBeNull();
    expect(legacyTrackingUrl('https://user:secret@example.test')).toBeNull();
    expect(legacyTrackingUrl('https://tracking.example.test/parcel?id=fixture')).toBe(
      'https://tracking.example.test/parcel?id=fixture',
    );
  });
  it('demonstrates the exact cancellation-audit/ACCEPTED-log hazard with the pinned webhook cancellation method', () => {
    const output = z
      .array(
        z.object({
          outcome: z.tuple([z.boolean(), z.record(z.string(), z.unknown())]),
          action: z.string(),
          transactions: z.array(
            z.tuple([
              z.number(),
              z.number(),
              z.number(),
              z.number(),
              z.record(z.string(), z.unknown()),
              z.string(),
            ]),
          ),
          effects: z.array(
            z.object({ productId: z.string(), before: z.number(), after: z.number() }),
          ),
          stocks: z.array(z.object({ productId: z.string(), stock: z.number() })),
        }),
      )
      .parse(
        source([
          {
            kind: 'cancel-webhook',
            lines: [{ productId: '10', quantity: '3', platform: '4' }],
            stocks: [{ product_id: '10', store_id: 1, stock: 5 }],
          },
        ]),
      );
    expect(output[0]!.outcome[0]).toBe(true);
    expect(output[0]!.action).toBe('ACCEPTED');
    expect(output[0]!.transactions[0]![5]).toBe(legacyCancellationAudit);
    expect(output[0]!.effects).toEqual([{ productId: '10', before: 5, after: 8 }]);
    expect(output[0]!.stocks).toEqual([{ productId: '10', stock: 8 }]);
  });
});
