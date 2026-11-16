import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  sourceShippingAddress,
  sourceShippingStoreAddress,
  type ShippingAddressParts,
} from '../../src/modules/fulfillment/shipping-label/contracts.js';

describe('pinned shipping-label address formatting', () => {
  it('matches the actual source method across missing fields, paired address lines and Python whitespace', () => {
    const base: ShippingAddressParts = {
      firstName: 'Fixture',
      lastName: 'Recipient',
      flat: '3B',
      address1: 'Fixture road',
      address2: 'Level 2',
      address3: 'Landmark',
      address4: 'Area',
      city: 'Fixture city',
      postcode: '000001',
      phone: '0000000000',
      zoneName: 'Fixture state',
      countryName: 'Fixture country',
    };
    const fields = Object.keys(base) as (keyof ShippingAddressParts)[];
    const vectors = [
      base,
      ...fields.flatMap((field) => [
        { ...base, [field]: null },
        { ...base, [field]: '' },
      ]),
      ...[null, '', '\u0085', '\ufeff', '\u001c', '\u2009'].map((name) => ({
        ...base,
        firstName: name,
        lastName: name,
      })),
      Object.fromEntries(fields.map((field) => [field, null])) as unknown as ShippingAddressParts,
    ];
    const source = spawnSync('python3', ['tools/fulfillment/shipping-label-source-oracle.py'], {
      input: JSON.stringify([null, ...vectors.map((value) => fields.map((field) => value[field]))]),
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(source.status, source.stderr).toBe(0);
    const output = z
      .object({
        query: z.string(),
        addresses: z.array(
          z
            .object({
              name: z.string(),
              address_line: z.string(),
              city_line: z.string(),
              phone_no: z.string(),
            })
            .nullable(),
        ),
      })
      .parse(JSON.parse(source.stdout) as unknown);
    expect(output.addresses[0]).toBeNull();
    expect(output.query).toContain('WHERE o.id = %s');
    expect(vectors.map(sourceShippingAddress)).toEqual(
      output.addresses
        .slice(1)
        .map(
          (value) =>
            value && {
              name: value.name,
              addressLine: value.address_line,
              cityLine: value.city_line,
              phone: value.phone_no,
            },
        ),
    );
  });
  it('preserves source return-address spacing and explicit Python null formatting', () => {
    expect(sourceShippingStoreAddress({ address: 'A', alternateAddress: 'B', phone: '0000' })).toBe(
      'A  B  0000',
    );
    expect(sourceShippingStoreAddress({ address: '', alternateAddress: null, phone: null })).toBe(
      '  None  None',
    );
  });
});
