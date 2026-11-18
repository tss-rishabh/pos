import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import mysql, { type RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { buildApp } from '../../../src/app.js';
import { readConfig } from '../../../src/config.js';
import { identityService } from '../../../src/auth/identity.js';
import { mysqlSessions } from '../../../src/auth/sessions.js';
import { seal, verifyDjangoPassword } from '../../../src/auth/crypto.js';
import { migrationPaths, splitMigration } from '../../../src/db/migrations.js';
import { barcodeFixture } from '../barcodes/fixture.js';
import { fixturePassword, sourceCase, type FormCase } from './cases.js';

export const defaultContacts = ['default-contact@example.test', 'archived-default@example.test'];
const result = z.object({
  sourceCommit: z.literal('78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'),
  routeIds: z.array(z.string()),
  hashes: z.record(z.string(), z.string()),
  getStatus: z.number(),
  postStatus: z.number(),
  controls: z.object({
    inputNames: z.array(z.string()),
    hiddenCity: z.string().nullable(),
    selects: z.record(z.string(), z.array(z.string())),
    hasPasswordFields: z.boolean(),
  }),
  formDefaults: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  postal: z.unknown().nullable(),
  validationFields: z.array(z.string()),
  sourcePasswordValid: z.boolean().nullable(),
});
const business = {
  pos_user: [
    'id',
    'username',
    'first_name',
    'last_name',
    'email',
    'phone',
    'contact_email',
    'role',
    'otp_method',
    'user_type',
    'is_active',
    'is_staff',
    'is_superuser',
    'is_mfa',
    'profile_image',
    'cover_image',
  ],
  stores: [
    'id',
    'store_name',
    'short_name',
    'location_code',
    'type',
    'category',
    'latitude',
    'longitude',
    'address',
    'alt_address',
    'city_id',
    'country_id',
    'phone',
    'email',
    'pincode',
    'per_day_threshold',
    'per_hour_threshold',
    'gstin',
    'slack_group_url',
    'city_name',
    'state_name',
    'state_id',
    'franchise_id',
    'store_image',
    'url_key',
    'is_active',
    'ecom_delivery',
    'ecom_threshold',
  ],
  store_counters: ['id', 'store_id', 'counter_name', 'counter_type', 'counter_desc', 'is_active'],
  user_stores: ['id', 'django_user_id', 'store_id'],
  pos_franchise: ['id', 'name', 'description', 'cin_number'],
  users: [
    'id',
    'firstname',
    'lastname',
    'email',
    'telephone',
    'birthdate',
    'gender',
    'user_type',
    'user_platform',
    'pos_admin_id',
    'url_key',
    'cashback',
    'tss_money',
    'tss_points',
    'status',
    'approved',
    'loyalty_group',
    'customer_type',
  ],
} as const;
export type Facts = Record<keyof typeof business, Record<string, unknown>[]>;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function formsFixture(
  connection: string,
  origin: string,
  source: string,
  python: string,
) {
  const url = new URL(connection);
  if (
    url.protocol !== 'mysql:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.port === '54777' ||
    url.pathname !== '/pos_rewrite_forms_workflow' ||
    url.search ||
    url.hash
  )
    throw new Error('EXPLICIT_OWNED_FORMS_FIXTURE_REQUIRED');
  if (new URL(origin).hostname !== '127.0.0.1') throw new Error('LOCAL_APP_ORIGIN_REQUIRED');
  const native = await barcodeFixture(connection);
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let identity: ReturnType<typeof identityService> | undefined;
  try {
    await native.fixture.create([
      'users',
      'user_stores',
      'store_counters',
      'pos_franchise',
      'tss_settings',
      'zones',
      'deliverable_pincodes',
    ]);
    const applied = new Set([
      'src/modules/catalog-details/maintenance-migration.sql',
      'src/modules/administration/barcodes/migration.sql',
    ]);
    for (const filename of migrationPaths) {
      if (applied.has(filename)) continue;
      for (const statement of splitMigration(readFileSync(filename, 'utf8')))
        await native.admin.query(statement);
    }
    const config = readConfig({
      NODE_ENV: 'test',
      DEMO_MODE: 'false',
      WEB_ORIGIN: origin,
      SESSION_SECRET: 'synthetic-native-forms-session-'.repeat(3),
      BUSINESS_TIMEZONE: 'Asia/Kolkata',
      MYSQL_WRITER_URL: native.url,
      MYSQL_PRIMARY_READER_URL: native.url,
      MYSQL_DATA_READER_URL: native.url,
      MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
    });
    identity = identityService(config, native.db);
    const sessions = mysqlSessions(native.db);
    async function reset(input: FormCase) {
      for (const table of [
        'pos_rewrite_sessions',
        'pos_rewrite_operator_auth_epochs',
        ...Object.keys(business),
        'tss_settings',
        'countries',
        'zones',
        'deliverable_pincodes',
      ])
        await native.admin.query('DELETE FROM ' + mysql.escapeId(table));
      for (const table of Object.keys(business))
        await native.admin.query('ALTER TABLE ' + mysql.escapeId(table) + ' AUTO_INCREMENT=1');
      for (const [id, role, userType, active] of [
        ['1', 1, 1, 1],
        ['2', 2, 1, 1],
        ['3', 3, 1, 1],
        ['4', 4, 1, 1],
        ['5', 5, 1, 1],
        ['11', 1, 2, 1],
        ['13', 3, 2, 1],
        ['30', 4, 1, 1],
        ['31', 5, 2, 1],
        ['40', 5, 1, 1],
        ['41', 5, 1, 0],
      ] as const) {
        await native.seed('pos_user', {
          id,
          username: id === '30' ? 'target@example.test' : 'forms-' + id,
          first_name: id === '30' ? 'Target' : 'Actor',
          last_name: id === '30' ? 'Operator' : 'Fixture',
          email: id === '30' ? 'target@example.test' : 'actor-' + id + '@example.test',
          contact_email:
            id === '30'
              ? 'target-contact@example.test'
              : id === '40'
                ? defaultContacts[0]!
                : id === '41'
                  ? defaultContacts[1]!
                  : 'actor-contact-' + id + '@example.test',
          phone: id === '30' ? '9876543230' : '9876543' + id.padStart(3, '0'),
          role,
          user_type: userType,
          is_active: active,
          is_staff: 0,
          is_superuser: 0,
          password: '!',
          otp_method: 2,
        });
        if (id !== '41')
          await native.seed('user_stores', {
            django_user_id: id,
            store_id: userType === 2 ? 2 : 1,
          });
      }
      for (const [id, name, code, category] of [
        ['1', 'Baseline Store', 'BASE', 'IN_HOUSE'],
        ['2', 'Franchise Store', 'FRAN', 'FRANCHISE'],
      ] as const) {
        await native.seed('stores', {
          id,
          store_name: name,
          short_name: id === '1' ? 'Base' : 'Franchise',
          location_code: code,
          type: 'STORE',
          category,
          slack_group_url: input.nullSlackRetention && id === '1' ? null : '',
          phone: '987654320' + id,
          email: id === '1' ? 'baseline-store@example.test' : 'franchise-store@example.test',
          latitude: '19.0000000000000001',
          longitude: '72.0000000000000001',
          address: 'Synthetic main address',
          alt_address: 'Synthetic alternate address',
          city_id: input.cityPreservation && id === '1' ? 7 : 1111,
          state_id: 42,
          country_id: 99,
          pincode: '400001',
          gstin: '22AAAAA0000A1Z5',
          per_day_threshold: 10,
          per_hour_threshold: 2,
          city_name: 'Mumbai',
          state_name: 'Fixture state',
          franchise_id: id === '2' ? 10 : 0,
          is_active: 1,
          store_image: 'uploads/stores/stores_image/default_store_image.jpeg',
          url_key: 'https://thesouledstore.com/?store_id=' + id,
        });
        await native.seed('store_counters', {
          id,
          store_id: id,
          counter_name: 'C1',
          counter_type: 'IN_STORE',
          counter_desc: 'Baseline counter',
          is_active: 1,
        });
      }
      await native.seed('pos_franchise', {
        id: 10,
        name: 'Baseline Franchise',
        description: 'Synthetic franchise description',
        cin_number: 'SYNTHETIC-CIN',
      });
      await native.seed('tss_settings', {
        id: 1,
        platform: 'STORE_LOCATION_CODE',
        value: '["BASE","FRAN","NEW"]',
      });
      await native.seed('countries', { id: 99, name: 'India', status: 1, sec_status: 1 });
      await native.seed('zones', { id: 42, name: 'Fixture state' });
      await native.seed('deliverable_pincodes', {
        id: '9007199254740993',
        pincode: '400001',
        city: 'mumbai',
        state_id: 42,
        country_id: 99,
        latitude: '19.0000000000000001',
        longitude: '72.0000000000000001',
      });
    }
    async function facts(withCredentialDigests = false): Promise<Facts> {
      const values: Partial<Facts> = {};
      const volatile = new Set(['created_at', 'updated_at', 'last_login', 'date_joined']);
      for (const table of Object.keys(business)) {
        const [rows] = await native.admin.query<RowDataPacket[]>(
          'SELECT * FROM ' + mysql.escapeId(table) + ' ORDER BY id',
        );
        values[table as keyof Facts] = rows.map((row) => {
          const projected: Record<string, unknown> = {};
          for (const [field, value] of Object.entries(row)) {
            if (volatile.has(field)) continue;
            if (table === 'pos_user' && field === 'password') {
              if (withCredentialDigests) projected.credential_digest = hash(value);
            } else projected[field] = value;
          }
          return projected;
        });
      }
      return values as Facts;
    }
    async function original(input: FormCase) {
      await reset(input);
      const before = await facts(true);
      const run = spawnSync(python, ['-B', 'tools/administration/forms-workflow/source.py'], {
        input: JSON.stringify({
          database: native.url,
          source,
          defaultContacts,
          case: sourceCase(input),
        }),
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        env: { PATH: process.env.PATH, TZ: 'UTC' },
      });
      const parsed: unknown = JSON.parse(run.stdout || '{}');
      if (run.status !== 0) {
        const safe = z
          .object({
            error: z.literal('SOURCE_FORMS_FAILED'),
            kind: z.string().regex(/^[A-Za-z]+$/),
            mysqlCode: z.number().nullable(),
            frames: z.array(
              z.object({ file: z.string().regex(/^[A-Za-z0-9_.-]+$/), line: z.number() }),
            ),
          })
          .safeParse(parsed);
        throw new Error(
          'SOURCE_CASE_FAILED:' +
            input.id +
            ':' +
            (safe.success ? JSON.stringify(safe.data) : 'bootstrap'),
        );
      }
      const observed = result.parse(parsed);
      return {
        observed,
        before: hash(before),
        after: hash(await facts(true)),
        facts: await facts(),
      };
    }
    async function account(id: string) {
      const user = await identity!.get(id);
      if (!user) throw new Error('NATIVE_FORMS_IDENTITY_UNAVAILABLE');
      const credential = await sessions.create(id, Date.now() + 600000);
      return {
        cookie: {
          name: 'pos_session',
          value: seal({ id, ...credential }, config.SESSION_SECRET),
          url: origin,
          httpOnly: true,
          sameSite: 'Lax' as const,
        },
        user,
        valid: () => sessions.valid(id, credential),
      };
    }
    // Same production registration/configuration as deployment, no injected IDs or handlers.
    if (process.env.STOREDEFAULTUSER !== defaultContacts.join(','))
      throw new Error('EXACT_SOURCE_DEFAULT_CONFIG_REQUIRED');
    return {
      original,
      reset,
      facts,
      account,
      async application() {
        // Each independent source case uses a fresh Django process; the joined
        // candidate case likewise uses a fresh, unmodified production App.
        await app?.close();
        app = await buildApp(config, { logger: false });
        return app.listen({ host: '127.0.0.1', port: 0 });
      },
      fingerprint: async () => hash(await facts(true)),
      async passwordValid(email: string) {
        const [rows] = await native.admin.execute<RowDataPacket[]>(
          'SELECT password FROM pos_user WHERE email=?',
          [email],
        );
        const value = z.array(z.object({ password: z.string() })).parse(rows)[0];
        return value ? verifyDjangoPassword(fixturePassword, value.password) : false;
      },
      async close() {
        await app?.close();
        await identity?.close();
        await native.close();
      },
    };
  } catch (error) {
    await app?.close();
    await identity?.close();
    await native.close();
    throw error;
  }
}
