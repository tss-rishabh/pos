import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { benefitDigest } from '../../src/modules/legacy-order-imports/benefit-profile/crypto.js';
const vector = z.object({
  label: z.string(),
  applied: z.boolean(),
  claims: z.number(),
  history: z.array(z.string()),
});
const output = z.object({
  admission: z.object({
    tender: z.object({ code: z.string(), payable: z.string() }),
    contextCleared: z.boolean(),
    missingScope: z.string(),
    qualified: z.record(z.string(), z.number()),
    wallet: z.string(),
    membership: z.string(),
    screenedWallet: z.string(),
  }),
  canonicalSeal: z.string(),
  automatic: z.array(vector),
  validation: z.array(
    z.object({
      label: z.string(),
      accepted: z.boolean(),
      message: z.string().nullable(),
      history: z.array(z.string()),
    }),
  ),
  freebie: z.object({
    meta: z.object({ items: z.record(z.string(), z.number()) }),
    quantity: z.number(),
    valid: z.boolean(),
    wrapperCalls: z.array(z.string()),
  }),
  allocations: z.array(
    z.object({
      lineItems: z.boolean(),
      percent: z.number(),
      payable: z.number(),
      couponDiscount: z.number(),
      lines: z.array(
        z.object({
          productId: z.string(),
          quantity: z.number(),
          price: z.number(),
          discount: z.number(),
          type: z.string(),
          refundable: z.number(),
        }),
      ),
      refundAudits: z.number(),
      coherent: z.boolean(),
    }),
  ),
});
describe('pinned original CSV birthday coupon/POS selection oracle', () => {
  const result = output.parse(
    JSON.parse(
      execFileSync(
        'compatibility/upstream/offline-cash-pricing/.venv/bin/python',
        ['-B', 'tools/legacy-import-benefits/source_oracle.py'],
        {
          encoding: 'utf8',
          timeout: 10000,
          maxBuffer: 1000000,
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
        },
      ),
    ) as unknown,
  );
  it('retains the original declared tender and emits a qualified no-effect calculation instead of silently accepting a discount', () => {
    expect(result.admission.tender).toEqual({
      code: 'ORDER_IMPORT_ORIGINAL_TENDER_MISMATCH',
      payable: '45.00',
    });
    expect(result.admission.contextCleared).toBe(true);
    expect(result.admission.missingScope).toBe('ORDER_IMPORT_BENEFIT_SCOPE_REQUIRED');
  });
  it('does not invent wallet consent or unproved membership ownership', () => {
    expect(result.admission.wallet).toBe('ORDER_IMPORT_UNBOUND_WALLET_BENEFIT');
    expect(result.admission.membership).toBe('ORDER_IMPORT_MEMBERSHIP_PROFILE_REQUIRED');
  });
  it('lets the existing screening wrapper remove only its own rejection and preserves all other profile/tender guards', () => {
    expect(result.admission.screenedWallet).toBe('ORDER_IMPORT_UNBOUND_WALLET_BENEFIT');
    expect(Object.values(result.admission.qualified)).toEqual([1]);
  });
  it('uses code-point canonical HMAC ordering across Node/Python, independent of host ICU', () => {
    expect(
      benefitDigest(
        'coupon',
        { refundable: '1.00', refundInputHash: 'a'.repeat(64) },
        'isolated-benefit-history-key-0123456789',
      ),
    ).toBe(result.canonicalSeal);
  });
  for (const row of result.automatic)
    it(`retains original automatic eligibility: ${row.label}`, () => {
      expect(row.applied).toBe(row.label === 'eligible');
      expect(row.claims).toBe(row.label === 'eligible' ? 1 : 0);
      if (row.label === 'global-used') expect(row.history).toEqual(['globalUsage']);
    });
  for (const row of result.validation)
    it(`retains original coupon validation: ${row.label}`, () => {
      expect(row.accepted).toBe(row.label === 'valid-control');
      if (row.label === 'monthly-multiplied') expect(row.history).toContain('monthlyJoinedUsage');
      if (row.label === 'lot-used') expect(row.history).toContain('lotCounts');
    });
  it('does not award web automatic freebies to either POS importer', () => {
    expect(result.freebie.wrapperCalls).toEqual(['PosFreebieWrapper']);
    expect(Object.values(result.freebie.meta.items)).toEqual([1]);
    expect(result.freebie.quantity).toBe(1);
    expect(result.freebie.valid).toBe(true);
  });
  for (const row of result.allocations)
    it(`executes source per-HP refund arithmetic (split=${row.lineItems},coupon=${row.percent})`, () => {
      expect(row.coherent).toBe(true);
      expect(row.refundAudits).toBe(row.lines.length);
      expect(row.lines.at(-1)).toMatchObject({
        type: 'FREEBIE',
        quantity: 1,
        price: row.lineItems ? 0 : 17.83,
        discount: 0,
      });
      if (row.lineItems || row.percent === 100) expect(row.lines.at(-1)!.refundable).toBe(0);
      else expect(row.lines.at(-1)!.refundable).toBe(11.66);
      expect(row.lines.reduce((sum, line) => sum + Math.round(line.refundable * 100), 0)).toBe(
        Math.round(row.payable * 100),
      );
      if (row.percent === 100) expect(row.payable).toBe(0);
    });
});
