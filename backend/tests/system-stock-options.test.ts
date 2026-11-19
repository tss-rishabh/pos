import { describe, expect, it } from 'vitest';
import {
  configuredSystemStockProjection,
  systemStockProjectionContract,
} from '../src/db/stock-projection/options.js';
import { projectionContract } from '../src/db/stock-projection/domain.js';

describe('explicit trusted system stock capability', () => {
  const config = { BUSINESS_TIMEZONE: 'Asia/Kolkata' };
  it('requires both the ordinary storage contract and the separate system actor contract', () => {
    expect(configuredSystemStockProjection(config, {})).toBeUndefined();
    expect(
      configuredSystemStockProjection(config, {
        POS_STOCK_PROJECTION_CONTRACT: projectionContract,
      }),
    ).toBeUndefined();
    expect(
      configuredSystemStockProjection(config, {
        POS_SYSTEM_STOCK_PROJECTION_CONTRACT: systemStockProjectionContract,
      }),
    ).toBeUndefined();
    expect(
      typeof configuredSystemStockProjection(config, {
        POS_STOCK_PROJECTION_CONTRACT: projectionContract,
        POS_SYSTEM_STOCK_PROJECTION_CONTRACT: systemStockProjectionContract,
      }),
    ).toBe('function');
  });
  it('does not accept an unknown contract', () => {
    expect(() =>
      configuredSystemStockProjection(config, {
        POS_STOCK_PROJECTION_CONTRACT: projectionContract,
        POS_SYSTEM_STOCK_PROJECTION_CONTRACT: 'unverified',
      }),
    ).toThrow();
  });
});
