import { BigQuery } from '@google-cloud/bigquery';
import { describe, expect, it } from 'vitest';
import { normalizeWarehouseParameters } from '../../src/modules/warehouse-parameters.js';

describe('actual pinned BigQuery parameter serialization', () => {
  it.each([
    ['DATE', '2026-11-01', '2026-11-01'],
    ['DATETIME', '2026-11-01 13:00:00.123456', '2026-11-01 13:00:00.123456'],
    ['TIME', '13:00:00.123456', '13:00:00.123456'],
    ['TIMESTAMP', '2026-11-01T07:30:00.123456Z', '2026-11-01T07:30:00.123456Z'],
    ['GEOGRAPHY', 'POINT(72.8777 19.0760)', 'POINT(72.8777 19.0760)'],
  ])('retains the explicit %s value in the wire parameter', (type, input, expected) => {
    const value = normalizeWarehouseParameters({ value: input }, { value: type }).value;
    expect(BigQuery.valueToQueryParameter_(value, type)).toEqual({
      parameterType: { type },
      parameterValue: { value: expected },
    });
  });
  it('retains typed temporal array values and actual SQL NULL elements', () => {
    const values = normalizeWarehouseParameters(
      { dates: ['2026-11-01', null, '2026-11-02'] },
      { dates: ['DATE'] },
    );
    expect(BigQuery.valueToQueryParameter_(values.dates, ['DATE'])).toEqual({
      parameterType: { type: 'ARRAY', arrayType: { type: 'DATE' } },
      parameterValue: {
        arrayValues: [{ value: '2026-11-01' }, { value: null }, { value: '2026-11-02' }],
      },
    });
  });
  it('preserves explicit null, empty arrays, existing wrappers and full-width numeric identities', () => {
    const wrapped = BigQuery.datetime('2026-11-01 13:00:00.123456');
    const input = {
      missing: null,
      empty: [],
      wrapped,
      userId: '9007199254740993',
      flag: true,
      undefinedValue: undefined,
    };
    const result = normalizeWarehouseParameters(input, {
      missing: 'DATE',
      empty: ['DATE'],
      wrapped: 'DATETIME',
      userId: 'INT64',
      flag: 'BOOL',
      undefinedValue: 'DATE',
    });
    expect(result).toEqual(input);
    expect(result.wrapped).toBe(wrapped);
    expect(BigQuery.valueToQueryParameter_(result.userId, 'INT64').parameterValue?.value).toBe(
      '9007199254740993',
    );
  });
  it('wraps a native timestamp without changing its UTC instant', () => {
    const value = normalizeWarehouseParameters(
      { timestamp: new Date('2026-11-01T13:00:00+05:30') },
      { timestamp: 'TIMESTAMP' },
    ).timestamp;
    expect(BigQuery.valueToQueryParameter_(value, 'TIMESTAMP').parameterValue?.value).toBe(
      '2026-11-01T07:30:00.000Z',
    );
  });
  it('removes only SDK timestamp padding and leaves caller-owned wrappers unchanged', () => {
    const original = BigQuery.timestamp('2026-11-01T07:30:00.123456Z');
    const value = normalizeWarehouseParameters(
      { timestamp: original },
      { timestamp: 'TIMESTAMP' },
    ).timestamp;
    expect(BigQuery.valueToQueryParameter_(value, 'TIMESTAMP').parameterValue?.value).toBe(
      '2026-11-01T07:30:00.123456Z',
    );
    expect(original.value).toBe('2026-11-01T07:30:00.123456000Z');
  });
  it('requires callers to round sub-microsecond bounds explicitly instead of silently shifting a filter boundary', () => {
    expect(() =>
      normalizeWarehouseParameters(
        { timestamp: '2026-11-01T07:30:00.123456001Z' },
        { timestamp: 'TIMESTAMP' },
      ),
    ).toThrowError(expect.objectContaining({ code: 'WAREHOUSE_TIMESTAMP_PRECISION' }));
  });
});
