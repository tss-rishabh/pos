import {
  counterDigest,
  counterRowsHash,
  type CounterCapture,
  type CounterRow,
} from '../../src/modules/legacy-order-imports/screening-counter/contracts.js';
import { counterDefinitionHash } from '../../src/modules/legacy-order-imports/screening-counter/writers.js';
import {
  sealCounterGenerationSnapshot,
  counterGenerationContract,
} from '../../src/modules/legacy-order-imports/screening-counter/counter-generation-contracts.js';
import { readCounterGenerationOptions } from '../../src/modules/legacy-order-imports/screening-counter/counter-generation-options.js';
export const generationSourceKey = 'isolated-quota-source-key-'.repeat(3),
  generationJournalKey = 'isolated-quota-journal-key-'.repeat(3),
  generationPublicationKey = 'isolated-quota-publication-key-'.repeat(3);
export const generationNow = Date.parse('2026-11-18T12:00:00Z');
export function generationEnvironment() {
  return {
    DEMO_MODE: 'false',
    POS_SCREENING_COUNTER_GENERATION_CONTRACT: counterGenerationContract,
    POS_SCREENING_COUNTER_GENERATION_SOURCE_URL:
      'mysql://quota_source:fixture@127.0.0.1:3306/fixture',
    POS_SCREENING_COUNTER_GENERATION_PROJECTION_URL:
      'mysql://quota_publisher:fixture@127.0.0.1:3306/fixture',
    POS_SCREENING_COUNTER_GENERATION_SOURCE_SERVER_UUID: '11111111-1111-4111-8111-111111111111',
    POS_SCREENING_COUNTER_GENERATION_SOURCE_SCHEMA: 'fixture',
    POS_SCREENING_COUNTER_GENERATION_SOURCE_KEY: generationSourceKey,
    POS_SCREENING_COUNTER_PUBLICATION_KEY: generationPublicationKey,
    POS_SCREENING_COUNTER_GENERATION_JOURNAL_KEY: generationJournalKey,
    POS_SCREENING_COUNTER_GENERATION_READER_KEY_FILE: '/fixture/reader.json',
    POS_SCREENING_COUNTER_GENERATION_WRITER_KEY_FILE: '/fixture/writer.json',
    BQ_SCREENING_COUNTER_PUBLICATIONS_VIEW: 'tssgcp2025.tss_mysql_raw_layer.counter_publications',
    BQ_SCREENING_COUNTER_ROWS_VIEW: 'tssgcp2025.tss_mysql_raw_layer.counter_rows',
    POS_SCREENING_COUNTER_GENERATION_NEW_WORK_ENABLED: 'true',
    POS_SCREENING_ORIGIN_HISTORY_AUDIT_DEFINER: 'quota_audit@%',
    POS_SCREENING_ORIGIN_HISTORY_DEFINER: 'quota_origin@%',
    POS_SCREENING_ORIGIN_HISTORY_ADMIN_GRANTEES: '[]',
    POS_SCREENING_COUNTER_TRIGGER_DEFINER: 'quota_trigger@%',
    POS_SCREENING_COUNTER_PUBLISHER_GRANTEE: 'quota_publisher@%',
  };
}
export function generationOptions() {
  return readCounterGenerationOptions(generationEnvironment())!;
}
export function generationSnapshot(
  customerId = '77',
  headRevision = '3',
  input: CounterRow[] = [
    { markerId: '7', orderId: '9007199254740993', lineId: '9007199254740994', included: true },
  ],
  now = generationNow,
  identity = { serverUuid: '11111111-1111-4111-8111-111111111111', sourceSchema: 'fixture' },
) {
  const body: Omit<CounterCapture, 'signature'> = {
    contract: 'pos-screening-counter-source-v1',
    sourceCommit: '2960acbea10c4eaf16b6d99e15ff6e03ef7724c5',
    scope: { customerId, sku: '390238' },
    snapshotId: crypto.randomUUID(),
    ...identity,
    headRevision,
    writersDefinitionHash: counterDefinitionHash,
    writersOwner: 'quota_trigger@%',
    rows: String(input.length),
    count: String(input.filter((row) => row.included).length),
    rowsHash: counterRowsHash(input),
    capturedAt: now,
    finishedAt: now,
  };
  return sealCounterGenerationSnapshot(
    {
      capture: { ...body, signature: counterDigest(generationSourceKey, 'capture', body) },
      rows: input,
      configuration: 'fixture-full-v3-configuration',
    },
    generationSourceKey,
  );
}
