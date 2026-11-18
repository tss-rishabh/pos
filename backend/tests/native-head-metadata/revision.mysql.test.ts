import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import mysql from 'mysql2/promise';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installNativeHeadFixture, nativeHeadReviewStatements } from './fixture.js';
import { readNativeHeadMetadata } from '../../src/modules/screening-origins/native-head-metadata.js';
import { nativeMembershipFenceDefinitions } from '../../src/modules/checkout/cancellations/membership-fence-contract.js';

const template = process.env.MEMBERSHIP_HEAD_MYSQL_TEST_URL;
describe.skipIf(!template)('real restricted membership revision metadata', () => {
  let admin: mysql.Connection, heads: Awaited<ReturnType<typeof installNativeHeadFixture>>;
  const schema = 'native_head_revision_' + randomUUID().replaceAll('-', '').slice(0, 12);
  const account = (name: string) => mysql.escape(name) + "@'%'";
  const target = (name: string) => mysql.escapeId(schema) + '.' + mysql.escapeId(name);
  const node = () =>
    heads.appDb.get('writer').transaction((tx) => readNativeHeadMetadata(tx, heads.headMetadata));
  const python = () =>
    z
      .object({
        allowed: z.boolean(),
        revisionTriggers: z.number(),
        appVisibleTriggers: z.number(),
      })
      .strict()
      .parse(
        JSON.parse(
          execFileSync(
            'compatibility/upstream/offline-cash-pricing/.venv/bin/python',
            ['-B', 'tools/native-head-metadata/revision-native.py'],
            {
              input: JSON.stringify({ url: heads.appUrl, environment: heads.environment }),
              encoding: 'utf8',
              maxBuffer: 2048,
            },
          ),
        ) as unknown,
      );
  async function refused() {
    await expect(node()).rejects.toThrow('SCREENING_ORIGIN_HISTORY_UNQUALIFIED');
    expect(python().allowed).toBe(false);
  }
  async function trigger(name: string) {
    const [rows] = await admin.query<mysql.RowDataPacket[]>(
      'SHOW CREATE TRIGGER ' + mysql.escapeId(name),
    );
    return String(rows[0]!['SQL Original Statement']);
  }
  async function installMetadata() {
    await admin.query('DROP FUNCTION IF EXISTS pos_rewrite_origin_history_metadata');
    const original = nativeHeadReviewStatements(
      readFileSync('compatibility/upstream/screening-origins/history-security.review.sql', 'utf8'),
    )[0]!;
    await admin.query(
      original.replace("'pos_origin_history_audit'@'%'", account(heads.names.audit)),
    );
    for (const name of [heads.names.audit, heads.names.source, heads.names.app])
      await admin.query(
        'GRANT EXECUTE ON FUNCTION ' +
          target('pos_rewrite_origin_history_metadata') +
          ' TO ' +
          account(name),
      );
  }
  beforeAll(async () => {
    const url = new URL(template!);
    if (
      url.protocol !== 'mysql:' ||
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      url.username !== 'root' ||
      url.pathname !== '/pos_rewrite_checkout_test' ||
      url.search ||
      url.hash
    )
      throw new Error('Disposable local membership-head fixture required');
    admin = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: 'root',
      password: decodeURIComponent(url.password),
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
    });
    await admin.query('CREATE DATABASE ' + mysql.escapeId(schema));
    await admin.changeUser({ database: schema });
    heads = await installNativeHeadFixture(admin, template!, { families: ['membershipRevision'] });
    await heads.fixture.insert('users', { id: '77', email: 'native-revision@example.test' });
  }, 60000);
  afterAll(async () => {
    try {
      await heads?.close();
    } finally {
      if (admin) {
        await admin.query('DROP DATABASE IF EXISTS ' + mysql.escapeId(schema));
        await admin.end();
      }
    }
  });
  it('returns all four exact raw bodies through two fixed functions with zero app-visible triggers', async () => {
    const [raw] = await admin.query<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME IN ('pos_rewrite_mem_eav_insert','pos_rewrite_mem_eav_update','pos_rewrite_mem_eav_delete','pos_rewrite_mem_user_email')",
    );
    expect(Number(raw[0]!.n)).toBe(4);
    const result = await node();
    expect(
      result.membershipRevisionTriggers
        .map((row) => ({
          name: row.name,
          event: row.event,
          table: row.tableName,
          timing: row.timing,
          hash: row.hash,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ).toEqual([...nativeMembershipFenceDefinitions].sort((a, b) => a.name.localeCompare(b.name)));
    expect(result.membershipTriggers).toEqual([]);
    expect(python()).toEqual({ allowed: true, revisionTriggers: 4, appVisibleTriggers: 0 });
  });
  it('preserves native EAV revisions and legitimate application version increment/rollback', async () => {
    await heads.appDb.get('writer').transaction(async (tx) => {
      await tx.execute(
        sql`INSERT INTO user_eav(entity,attribute,value,is_active,created_at,updated_at) VALUES('native-revision@example.test','EXCLUSIVE_MEMBER','1',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
      );
      await tx.execute(
        sql`UPDATE pos_rewrite_membership_versions SET revision=revision+1 WHERE customer_id=77`,
      );
      await readNativeHeadMetadata(tx, heads.headMetadata);
    });
    const [before] = await admin.query<mysql.RowDataPacket[]>(
      'SELECT revision FROM pos_rewrite_membership_versions WHERE customer_id=77',
    );
    expect(String(before[0]!.revision)).toBe('2');
    await expect(
      heads.appDb.get('writer').transaction(async (tx) => {
        await tx.execute(
          sql`UPDATE user_eav SET value='0' WHERE entity='native-revision@example.test' AND attribute='EXCLUSIVE_MEMBER'`,
        );
        throw new Error('ROLLBACK_FIXTURE');
      }),
    ).rejects.toThrow('ROLLBACK_FIXTURE');
    const [after] = await admin.query<mysql.RowDataPacket[]>(
      'SELECT revision FROM pos_rewrite_membership_versions WHERE customer_id=77',
    );
    expect(String(after[0]!.revision)).toBe('2');
    await expect(node()).resolves.toHaveProperty('membershipRevisionTriggers');
  });
  it('refuses missing native owner rights before writes', async () => {
    await admin.query(
      'REVOKE UPDATE ON ' +
        target('pos_rewrite_membership_versions') +
        ' FROM ' +
        account(heads.names.membershipRevision),
    );
    try {
      await refused();
    } finally {
      await admin.query(
        'GRANT UPDATE ON ' +
          target('pos_rewrite_membership_versions') +
          ' TO ' +
          account(heads.names.membershipRevision),
      );
    }
  });
  it('requires exactly the native locking id privilege and rejects other column/table updates', async () => {
    const who = account(heads.names.membershipRevision),
      object = target('users');
    await admin.query('REVOKE UPDATE(id) ON ' + object + ' FROM ' + who);
    try {
      await refused();
    } finally {
      await admin.query('GRANT UPDATE(id) ON ' + object + ' TO ' + who);
    }
    for (const right of ['UPDATE(email)', 'UPDATE']) {
      await admin.query('GRANT ' + right + ' ON ' + object + ' TO ' + who);
      try {
        await refused();
      } finally {
        await admin.query('REVOKE ' + right + ' ON ' + object + ' FROM ' + who);
        // MySQL table-level REVOKE UPDATE also removes existing column UPDATE
        // grants. Restore the one qualified locking column after the canary.
        await admin.query('GRANT UPDATE(id) ON ' + object + ' TO ' + who);
      }
    }
    expect(python().allowed).toBe(true);
  });
  it('rejects application TRIGGER permission and any role edge to the isolated owner', async () => {
    await admin.query('GRANT TRIGGER ON ' + target('user_eav') + ' TO ' + account(heads.names.app));
    try {
      await refused();
    } finally {
      await admin.query(
        'REVOKE TRIGGER ON ' + target('user_eav') + ' FROM ' + account(heads.names.app),
      );
    }
    const role = 'revision_role_' + randomUUID().replaceAll('-', '').slice(0, 8);
    await admin.query('CREATE ROLE ' + account(role));
    try {
      await admin.query(
        'GRANT ' + account(role) + ' TO ' + account(heads.names.membershipRevision),
      );
      await refused();
    } finally {
      await admin.query(
        'REVOKE ' + account(role) + ' FROM ' + account(heads.names.membershipRevision),
      );
      await admin.query('DROP ROLE ' + account(role));
    }
    expect(python().allowed).toBe(true);
  });
  it.each(['DELETE', 'EXECUTE'] as const)(
    'refuses extra %s for the isolated owner',
    async (right) => {
      const object =
        right === 'DELETE'
          ? target('pos_rewrite_membership_versions')
          : 'FUNCTION ' + target('pos_rewrite_origin_history_metadata');
      await admin.query(
        'GRANT ' + right + ' ON ' + object + ' TO ' + account(heads.names.membershipRevision),
      );
      try {
        await refused();
      } finally {
        await admin.query(
          'REVOKE ' + right + ' ON ' + object + ' FROM ' + account(heads.names.membershipRevision),
        );
      }
    },
  );
  it('refuses a missing, altered or non-strict fence and accepts only its exact restoration', async () => {
    const name = nativeMembershipFenceDefinitions[0]!.name,
      original = await trigger(name);
    await admin.query('DROP TRIGGER ' + mysql.escapeId(name));
    try {
      await refused();
    } finally {
      await admin.query(original);
    }
    await admin.query('DROP TRIGGER ' + mysql.escapeId(name));
    try {
      await admin.query(original.replace('VALUES(owner_id,1)', 'VALUES(owner_id,2)'));
      await refused();
    } finally {
      await admin.query('DROP TRIGGER ' + mysql.escapeId(name));
      await admin.query(original);
    }
    await admin.query('DROP TRIGGER ' + mysql.escapeId(name));
    try {
      await admin.query("SET SESSION sql_mode=''");
      await admin.query(original);
      await refused();
    } finally {
      await admin.query('DROP TRIGGER ' + mysql.escapeId(name));
      await admin.query("SET SESSION sql_mode='STRICT_TRANS_TABLES'");
      await admin.query(original);
    }
    expect(python().allowed).toBe(true);
  });
  it('refuses an unlocked owner, restored root owner and unselected installed family', async () => {
    await admin.query('ALTER USER ' + account(heads.names.membershipRevision) + ' ACCOUNT UNLOCK');
    try {
      await refused();
    } finally {
      await admin.query('ALTER USER ' + account(heads.names.membershipRevision) + ' ACCOUNT LOCK');
    }
    const name = nativeMembershipFenceDefinitions[0]!.name,
      original = await trigger(name);
    await admin.query('DROP TRIGGER ' + mysql.escapeId(name));
    try {
      await admin.query(original.replace(/DEFINER=`[^`]+`@`[^`]+`/, 'DEFINER=CURRENT_USER'));
      await refused();
    } finally {
      await admin.query('DROP TRIGGER ' + mysql.escapeId(name));
      await admin.query(original);
    }
    const { membershipRevisionDefiner: _selected, ...oldOptions } = heads.headMetadata;
    await expect(
      heads.appDb.get('writer').transaction((tx) => readNativeHeadMetadata(tx, oldOptions)),
    ).rejects.toThrow('SCREENING_ORIGIN_HISTORY_UNQUALIFIED');
    expect(python().allowed).toBe(true);
  });
  it('refuses the old/malformed readonly metadata function instead of using app TRIGGER visibility', async () => {
    await admin.query('DROP FUNCTION pos_rewrite_origin_history_metadata');
    try {
      await admin.query(
        'CREATE DEFINER=' +
          account(heads.names.audit) +
          ' FUNCTION pos_rewrite_origin_history_metadata() RETURNS JSON READS SQL DATA SQL SECURITY DEFINER RETURN JSON_OBJECT()',
      );
      await refused();
    } finally {
      await installMetadata();
    }
    expect(python().allowed).toBe(true);
  });
  it('requires an actual native transaction and holds table MDL through the caller commit', async () => {
    await expect(
      readNativeHeadMetadata(heads.appDb.get('writer'), heads.headMetadata),
    ).rejects.toThrow('SCREENING_ORIGIN_HISTORY_UNQUALIFIED');
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
      }),
      ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
    const pending = heads.appDb.get('writer').transaction(async (tx) => {
      await readNativeHeadMetadata(tx, heads.headMetadata);
      entered();
      await held;
    });
    await Promise.race([ready, pending]);
    try {
      await admin.query('SET SESSION lock_wait_timeout=1');
      await expect(
        admin.query('DROP TRIGGER ' + mysql.escapeId(nativeMembershipFenceDefinitions[0]!.name)),
      ).rejects.toHaveProperty('code', 'ER_LOCK_WAIT_TIMEOUT');
    } finally {
      release();
      await pending;
      await admin.query('SET SESSION lock_wait_timeout=31536000');
    }
    expect(python().allowed).toBe(true);
  });
});
