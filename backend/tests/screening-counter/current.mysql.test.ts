import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { currentCounterFixture } from './fixture.js';
import { assertCounterDefinitions } from '../../src/modules/legacy-order-imports/screening-counter/writers.js';
import { readCurrentScreeningCounter } from '../../src/modules/legacy-order-imports/screening-counter/reader.js';
import {
  financialTransaction,
  lockScreeningCustomer,
} from '../../src/modules/legacy-order-imports/screening-transactions.js';
const template = process.env.CHECKOUT_MYSQL_TEST_URL;
const publicationKey = 'fixture-independent-screening-publication-key-'.repeat(2);
describe.skipIf(!template)('native materialized screening counter', () => {
  let f: Awaited<ReturnType<typeof currentCounterFixture>>;
  beforeAll(async () => {
    f = await currentCounterFixture(template!);
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
          headMetadata: f.headMetadata,
        });
      }),
    ).rejects.toMatchObject({ code: 'SCREENING_COUNTER_PROJECTION_REQUIRED' });
  });
  it('requires a complete independently sealed empty baseline before the first zero read', async () => {
    const baseline = await f.initialize('77');
    const read = await financialTransaction(f.db, true, async (tx) => {
      await lockScreeningCustomer(tx, '77');
      return readCurrentScreeningCounter(tx, '77', {
        contract: 'pos-screening-current-counter-v1',
        publicationKey,
        headMetadata: f.headMetadata,
      });
    });
    expect(read.count).toBe(0n);
    expect(read.baseline.signature).toBe(baseline.publication.signature);
  });
});
