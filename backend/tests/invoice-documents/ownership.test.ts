import { describe, expect, it } from 'vitest';
import {
  fullInvoiceOwnership,
  type InvoiceOwnership,
  maxInvoiceLines,
} from '../../src/modules/invoice-documents/contracts.js';
const order = (): InvoiceOwnership => ({
  storeId: '1',
  locationType: '',
  locationId: null,
  split: false,
  lines: [
    { id: '9007199254740993', platformId: '5' },
    { id: '9007199254740994', platformId: '5' },
  ],
  mappings: [],
  express: [],
});
describe('complete online invoice ownership', () => {
  it('requires a real full store mapping, not arbitrary operator role or an order ID', () => {
    expect(fullInvoiceOwnership(order())).toBeNull();
    const mapped = {
      ...order(),
      mappings: [{ id: '3', storeId: '1', counterId: '2', number: 'FIXTURE/INV/1' }],
    };
    expect(fullInvoiceOwnership(mapped)).toBe('store');
    expect(
      fullInvoiceOwnership({ ...mapped, mappings: [{ ...mapped.mappings[0]!, storeId: '2' }] }),
    ).toBeNull();
    expect(
      fullInvoiceOwnership({ ...mapped, mappings: [...mapped.mappings, ...mapped.mappings] }),
    ).toBeNull();
  });
  it('allows only a complete single-store express HP set, preserving duplicate associations', () => {
    const value = {
      ...order(),
      express: [
        { id: '1', lineId: '9007199254740993', storeId: '1' },
        { id: '2', lineId: '9007199254740994', storeId: '1' },
      ],
    };
    expect(fullInvoiceOwnership(value)).toBe('express');
    expect(fullInvoiceOwnership({ ...value, express: [...value.express, value.express[0]!] })).toBe(
      'express',
    );
    for (const express of [
      value.express.slice(0, 1),
      [...value.express, { id: '3', lineId: '9', storeId: '1' }],
      [value.express[0]!, { ...value.express[1]!, storeId: '2' }],
      [value.express[0]!, { ...value.express[1]!, storeId: null }],
    ])
      expect(fullInvoiceOwnership({ ...value, express })).toBeNull();
  });
  it('allows only nonsplit ordinary local platform4 orders bound to the selected store', () => {
    const value = {
      ...order(),
      locationType: 'SW',
      locationId: '1',
      lines: order().lines.map((line) => ({ ...line, platformId: '4' })),
    };
    expect(fullInvoiceOwnership(value)).toBe('local');
    for (const invalid of [
      { ...value, split: true },
      { ...value, locationId: '2' },
      { ...value, lines: [value.lines[0]!, { ...value.lines[1]!, platformId: '1' }] },
    ])
      expect(fullInvoiceOwnership(invalid)).toBeNull();
  });
  it('fails explicitly for empty, duplicate-ID and oversized source sets', () => {
    const mapped = {
      ...order(),
      mappings: [{ id: '3', storeId: '1', counterId: '2', number: '' }],
    };
    expect(fullInvoiceOwnership({ ...mapped, lines: [] })).toBeNull();
    expect(
      fullInvoiceOwnership({ ...mapped, lines: [mapped.lines[0]!, mapped.lines[0]!] }),
    ).toBeNull();
    expect(
      fullInvoiceOwnership({
        ...mapped,
        lines: Array.from({ length: maxInvoiceLines + 1 }, (_, index) => ({
          id: String(index + 1),
          platformId: '2',
        })),
      }),
    ).toBeNull();
  });
});
