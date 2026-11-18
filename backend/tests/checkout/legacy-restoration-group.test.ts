import { describe, it, expect } from 'vitest';
import {
  proveRestorationGroup,
  type RestorationGroupFacts,
} from '../../src/modules/checkout/return-workflow/legacy-restoration-group.js';
const secret = 'restoration-group-only-synthetic-secret-'.repeat(2);
const facts: RestorationGroupFacts = {
  orderId: '100',
  productId: '10',
  storeId: '1',
  targetLineId: '11',
  lines: [
    { id: '11', quantity: '2', status: 'EXCHANGE_INITIATED', returnStatus: 1 },
    { id: '12', quantity: '1', status: 'EXCHANGE_INITIATED', returnStatus: 1 },
  ],
  exchanges: [
    {
      id: '21',
      lineId: '11',
      productId: '10',
      status: 'FAILED_NEEDS_MANUAL_FIX',
      saleable: false,
      createdAt: '2026-11-18 12:00:00',
      sourceHash: 'a'.repeat(64),
    },
    {
      id: '22',
      lineId: '12',
      productId: '10',
      status: 'FAILED_NEEDS_MANUAL_FIX',
      saleable: false,
      createdAt: '2026-11-18 12:00:00',
      sourceHash: 'b'.repeat(64),
    },
  ],
  credits: [
    {
      id: '31',
      lineId: '11',
      productId: '10',
      quantity: '2',
      createdAt: '2026-11-18 12:00:01',
      creditNote: 'S/CN/1',
    },
    {
      id: '32',
      lineId: '12',
      productId: '10',
      quantity: '1',
      createdAt: '2026-11-18 12:00:01',
      creditNote: 'S/CN/2',
    },
  ],
  saleable: [],
  held: [
    { id: '41', before: '0', after: '2', at: '2026-11-18 12:00:02' },
    { id: '42', before: '2', after: '3', at: '2026-11-18 12:00:02' },
  ],
};
describe('complete native same-SKU restoration conservation', () => {
  it('proves a duplicate-SKU group without pretending an event belongs to a particular line', () => {
    const value = proveRestorationGroup(facts, secret);
    expect(value).toMatchObject({
      heldQuantity: '3',
      saleableQuantity: '0',
      lineIds: ['11', '12'],
      creditIds: ['31', '32'],
      heldStockIds: ['41', '42'],
    });
    expect(
      proveRestorationGroup(
        {
          ...facts,
          lines: [...facts.lines].reverse(),
          exchanges: [...facts.exchanges].reverse(),
          credits: [...facts.credits].reverse(),
          held: [...facts.held].reverse(),
        },
        secret,
      ),
    ).toEqual(value);
  });
  it.each(['missing', 'surplus', 'wrong-bucket'] as const)(
    'refuses %s restoration rather than assuming current stock proves it',
    (kind) => {
      const copy = structuredClone(facts);
      const held = [...copy.held];
      if (kind === 'missing') held.pop();
      else if (kind === 'surplus') held[1] = { ...held[1]!, after: '4' };
      expect(
        proveRestorationGroup(
          {
            ...copy,
            held: kind === 'wrong-bucket' ? [] : held,
            saleable: kind === 'wrong-bucket' ? held : [],
          },
          secret,
        ),
      ).toBeNull();
    },
  );
  it('does not offset surplus saleable events against missing held events', () => {
    expect(
      proveRestorationGroup(
        {
          ...facts,
          exchanges: [{ ...facts.exchanges[0]!, saleable: true }, facts.exchanges[1]!],
          held: [],
          saleable: facts.held,
        },
        secret,
      ),
    ).toBeNull();
  });
  it('refuses partial, duplicated, unassigned or in-flight source groups', () => {
    for (const copy of [
      { ...facts, credits: facts.credits.slice(0, 1) },
      { ...facts, credits: [facts.credits[0]!, { ...facts.credits[1]!, lineId: '11' }] },
      { ...facts, exchanges: facts.exchanges.slice(0, 1) },
      { ...facts, credits: [facts.credits[0]!, { ...facts.credits[1]!, quantity: '2' }] },
      { ...facts, exchanges: [facts.exchanges[0]!, { ...facts.exchanges[1]!, status: 'PENDING' }] },
    ])
      expect(proveRestorationGroup(copy, secret)).toBeNull();
  });
  it('allows only the tracked target request to move through PENDING after adoption', () => {
    const changed = {
      ...facts,
      exchanges: [{ ...facts.exchanges[0]!, status: 'PENDING' }, facts.exchanges[1]!],
    };
    expect(proveRestorationGroup(changed, secret)).toBeNull();
    expect(proveRestorationGroup(changed, secret, '21')?.digest).toBe(
      proveRestorationGroup(facts, secret)?.digest,
    );
  });
  it('binds every independently credited quantity and restoration event into the certificate', () => {
    const changed = { ...facts, held: [{ ...facts.held[0]!, id: '43' }, facts.held[1]!] };
    expect(proveRestorationGroup(changed, secret)?.digest).not.toBe(
      proveRestorationGroup(facts, secret)?.digest,
    );
  });
});
