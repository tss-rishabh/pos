import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import mysql from 'mysql2/promise';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { publicScreeningFixture } from '../public-screening-writer/native-fixture.js';
import { installNativeHeadFixture } from './fixture.js';
import { readNativeHeadMetadata } from '../../src/modules/screening-origins/native-head-metadata.js';
import { nativeHeadLimits } from '../../src/modules/screening-origins/native-head-capacity.js';

const template =
  process.env.NATIVE_HEAD_CAPACITY_MYSQL_TEST_URL ?? process.env.CHECKOUT_MYSQL_TEST_URL;
const catalog = z
  .object({
    tables: z.array(
      z.object({
        table: z.string().regex(/^[a-z][a-z0-9_]*$/),
        actions: z.array(z.enum(['SELECT', 'INSERT', 'UPDATE', 'DELETE'])),
      }),
    ),
  })
  .parse(
    JSON.parse(
      readFileSync('tools/native-head-metadata/node-writer-minimum.review.json', 'utf8'),
    ) as unknown,
  );
describe.skipIf(!template)(
  'actual full Node table-grant installation and cross-language capacities',
  () => {
    let base: Awaited<ReturnType<typeof publicScreeningFixture>>,
      heads: Awaited<ReturnType<typeof installNativeHeadFixture>>;
    const extraUsers: string[] = [],
      padding: string[] = [];
    const account = (name: string) => mysql.escape(name) + "@'%'";
    const target = (name: string) => mysql.escapeId(heads.schema) + '.' + mysql.escapeId(name);
    async function addUser(label: string) {
      const name = 'cap_' + label + '_' + randomUUID().slice(0, 8);
      await base.connection.query('CREATE USER ' + account(name));
      extraUsers.push(name);
      return name;
    }
    async function grant(name: string, table: string, rights: readonly string[]) {
      await base.connection.query(
        'GRANT ' + rights.join(',') + ' ON ' + target(table) + ' TO ' + account(name),
      );
    }
    async function statements() {
      const [raw] = await heads.appDb
        .get('writer')
        .execute(sql.raw('SHOW GRANTS FOR CURRENT_USER()'));
      return z
        .array(z.record(z.string(), z.string()))
        .parse(raw)
        .map((row) => Object.values(row)[0]!);
    }
    async function node() {
      return heads.appDb.get('writer').transaction(
        async (tx) => {
          await tx.execute(sql`SELECT COUNT(*) FROM users`);
          return readNativeHeadMetadata(tx, heads.headMetadata);
        },
        { isolationLevel: 'read committed' },
      );
    }
    function python() {
      return z.object({ allowed: z.boolean() }).parse(
        JSON.parse(
          execFileSync(
            'compatibility/upstream/offline-cash-pricing/.venv/bin/python',
            ['tools/native-head-metadata/capacity-native.py'],
            {
              input: JSON.stringify({ url: heads.appUrl, environment: heads.environment }),
              encoding: 'utf8',
              maxBuffer: 1024,
            },
          ),
        ) as unknown,
      ).allowed;
    }
    async function cells() {
      const [raw] = await base.connection.query<mysql.RowDataPacket[]>(
        'SELECT pos_rewrite_origin_history_metadata() document',
      );
      const value: unknown =
        typeof raw[0]!.document === 'string' ? JSON.parse(raw[0]!.document) : raw[0]!.document;
      return z.object({ privileges: z.array(z.unknown()) }).parse(value).privileges.length;
    }
    beforeAll(async () => {
      base = await publicScreeningFixture(template!, { nativeHeads: false });
      await base.reset();
      heads = await installNativeHeadFixture(base.connection, template!, {
        families: ['counter', 'membership', 'coupon'],
      });
      // Real application table targets/rights, not reflected-only tables or
      // blanket CRUD. Unused fixture tables contain only a synthetic PK.
      const [existing] = await base.connection.query<mysql.RowDataPacket[]>(
        'SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=?',
        [heads.schema],
      );
      const names = new Set(existing.map((row) => String(row.name)));
      for (const row of catalog.tables) {
        if (!names.has(row.table))
          await base.connection.query(
            'CREATE TABLE ' + target(row.table) + '(id BIGINT PRIMARY KEY) ENGINE=InnoDB',
          );
        await grant(heads.names.app, row.table, row.actions);
      }
      // A declared capacity scenario with two additional strictly readonly
      // participants. These are not asserted to be the minimum read-pool grants.
      for (const label of ['primary', 'data']) {
        const name = await addUser(label);
        for (const row of catalog.tables.filter((row) => row.actions.includes('SELECT')))
          await grant(name, row.table, ['SELECT']);
      }
    }, 60000);
    afterAll(async () => {
      try {
        for (const name of extraUsers)
          await base?.connection.query('DROP USER IF EXISTS ' + account(name));
      } finally {
        await heads?.close();
        await base?.close();
      }
    });
    it('accepts the measured writer beyond65 rows, inspects combined cells beyond1000 and denies unsafe scopes', async () => {
      expect((await statements()).length).toBeGreaterThan(65);
      expect(await cells()).toBeGreaterThan(1000);
      await expect(node()).resolves.toBeDefined();
      expect(python()).toBe(true);
      for (const object of [
        target('pos_rewrite_screening_counter_heads'),
        mysql.escapeId(heads.schema) + '.*',
      ]) {
        await base.connection.query(
          'GRANT UPDATE ON ' + object + ' TO ' + account(heads.names.app),
        );
        try {
          await expect(node()).rejects.toThrow('SCREENING_ORIGIN_HISTORY_UNQUALIFIED');
          expect(python()).toBe(false);
        } finally {
          await base.connection.query(
            'REVOKE UPDATE ON ' + object + ' FROM ' + account(heads.names.app),
          );
        }
      }
      const role = await addUser('role');
      await base.connection.query('GRANT ' + account(role) + ' TO ' + account(heads.names.app));
      try {
        await expect(node()).rejects.toThrow();
        expect(python()).toBe(false);
      } finally {
        await base.connection.query(
          'REVOKE ' + account(role) + ' FROM ' + account(heads.names.app),
        );
      }
      await expect(node()).resolves.toBeDefined();
      expect(python()).toBe(true);
    }, 30000);
    it('accepts exact512 complete rows and rejects the513th without using a validated prefix', async () => {
      const count = (await statements()).length;
      for (let index = count; index <= nativeHeadLimits.callerGrantRows; index++) {
        const name = 'capacity_padding_' + index;
        await base.connection.query(
          'CREATE TABLE ' + target(name) + '(id BIGINT PRIMARY KEY) ENGINE=InnoDB',
        );
        padding.push(name);
        await grant(heads.names.app, name, ['SELECT']);
        if (index === nativeHeadLimits.callerGrantRows - 1) {
          expect(await statements()).toHaveLength(512);
          await expect(node()).resolves.toBeDefined();
          expect(python()).toBe(true);
        }
      }
      expect(await statements()).toHaveLength(513);
      await expect(node()).rejects.toThrow();
      expect(python()).toBe(false);
      await base.connection.query(
        'REVOKE SELECT ON ' + target(padding.at(-1)!) + ' FROM ' + account(heads.names.app),
      );
      await expect(node()).resolves.toBeDefined();
      expect(python()).toBe(true);
    }, 30000);
    it('accepts exactly4096 global cells and returns/refuses the4097th sentinel across both consumers', async () => {
      const writers = [];
      for (let index = 0; index < 4; index++) writers.push(await addUser('other' + index));
      let remaining = nativeHeadLimits.privilegeRows - (await cells());
      for (const name of writers) {
        for (const table of padding) {
          if (remaining <= 0) break;
          const rights = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].slice(0, Math.min(remaining, 4));
          await grant(name, table, rights);
          remaining -= rights.length;
        }
        if (remaining <= 0) break;
      }
      expect(remaining).toBe(0);
      expect(await cells()).toBe(4096);
      await expect(node()).resolves.toBeDefined();
      expect(python()).toBe(true);
      const extra = await addUser('overflow');
      // Account creation may itself add USAGE; measure, then add one table cell
      // only when necessary. The SQL sentinel must remain intact either way.
      if ((await cells()) === 4096) await grant(extra, padding[0]!, ['SELECT']);
      expect(await cells()).toBe(4097);
      await expect(node()).rejects.toThrow();
      expect(python()).toBe(false);
    }, 60000);
  },
);
