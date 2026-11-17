import { describe, expect, it } from 'vitest';
import { readCounterGenerationOptions } from '../../src/modules/legacy-order-imports/screening-counter/counter-generation-options.js';
import { generationEnvironment } from './generation-fixture.js';
describe('independent quota generation configuration', () => {
  it('is disabled without selector even if unrelated deployment configuration is invalid', () => {
    expect(readCounterGenerationOptions({ DEMO_MODE: 'invalid' })).toBeUndefined();
  });
  it('selects bounded discovery with a 50MB default and optional blank CA paths', () => {
    const o = readCounterGenerationOptions({
      ...generationEnvironment(),
      POS_SCREENING_COUNTER_GENERATION_SOURCE_TLS_CA_FILE: '',
      POS_SCREENING_COUNTER_GENERATION_PROJECTION_TLS_CA_FILE: '',
    });
    expect(o).toMatchObject({
      maxBytes: 50000000,
      maxDiscovery: 2,
      discoveryBatchSize: 20,
      discoveryIntervalMs: 5000,
      sourceTlsCaFile: undefined,
    });
  });
  it.each(['true', 'TRUE', 'yes', ''])('rejects selected demo/invalid mode %s', (DEMO_MODE) => {
    expect(() => readCounterGenerationOptions({ ...generationEnvironment(), DEMO_MODE })).toThrow();
  });
  it.each([
    'tssgcp2025.other_dataset.counter_rows',
    'another_project.tss_mysql_raw_layer.counter_rows',
    'tssgcp2025.tss_mysql_raw_layer.rows` WHERE TRUE --',
  ])('rejects unauthorized table %s', (table) => {
    expect(() =>
      readCounterGenerationOptions({
        ...generationEnvironment(),
        BQ_SCREENING_COUNTER_ROWS_VIEW: table,
      }),
    ).toThrow();
  });
  it('refuses equivalent native users hidden by URL percent encoding', () => {
    expect(() =>
      readCounterGenerationOptions({
        ...generationEnvironment(),
        POS_SCREENING_COUNTER_GENERATION_SOURCE_URL:
          'mysql://quota_%70ublisher:fixture@127.0.0.1:3306/fixture',
      }),
    ).toThrow();
  });
  it.each([
    { POS_SCREENING_COUNTER_GENERATION_MAX_DISCOVERY: '1' },
    { POS_SCREENING_COUNTER_GENERATION_DISCOVERY_BATCH_SIZE: '101' },
    { POS_SCREENING_COUNTER_GENERATION_MAX_BYTES: '1000000001' },
    { POS_SCREENING_COUNTER_GENERATION_WRITER_KEY_FILE: '/fixture/reader.json' },
  ])('rejects unsafe bounds/identity %j', (override) => {
    expect(() =>
      readCounterGenerationOptions({ ...generationEnvironment(), ...override }),
    ).toThrow();
  });
});
