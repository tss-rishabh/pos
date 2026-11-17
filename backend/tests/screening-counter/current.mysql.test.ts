import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { publicScreeningFixture } from '../public-screening-writer/native-fixture.js';
import {
  counterInstallationSql,
  assertCounterDefinitions,
} from '../../src/modules/legacy-order-imports/screening-counter/writers.js';
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
const template = process.env.CHECKOUT_MYSQL_TEST_URL;
const sourceKey = 'fixture-independent-screening-source-key-'.repeat(2),
  publicationKey = 'fixture-independent-screening-publication-key-'.repeat(2);
describe.skipIf(!template)('native materialized screening counter', () => {
  let f: Awaited<ReturnType<typeof publicScreeningFixture>>;
  beforeAll(async () => {
    f = await publicScreeningFixture(template!);
    await f.reset();
    for (const statement of counterInstallationSql) await f.connection.query(statement);
  }, 30000);
  afterAll(async () => {
    await f?.close();
  });
  it('installs exact trigger/procedure coverage and refuses missing projection rather than zero', async () => {
    const [triggers] = await f.connection.query(
      "SELECT TRIGGER_NAME name,EVENT_OBJECT_TABLE `table`,EVENT_MANIPULATION event,ACTION_TIMING timing,ACTION_STATEMENT statement,DEFINER owner FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME LIKE 'pos_screening_%'",
    );
    const [procedures] = await f.connection.query(
      "SELECT ROUTINE_NAME name,ROUTINE_TYPE type,SECURITY_TYPE security,ROUTINE_DEFINITION statement,DEFINER owner FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE() AND ROUTINE_NAME='pos_screening_sync_marker'",
    );
    expect(() => assertCounterDefinitions(triggers, procedures)).not.toThrow();
    await expect(
      financialTransaction(f.db, true, async (tx) => {
        await lockScreeningCustomer(tx, '77');
        return readCurrentScreeningCounter(tx, '77', {
          contract: 'pos-screening-current-counter-v1',
          publicationKey,
        });
      }),
    ).rejects.toMatchObject({ code: 'SCREENING_COUNTER_PROJECTION_REQUIRED' });
  });
  it('requires a complete independently sealed empty baseline before the first zero read', async () => {
    const capture = await screeningCounterSourceCapture(f.db, sourceKey).capture('77');
    const baseline = sealCounterPublication(capture, sourceKey, publicationKey, {
      generationId: 'a'.repeat(64),
      snapshotId: capture.snapshotId,
      sourceCaptureHash: capture.signature,
      sourceCdcThrough: Date.now(),
      complete: true,
      rows: [],
    });
    await initializeScreeningCounter(f.db, baseline, publicationKey);
    const read = await financialTransaction(f.db, true, async (tx) => {
      await lockScreeningCustomer(tx, '77');
      return readCurrentScreeningCounter(tx, '77', {
        contract: 'pos-screening-current-counter-v1',
        publicationKey,
      });
    });
    expect(read.count).toBe(0n);
    expect(read.baseline.signature).toBe(baseline.publication.signature);
  });
});
