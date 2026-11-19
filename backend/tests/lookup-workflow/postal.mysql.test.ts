import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readConfig } from '../../src/config.js';
import { createDatabases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import {
  locationLookupService,
  postalLookupInput,
} from '../../src/modules/administration/locations.js';
import { createProductionSchema } from '../helpers/production-schema.js';
import { goldenStdout } from '../golden/load.js';
import { fixturePlaceholders } from '../golden/fixture-placeholders.js';

const template = process.env.MYSQL_INTEGRATION_URL;
const sourceLocation = z.union([
  z.object({}).strict(),
  z
    .object({
      pincode: z.string(),
      city: z.string(),
      state: z.string(),
      country: z.string(),
      country_id: z.number(),
      latitude: z.string(),
      longitude: z.string(),
      state_id: z.number(),
    })
    .strict(),
]);
const source = z.object({
  countries: z.array(z.unknown()).length(0),
  postals: z.array(
    z.object({
      status: z.literal('success'),
      message: z.literal('location fetched'),
      data: sourceLocation,
    }),
  ),
  anonymous: z.tuple([z.literal(302), z.literal(302)]),
  nativeWrites: z.literal(0),
});
const operator: Principal = {
  id: '1',
  role: 1,
  userType: 1,
  storeIds: [],
  name: 'Synthetic',
  email: '',
};
/**
 * Pinned `core/views.py:3358 GetLocationByPincodeView` (78d5b63) executed by Django 4.2.5 over
 * this native fixture, replayed from `tests/golden/lookup-workflow/postal-native.json`.
 */
describe.skipIf(!template)('native postal lookup against the pinned Django view', () => {
  let connection: mysql.Connection, db: ReturnType<typeof createDatabases>, url: string;
  const schema = 'pos_rewrite_lookup_' + randomBytes(6).toString('hex');
  beforeAll(async () => {
    const base = new URL(template!);
    if (base.protocol !== 'mysql:' || !['127.0.0.1', 'localhost'].includes(base.hostname))
      throw new Error('Use an isolated loopback MySQL template.');
    connection = await mysql.createConnection({
      host: base.hostname,
      port: Number(base.port || 3306),
      user: decodeURIComponent(base.username),
      password: decodeURIComponent(base.password),
    });
    await createProductionSchema(connection, schema, [
      'deliverable_pincodes',
      'zones',
      'countries',
    ]);
    await connection.query(
      `INSERT INTO countries (id,name,iso_code_2,iso_code_3,address_format,postcode_required,status,sec_status)
       VALUES (1,'India','IN','IND','',1,1,1),(3,'Côte d''Ivoire','CI','CIV','',0,1,1)`,
    );
    await connection.query(
      `INSERT INTO zones (id,country_id,name,gst_state_code,code) VALUES
       (1,1,'Maharashtra',27,'MH'),(2,3,'Île Lagunes',0,'LG')`,
    );
    const pincodes: [number, string, string, number, number, string, string][] = [
      [1, '400001', 'mUMBAI fort', 1, 1, '18.9300', '72.8300'],
      [2, '400001', 'Duplicate later', 1, 1, '0', '0'],
      [3, 'SW1A 1AA', "st. john's wood", 2, 3, '5.3600', '-4.0083'],
      [4, '110001', '', 1, 1, '28.6139', '77.2090'],
      [5, '560001', 'Orphan zone', 99, 1, '12.97', '77.59'],
      [6, 'abc12', 'kolkata-north 2nd', 1, 1, '22.5726', '88.3639'],
      [7, '999999', 'No country', 1, 99, '1', '1'],
    ];
    for (const [id, pincode, city, state, country, latitude, longitude] of pincodes)
      await connection.query(
        `INSERT INTO deliverable_pincodes (id,pincode,zone,country_id,state_id,min_estimated_days,
         max_estimated_days,city,delay_days,serviceability,store_id,hyperlocal_location_id,
         min_estimated_time,max_estimated_time,latitude,longitude,added_by,updated_by,created_at,updated_at)
         VALUES (?,?,'',?,?,0,0,?,0,1,0,0,0,0,?,?,0,0,'2026-11-01 00:00:00','2026-11-01 00:00:00')`,
        [id, pincode, country, state, city, latitude, longitude],
      );
    base.pathname = '/' + schema;
    url = base.href;
    db = createDatabases(
      readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'synthetic-lookup-workflow-secret-'.repeat(3),
        MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
        MYSQL_WRITER_URL: url,
        MYSQL_PRIMARY_READER_URL: url,
        MYSQL_DATA_READER_URL: url,
        BUSINESS_TIMEZONE: 'Asia/Kolkata',
      }),
    );
  }, 30000);
  afterAll(async () => {
    await db?.close();
    await connection?.query(`DROP DATABASE IF EXISTS ${mysql.escapeId(schema)}`);
    await connection?.end();
  });
  it('matches native joins, collation, first duplicate, title casing and coordinate strings', async () => {
    const postals = [
      '400001',
      '400001 ',
      'SW1A 1AA',
      'sw1a 1aa',
      '110001',
      '560001',
      'ABC12',
      '999999',
      '000000',
      '',
      null,
    ];
    const legacy = source.parse(
      JSON.parse(
        goldenStdout(
          'lookup-workflow',
          'postal-native',
          JSON.stringify({ database: url, countries: [], postals }),
          undefined,
          fixturePlaceholders(url),
        ),
      ) as unknown,
    );
    expect(legacy.postals).toHaveLength(postals.length);
    const lookup = locationLookupService(db);
    for (const [index, postal] of postals.entries()) {
      const expected = legacy.postals[index]!;
      const parsed = postalLookupInput.safeParse({ postalCode: postal });
      if (!parsed.success) {
        // Documented divergence: legacy answers an empty or missing pincode with
        // `data: {}`; the rewrite refuses it with a validation error.
        expect(expected.data, String(postal)).toEqual({});
        continue;
      }
      const actual = await lookup.find(operator, parsed.data);
      expect(actual.status).toBe(expected.status);
      expect(actual.message).toBe(expected.message);
      if (!('pincode' in expected.data)) {
        // Rewrite returns `data: null` where legacy returns `{}` (phase-d C35).
        expect(actual.data, String(postal)).toBeNull();
        continue;
      }
      expect(actual.data, String(postal)).toEqual({
        postalCode: expected.data.pincode,
        city: expected.data.city,
        state: expected.data.state,
        country: expected.data.country,
        countryId: String(expected.data.country_id),
        stateId: String(expected.data.state_id),
        latitude: expected.data.latitude,
        longitude: expected.data.longitude,
      });
    }
  });
});
