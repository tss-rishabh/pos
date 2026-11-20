import { describe, expect, it } from 'vitest';
import { pythonFloatDict, pythonJsonDumps, pythonRepr } from '../../src/domain/python-compat.js';
import {
  legacyLocationIdsText,
  locationStoreIds,
  parseLocationIds,
} from '../../src/modules/legacy-fulfillment/python-text.js';

describe('legacy Python text renderings stored by hyperlocal views', () => {
  it('renders str(dict) and str(list) as Python does', () => {
    expect(pythonRepr({})).toBe('{}');
    expect(pythonRepr([2, 3])).toBe('[2, 3]');
    expect(pythonRepr(['2', '3'])).toBe("['2', '3']");
    expect(pythonRepr({ 'Store Address': ['invalid_value'], 'Start Datetime': null })).toBe(
      "{'Store Address': ['invalid_value'], 'Start Datetime': None}",
    );
    expect(pythonRepr("it's")).toBe('"it\'s"');
    expect(pythonFloatDict({ 'tss point refunded': 0, 'tss money refunded': 12.5 })).toBe(
      "{'tss point refunded': 0.0, 'tss money refunded': 12.5}",
    );
  });
  it('renders json.dumps with ensure_ascii and Python separators', () => {
    expect(pythonJsonDumps({ order_id: '12', store_id: '4' })).toBe(
      '{"order_id": "12", "store_id": "4"}',
    );
    expect(pythonJsonDumps({ text: '🛵 ok', list: [1, true, null] })).toBe(
      '{"text": "\\ud83d\\udef5 ok", "list": [1, true, null]}',
    );
  });
  it('keeps raw next_location_ids text or the decoded list, as legacy passes either', () => {
    expect(legacyLocationIdsText('[2,3]', false)).toBe('[2,3]');
    expect(legacyLocationIdsText(null, false)).toBe('None');
    expect(legacyLocationIdsText(' [2, "3"] ', true)).toBe("[2, '3']");
    expect(parseLocationIds('not json')).toEqual([]);
    expect(locationStoreIds(parseLocationIds('[2, "3", "x", 0]'))).toEqual(['2', '3']);
  });
});
