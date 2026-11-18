import { executePosSourceOracle } from '../../tools/operational-reports/source-python.js';
import { describe, expect, it } from 'vitest';
import {
  maskCustomerEmail,
  maskCustomerName,
  maskCustomerPhone,
} from '../../src/modules/operational-reports/privacy.js';
describe('restricted-operator customer masking', () => {
  it('matches the actual source helpers for short, Unicode, malformed and international values', () => {
    const cases = [
      { name: 'A', email: 'fixture@example.test', phone: '+91 (12345) 67890' },
      { name: 'Bo', email: 'a@b.test', phone: '123' },
      { name: 'Fixture', email: 'fixture@company.co.in', phone: '१२३४५६७८९०' },
      { name: '😀AB😀', email: 'invalid', phone: '²³⁰⁴⁵⁶' },
      { name: '', email: 'two@@example.test', phone: '' },
    ];
    for (let index = 0; index < 20; index++)
      cases.push({
        name: 'F' + 'x'.repeat(index) + 'Z',
        email: 'x'.repeat(index + 1) + '@' + 'z'.repeat(index + 1) + '.test',
        phone: '1'.repeat(index),
      });
    const expected: unknown = JSON.parse(
      executePosSourceOracle(['tools/operational-reports/privacy-oracle.py'], {
        input: JSON.stringify({ cases }),
        encoding: 'utf8',
      }),
    );
    expect(
      cases.map((value) => ({
        name: maskCustomerName(value.name),
        email: maskCustomerEmail(value.email),
        phone: maskCustomerPhone(value.phone),
      })),
    ).toEqual(expected);
  });
  it('masks missing and broken contacts instead of leaking values on a formatting failure', () => {
    expect(maskCustomerName(null)).toBe('***');
    expect(maskCustomerEmail('@example.test')).toBe('****');
    expect(maskCustomerPhone(null)).toBe('****');
  });
});
