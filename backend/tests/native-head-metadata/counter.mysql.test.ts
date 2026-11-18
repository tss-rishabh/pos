import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import mysql from 'mysql2/promise';
import { publicScreeningFixture } from '../public-screening-writer/native-fixture.js';
import { installNativeHeadFixture } from './fixture.js';
import { screeningCounterMutation } from '../../src/modules/legacy-order-imports/screening-counter/entry.js';
import { insertCounterFixture } from '../screening-counter/fixture.js';
import { readNativeHeadMetadata } from '../../src/modules/screening-origins/native-head-metadata.js';
import {
  screeningCounterSourceCapture,
  initializeScreeningCounter,
} from '../../src/modules/legacy-order-imports/screening-counter/publisher.js';
import { sealCounterPublication } from '../../src/modules/legacy-order-imports/screening-counter/contracts.js';
import { readCurrentScreeningCounter } from '../../src/modules/legacy-order-imports/screening-counter/reader.js';
import {
  financialTransaction,
  lockScreeningCustomer,
} from '../../src/modules/legacy-order-imports/screening-transactions.js';
const template = process.env.QUOTA_GENERATION_MYSQL_TEST_URL ?? process.env.CHECKOUT_MYSQL_TEST_URL;
const sourceKey = 'full-native-metadata-source-fixture-'.repeat(3),
  publicationKey = 'full-native-metadata-publication-fixture-'.repeat(3);
