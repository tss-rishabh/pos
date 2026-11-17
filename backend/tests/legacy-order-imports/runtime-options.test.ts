import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readConfig } from '../../src/config.js';
import { createDatabases } from '../../src/db/pools.js';
import { configuredLegacyOrderImports } from '../../src/modules/legacy-order-imports/runtime.js';
import { legacyOrderImportService } from '../../src/modules/legacy-order-imports/service.js';
import { legacyOrderImportWorker } from '../../src/modules/legacy-order-imports/worker.js';

const configuration = readConfig({
  NODE_ENV: 'test',
  SESSION_SECRET: 'isolated-import-runtime-options-'.repeat(3),
  MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
  MYSQL_PRIMARY_READER_URL: 'mysql://root@127.0.0.1/pos_rewrite_import_runtime_options_test',
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('qualified import runtime selection', () => {
  it('ignores ambient financial and worker flags in demo without touching a database', async () => {
    const config = { ...configuration, DEMO_MODE: true },
      db = createDatabases(config),
      get = vi.spyOn(db, 'get');
    try {
      const runtime = configuredLegacyOrderImports(config, db, {
        environment: {
          LEGACY_ORDER_IMPORT_CONTRACT: 'pos-legacy-order-import-v1',
          LEGACY_ORDER_IMPORT_ENCRYPTION_KEY_V1: 'unusable-private-fixture-key',
          LEGACY_ORDER_IMPORT_WORKER_ENABLED: 'true',
          UPSTREAM_POS_LEGACY_IMPORT_FINANCIAL_CONTRACT: 'unselected-invalid-contract',
        },
      });
      expect(runtime.adapter).toBeUndefined();
      expect(runtime.approvals).toBeUndefined();
      expect(runtime.corrections).toBeUndefined();
      expect(runtime.runtime?.LEGACY_ORDER_IMPORT_WORKER_ENABLED).toBe(false);
      expect(get).not.toHaveBeenCalled();
    } finally {
      await db.close();
    }
  });
  it('retains recovery approvals with the key but starts no worker or financial stage without qualified transport', async () => {
    vi.useFakeTimers();
    const db = createDatabases(configuration),
      get = vi.spyOn(db, 'get');
    try {
      const registration = configuredLegacyOrderImports(configuration, db, {
          environment: {
            LEGACY_ORDER_IMPORT_CONTRACT: 'pos-legacy-order-import-v1',
            LEGACY_ORDER_IMPORT_ENCRYPTION_KEY_V1: 'isolated-import-retained-purpose-key-'.repeat(
              2,
            ),
            LEGACY_ORDER_IMPORT_WORKER_ENABLED: 'true',
          },
        }),
        service = legacyOrderImportService(configuration, db, registration),
        worker = legacyOrderImportWorker(service, () => undefined);
      expect(registration.approvals).toBeDefined();
      expect(registration.corrections?.enabled).toBe(false);
      expect(registration.correctionForOperation).toBe(
        registration.corrections?.correctionForOperation,
      );
      expect(registration.adapter).toBeUndefined();
      expect(service.ready).toBe(false);
      expect(await service.runOne()).toBeNull();
      worker.start();
      await worker.runOnce();
      await worker.stop();
      expect(vi.getTimerCount()).toBe(0);
      expect(get).not.toHaveBeenCalled();
    } finally {
      await db.close();
    }
  });
  it('installs the same native correction resolver for server and worker without starting financial stages', async () => {
    const db = createDatabases(configuration),
      get = vi.spyOn(db, 'get');
    try {
      const registration = configuredLegacyOrderImports(configuration, db, {
        environment: {
          LEGACY_ORDER_IMPORT_ENCRYPTION_KEY_V1: 'isolated-import-retained-purpose-key-'.repeat(2),
          LEGACY_ORDER_IMPORT_CORRECTION_CONTRACT: 'pos-import-manager-correction-v1',
          TSS_POS_LEGACY_IMPORT_PROOF_KEY: 'isolated-import-source-purpose-key-'.repeat(2),
        },
      });
      expect(registration.corrections?.enabled).toBe(true);
      expect(registration.correctionForOperation).toBe(
        registration.corrections?.correctionForOperation,
      );
      expect(registration.adapter).toBeUndefined();
      expect(get).not.toHaveBeenCalled();
    } finally {
      await db.close();
    }
  });
});
function childEnvironment() {
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', TZ: 'UTC' };
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'COMSPEC'])
    if (process.env[name]) env[name] = process.env[name];
  return env;
}
describe('standalone import worker startup', () => {
  it('exits cleanly when disabled without requiring database or financial credentials', () => {
    const output = execFileSync(
      process.execPath,
      ['--import', 'tsx', 'src/modules/legacy-order-imports/worker-main.ts'],
      {
        env: childEnvironment(),
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 65536,
      },
    );
    const event: unknown = JSON.parse(output.trim());
    expect(event).toMatchObject({
      module: 'administration',
      resource: 'historical-order-import-worker',
      eventId: 'administration.historical-order-import-worker.disabled',
      userId: null,
    });
    expect(output).not.toMatch(/password|authorization|stack|MYSQL_WRITER_URL/i);
  });
  it('refuses demo processing and emits only a static traced startup failure', () => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/modules/legacy-order-imports/worker-main.ts'],
      {
        env: {
          ...childEnvironment(),
          DEMO_MODE: 'true',
          LEGACY_ORDER_IMPORT_WORKER_ENABLED: 'true',
          SESSION_SECRET: 'private-startup-fixture-sentinel-'.repeat(3),
        },
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 65536,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    const event: unknown = JSON.parse(result.stdout.trim());
    expect(event).toMatchObject({
      module: 'administration',
      resource: 'historical-order-import-worker',
      eventId: 'administration.historical-order-import-worker.startup-failed',
      userId: null,
    });
    expect(result.stdout).not.toMatch(/private-startup-fixture|password|stack|MYSQL_WRITER_URL/i);
  });
});
