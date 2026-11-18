import { describe, expect, it } from 'vitest';
import {
  batchList,
  batchListCsv,
  validateBatchRequest,
} from '../../src/pages/administration/gift-card-batches/api';

describe('gift card batch page contracts', () => {
  it('validates like the legacy page before posting', () => {
    expect(validateBatchRequest('', 'x')).toBe('Please Enter Valid value');
    expect(validateBatchRequest('0', 'x')).toBe('Size must be greater than zero');
    expect(validateBatchRequest('10001', 'x')).toBe('Size must be less than 10,000');
    expect(validateBatchRequest('10', '')).toBe('Please provide the message');
    expect(validateBatchRequest('10', 'Diwali')).toBeNull();
  });
  it('exports the visible legacy columns with CSV quoting and formula guards', () => {
    const row = {
      id: '9007199254740993',
      size: 2,
      message: '=HYPERLINK("private")',
      completed: true,
      blocked: true,
      printed: false,
      createdBy: 'Fixture, Operator',
      createdAt: '2026-11-16 12:00:00',
    };
    expect(batchListCsv([row])).toBe(
      '"ID","Size","Message","Created By","Created At"\r\n"9007199254740993","2","\'=HYPERLINK(""private"")","Fixture, Operator","2026-11-16 12:00:00"\r\n',
    );
    expect(
      batchList.safeParse({
        draw: 1,
        recordsTotal: '1',
        recordsFiltered: '1',
        start: 0,
        length: 10,
        data: [row],
      }).success,
    ).toBe(true);
  });
});