describe.skipIf(!template)('actual isolated v3 counter publisher account boundary', () => {
  let base: Awaited<ReturnType<typeof publicScreeningFixture>>,
    heads: Awaited<ReturnType<typeof installNativeHeadFixture>>;
  beforeAll(async () => {
    const url = new URL(template!);
    url.pathname = '/pos_rewrite_checkout_test';
    base = await publicScreeningFixture(url.href);
    await base.reset();
    heads = await installNativeHeadFixture(base.connection, template!, { families: ['counter'] });
    for (const [name, value] of Object.entries(heads.environment)) vi.stubEnv(name, value);
  }, 60000);
  afterAll(async () => {
    try {
      await heads?.close();
      await base?.close();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('proves actual isolation across pooled reuse and rejects a session setting spoof', async () => {
    for (let round = 0; round < 8; round++) {
      await base.connection.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await base.connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await base.connection.beginTransaction();
      try {
        const [actual] = await base.connection.query<mysql.RowDataPacket[]>(
          'SELECT pos_rewrite_origin_transaction_metadata() document',
        );
        expect(actual[0]!.document).toEqual([{ state: 'ACTIVE', isolation: 'READ COMMITTED' }]);
        await base.connection.query('CALL pos_screening_sync_marker(0,0,NULL,NULL,NULL)');
      } finally {
        await base.connection.rollback();
      }
      await base.connection.beginTransaction();
      try {
        await base.connection.query('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED');
        const [actual] = await base.connection.query<mysql.RowDataPacket[]>(
          'SELECT pos_rewrite_origin_transaction_metadata() document',
        );
        expect(actual[0]!.document).toEqual([{ state: 'ACTIVE', isolation: 'REPEATABLE READ' }]);
        await expect(
          base.connection.query('CALL pos_screening_sync_marker(0,0,NULL,NULL,NULL)'),
        ).rejects.toThrow('requires current reads');
      } finally {
        await base.connection.rollback();
      }
    }
  });
  it('fails closed when transaction instrumentation is disabled', async () => {
    const controlUrl = new URL(template!);
    controlUrl.pathname = '/' + heads.schema;
    const control = await mysql.createConnection(controlUrl.href);
    await base.connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await base.connection.beginTransaction();
    try {
      await base.connection.query('SELECT pos_rewrite_origin_transaction_metadata()');
      await control.query(
        "UPDATE performance_schema.setup_consumers SET ENABLED='NO' WHERE NAME='events_transactions_current'",
      );
      const [actual] = await base.connection.query<mysql.RowDataPacket[]>(
        'SELECT pos_rewrite_origin_transaction_metadata() document',
      );
      expect(actual[0]!.document).toEqual([]);
      await expect(
        base.connection.query('CALL pos_screening_sync_marker(0,0,NULL,NULL,NULL)'),
      ).rejects.toThrow('requires current reads');
    } finally {
      await control.query(
        "UPDATE performance_schema.setup_consumers SET ENABLED='YES' WHERE NAME='events_transactions_current'",
      );
      await base.connection.rollback();
      await control.end();
    }
  });
  it('qualifies the literal readonly function and complete counter definitions under separate source account', async () => {
    const result = await heads.sourceDb
      .get('writer')
      .transaction((tx) => readNativeHeadMetadata(tx, heads.headMetadata));
    expect(result.counterTriggers).toHaveLength(9);
    expect(result.counterProcedures).toHaveLength(1);
    expect(result.policy.policy).toBe('pos-screening-origin-history-head-integrity-v3');
  });
  it('rejects a nonadministrator SET_USER_ID bypass anywhere in the audited account set and restores after revoke', async () => {
    const account = mysql.escape(heads.names.app) + "@'%'";
    await base.connection.query('GRANT SET_USER_ID ON *.* TO ' + account);
    try {
      await expect(
        heads.sourceDb
          .get('writer')
          .transaction((tx) => readNativeHeadMetadata(tx, heads.headMetadata)),
      ).rejects.toThrow();
    } finally {
      await base.connection.query('REVOKE SET_USER_ID ON *.* FROM ' + account);
    }
    await expect(
      heads.sourceDb
        .get('writer')
        .transaction((tx) => readNativeHeadMetadata(tx, heads.headMetadata)),
    ).resolves.toHaveProperty('counterTriggers');
  });
  it('keeps projection write authority out of application/source accounts and source DML out of publisher', async () => {
    await expect(
      heads.appDb
        .get('writer')
        .execute(sql`INSERT INTO pos_rewrite_screening_counter_heads VALUES(999,0)`),
    ).rejects.toThrow();
    await expect(
      heads.sourceDb.get('writer').execute(sql`UPDATE users SET id=id WHERE id=77`),
    ).rejects.toThrow();
    await expect(
      heads.publisherDb!.get('writer').execute(sql`UPDATE users SET id=id WHERE id=77`),
    ).rejects.toThrow();
    await expect(
      heads
        .publisherDb!.get('writer')
        .transaction((tx) => readNativeHeadMetadata(tx, heads.headMetadata)),
    ).rejects.toThrow();
  });
  it('rejects a projection grant smuggled onto an ordinary application account', async () => {
    const account = mysql.escape(heads.names.app) + "@'%'",
      table = mysql.escapeId(heads.schema) + '.pos_rewrite_screening_counter_heads';
    await base.connection.query('GRANT INSERT ON ' + table + ' TO ' + account);
    try {
      await expect(
        heads.sourceDb
          .get('writer')
          .transaction((tx) => readNativeHeadMetadata(tx, heads.headMetadata)),
      ).rejects.toThrow();
    } finally {
      await base.connection.query('REVOKE INSERT ON ' + table + ' FROM ' + account);
    }
    await expect(
      heads.sourceDb
        .get('writer')
        .transaction((tx) => readNativeHeadMetadata(tx, heads.headMetadata)),
    ).resolves.toHaveProperty('counterTriggers');
  });
  it('permits a shared customer fence but denies financial exclusive locking under SELECT-only publisher permissions', async () => {
    await expect(
      heads
        .publisherDb!.get('writer')
        .transaction((tx) => tx.execute(sql`SELECT id FROM users WHERE id=77 FOR UPDATE`)),
    ).rejects.toThrow();
    const result = await heads
      .publisherDb!.get('writer')
      .transaction((tx) =>
        tx.execute(sql`SELECT CAST(id AS CHAR) AS id FROM users WHERE id=77 FOR SHARE`),
      );
    expect(result[0]).toEqual([{ id: '77' }]);
  });
  async function replacePlatform(statement: string) {
    await base.connection.query('DROP TRIGGER IF EXISTS sys.sys_config_insert_set_user');
    await base.connection.query(
      statement
        .replace(
          'TRIGGER `sys_config_insert_set_user`',
          'TRIGGER `sys`.`sys_config_insert_set_user`',
        )
        .replace(' ON `sys_config`', ' ON `sys`.`sys_config`'),
    );
  }
  async function platformStatement() {
    const [rows] = await base.connection.query<mysql.RowDataPacket[]>(
      'SHOW CREATE TRIGGER sys.sys_config_insert_set_user',
    );
    return String(rows[0]!['SQL Original Statement']);
  }
  it('refuses a changed stock platform trigger body and restores only the exact reviewed definition', async () => {
    const original = await platformStatement();
    try {
      await replacePlatform(original.replace('USER()', "'tampered-owner'"));
      await expect(
        heads.sourceDb
          .get('writer')
          .transaction((tx) => readNativeHeadMetadata(tx, heads.headMetadata)),
      ).rejects.toThrow();
    } finally {
      await replacePlatform(original);
    }
    await expect(
      heads.sourceDb
        .get('writer')
        .transaction((tx) => readNativeHeadMetadata(tx, heads.headMetadata)),
    ).resolves.toHaveProperty('counterTriggers');
  });
  it('refuses a re-owned stock trigger even under another explicitly trusted administrator', async () => {
    const original = await platformStatement();
    try {
      await replacePlatform(
        original.replace('DEFINER=`mysql.sys`@`localhost`', "DEFINER='root'@'%'"),
      );
      await expect(
        heads.sourceDb
          .get('writer')
          .transaction((tx) => readNativeHeadMetadata(tx, heads.headMetadata)),
      ).rejects.toThrow();
    } finally {
      await replacePlatform(original);
    }
    await expect(
      heads.sourceDb
        .get('writer')
        .transaction((tx) => readNativeHeadMetadata(tx, heads.headMetadata)),
    ).resolves.toHaveProperty('counterTriggers');
  });
  it('refuses any additional DBA implicit trigger outside the closed stock registry', async () => {
    await base.connection.query(
      'CREATE TRIGGER fixture_unknown_dba_trigger BEFORE UPDATE ON users FOR EACH ROW SET @fixture_unknown=1',
    );
    try {
      await expect(
        heads.sourceDb
          .get('writer')
          .transaction((tx) => readNativeHeadMetadata(tx, heads.headMetadata)),
      ).rejects.toThrow();
    } finally {
      await base.connection.query('DROP TRIGGER fixture_unknown_dba_trigger');
    }
    await expect(
      heads.sourceDb
        .get('writer')
        .transaction((tx) => readNativeHeadMetadata(tx, heads.headMetadata)),
    ).resolves.toHaveProperty('counterTriggers');
  });
  it('seeds under the minimal publisher ACL and reads under the unprivileged application account', async () => {
    const snapshot = await screeningCounterSourceCapture(
        heads.sourceDb,
        sourceKey,
        Date.now,
        heads.headMetadata,
      ).snapshot('77'),
      c = snapshot.capture;
    const baseline = sealCounterPublication(c, sourceKey, publicationKey, {
      generationId: 'a'.repeat(64),
      snapshotId: c.snapshotId,
      sourceCaptureHash: c.signature,
      sourceCdcThrough: Date.now(),
      complete: true,
      rows: snapshot.rows,
    });
    await initializeScreeningCounter(
      heads.publisherDb!,
      baseline,
      publicationKey,
      null,
      Date.now(),
      {
        headMetadata: heads.headMetadata,
        configuration: snapshot.configuration,
        purpose: 'counter-publication',
      },
    );
    const current = await financialTransaction(heads.appDb, true, async (tx) => {
      await lockScreeningCustomer(tx, '77');
      return readCurrentScreeningCounter(tx, '77', {
        contract: 'pos-screening-current-counter-v1',
        publicationKey,
        headMetadata: heads.headMetadata,
      });
    });
    expect(current.count).toBe(0n);
    expect(current.baseline.signature).toBe(baseline.publication.signature);
  });
  it('captures exact nonempty native facts and fences a publication behind an already-owned source customer', async () => {
    const parents = { customerIds: ['77'], orderIds: ['501'], lineIds: ['601'] };
    await screeningCounterMutation(heads.appDb, parents, async (tx) => {
      await insertCounterFixture(tx, 'orders', { id: '501', user_id: '77', order_status: 1 });
      await insertCounterFixture(tx, 'has_products', {
        id: '601',
        order_id: '501',
        prod_id: '390238',
        qty: 1,
      });
      await tx.execute(
        sql`INSERT INTO spiderman_screening_orders(id,order_id,has_product_id,user_id) VALUES(1,501,601,77)`,
      );
    });
    const snapshot = await screeningCounterSourceCapture(
        heads.sourceDb,
        sourceKey,
        Date.now,
        heads.headMetadata,
      ).snapshot('77'),
      c = snapshot.capture;
    expect(c.count).toBe('1');
    expect(snapshot.rows).toEqual([
      { markerId: '1', orderId: '501', lineId: '601', included: true },
    ]);
    const candidate = sealCounterPublication(c, sourceKey, publicationKey, {
      generationId: 'b'.repeat(64),
      snapshotId: c.snapshotId,
      sourceCaptureHash: c.signature,
      sourceCdcThrough: Date.now(),
      complete: true,
      rows: snapshot.rows,
    });
    let ready!: () => void, release!: () => void;
    const held = new Promise<void>((resolve) => {
        ready = resolve;
      }),
      proceed = new Promise<void>((resolve) => {
        release = resolve;
      });
    const writer = screeningCounterMutation(heads.appDb, parents, async (tx) => {
      ready();
      await proceed;
      await tx.execute(sql`UPDATE orders SET order_status=17 WHERE id=501`);
    });
    await held;
    let settled = false;
    const publication = initializeScreeningCounter(
      heads.publisherDb!,
      candidate,
      publicationKey,
      'a'.repeat(64),
      Date.now(),
      {
        headMetadata: heads.headMetadata,
        configuration: snapshot.configuration,
        purpose: 'counter-publication',
      },
    ).finally(() => {
      settled = true;
    });
    void publication.catch(() => undefined);
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(settled).toBe(false);
    } finally {
      release();
    }
    await writer;
    await expect(publication).rejects.toMatchObject({ code: 'SCREENING_COUNTER_SOURCE_CHANGED' });
    const current = await financialTransaction(heads.appDb, true, async (tx) => {
      await lockScreeningCustomer(tx, '77');
      return readCurrentScreeningCounter(tx, '77', {
        contract: 'pos-screening-current-counter-v1',
        publicationKey,
        headMetadata: heads.headMetadata,
      });
    });
    expect(current.count).toBe(0n);
    expect(current.baseline.generationId).toBe('a'.repeat(64));
  });
});
