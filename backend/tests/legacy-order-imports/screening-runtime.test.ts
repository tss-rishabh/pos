import { afterEach, describe, expect, it, vi } from 'vitest';
import { readConfig } from '../../src/config.js';
import { createDatabases } from '../../src/db/pools.js';
import { configuredLegacyOrderImports } from '../../src/modules/legacy-order-imports/runtime.js';
import * as adapters from '../../src/modules/legacy-order-imports/financial-adapter.js';
import * as screening from '../../src/modules/legacy-order-imports/screening-profile.js';
import type { FinancialImportProfileContext } from '../../src/modules/legacy-order-imports/financial-adapter-profiles.js';
import type { AdministrationTransaction } from '../../src/modules/administration/checkins.js';
import type { OfflineOrderImportPlan } from '../../src/modules/legacy-order-imports/plans.js';

const config = readConfig({
  NODE_ENV: 'test',
  SESSION_SECRET: 'screening-runtime-fixture-session-'.repeat(2),
  MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
  MYSQL_PRIMARY_READER_URL: 'mysql://root@127.0.0.1/pos_rewrite_import_runtime_options_test',
});
const ticket: OfflineOrderImportPlan = {
  kind: 'offline',
  sequence: 1,
  firstRow: 2,
  reference: 'fixture-ticket',
  storeId: '1',
  email: null,
  createdAt: '2026-06-15 12:00:00',
  lines: [{ productId: '390238', quantity: 1, unitPrice: '100.00', sourceRows: [2] }],
  originalTenderAmount: '100.00',
  payment: 'cash',
  sendOrderPlacedSms: false,
  message: '',
};
function environment(): NodeJS.ProcessEnv {
  return {
    LEGACY_ORDER_IMPORT_ENCRYPTION_KEY_V1: 'fixture-import-financial-master-key-'.repeat(2),
    TSS_POS_LEGACY_IMPORT_PROOF_KEY: 'fixture-import-source-proof-key-'.repeat(2),
    POS_LEGACY_IMPORT_SCREENING_CONTRACT: 'pos-csv-screening-2960-v1',
    POS_LEGACY_IMPORT_SCREENING_SCHEMA_CONTRACT: 'pos-screening-schema-v1',
    POS_LEGACY_IMPORT_SCREENING_WRITER_CONTRACT: 'pos-screening-all-writers-v1',
    POS_LEGACY_IMPORT_SCREENING_LINE_ITEMS_ENABLED: '0',
    POS_SCREENING_COUNTER_CONTRACT: 'pos-screening-current-counter-v1',
    POS_SCREENING_COUNTER_PUBLICATION_KEY: 'fixture-independent-counter-publication-key-'.repeat(2),
    POS_SCREENING_ORIGIN_HISTORY_AUDIT_DEFINER: 'fixture_audit@%',
    POS_SCREENING_ORIGIN_HISTORY_DEFINER: 'fixture_origin@%',
    POS_SCREENING_COUNTER_TRIGGER_DEFINER: 'fixture_counter@%',
    POS_SCREENING_ORIGIN_HISTORY_ADMIN_GRANTEES:
      '["root@localhost","root@%","mysql.sys@localhost"]',
  };
}
afterEach(() => vi.restoreAllMocks());
describe('production import ticket profile installation', () => {
  it.each(['0', '1'])(
    'wires the actual profile and trusted line mode %s into the real adapter without SQL',
    async (mode) => {
      const db = createDatabases(config),
        get = vi.spyOn(db, 'get'),
        profileFactory = vi.spyOn(screening, 'screeningImportProfile'),
        adapterFactory = vi.spyOn(adapters, 'legacyOrderImportFinancialAdapter');
      try {
        const registration = configuredLegacyOrderImports(config, db, {
          environment: { ...environment(), POS_LEGACY_IMPORT_SCREENING_LINE_ITEMS_ENABLED: mode },
        });
        expect(registration.adapter).toBeDefined();
        expect(profileFactory).toHaveBeenCalledOnce();
        expect(profileFactory.mock.calls[0]![2]).toMatchObject({
          contract: 'pos-csv-screening-2960-v1',
          counter: {
            contract: 'pos-screening-current-counter-v1',
            headMetadata: { counterDefiner: 'fixture_counter@%' },
          },
        });
        const profiles = adapterFactory.mock.calls[0]![4]!;
        expect(() => profiles.assertReady(ticket)).not.toThrow();
        const installed = profileFactory.mock.results[0]!.value as ReturnType<
          typeof screening.screeningImportProfile
        >;
        const boundary = new Error('fixture stopped before native reservation SQL');
        const reserve = vi.spyOn(installed, 'reserve').mockRejectedValue(boundary);
        const transaction = {} as AdministrationTransaction;
        const scope = {
          actorId: '1',
          operationId: '11111111-1111-4111-8111-111111111111',
          storeId: '1',
          counterId: '1',
        };
        const context = { plan: ticket, state: { scope } } as FinancialImportProfileContext;
        await expect(profiles.reserved(transaction, context)).rejects.toBe(boundary);
        expect(reserve).toHaveBeenCalledWith(transaction, scope, mode === '1');
        expect(get).not.toHaveBeenCalled();
      } finally {
        await db.close();
      }
    },
  );
  it.each([
    { POS_LEGACY_IMPORT_SCREENING_WRITER_CONTRACT: '' },
    { POS_LEGACY_IMPORT_SCREENING_LINE_ITEMS_ENABLED: '' },
    { POS_LEGACY_IMPORT_SCREENING_LINE_ITEMS_ENABLED: 'true' },
    { POS_SCREENING_COUNTER_CONTRACT: '' },
    { POS_SCREENING_COUNTER_PUBLICATION_KEY: '' },
    { POS_SCREENING_ORIGIN_HISTORY_AUDIT_DEFINER: '' },
    { POS_SCREENING_COUNTER_TRIGGER_DEFINER: 'fixture_audit@%' },
  ])(
    'blocks new work while retaining the adapter when selected configuration is invalid',
    async (invalid) => {
      const db = createDatabases(config),
        get = vi.spyOn(db, 'get'),
        adapterFactory = vi.spyOn(adapters, 'legacyOrderImportFinancialAdapter');
      try {
        const registration = configuredLegacyOrderImports(config, db, {
          environment: { ...environment(), ...invalid },
        });
        expect(registration.adapter).toBeDefined();
        expect(registration.canStart).toBe(false);
        expect(() => adapterFactory.mock.calls[0]![4]!.assertReady(ticket)).toThrowError(
          expect.objectContaining({ code: 'ORDER_IMPORT_SCREENING_UNQUALIFIED' }),
        );
        expect(get).not.toHaveBeenCalled();
      } finally {
        await db.close();
      }
    },
  );
  it('keeps screening unselected and ignores unused metadata configuration', async () => {
    const db = createDatabases(config),
      get = vi.spyOn(db, 'get'),
      profileFactory = vi.spyOn(screening, 'screeningImportProfile'),
      adapterFactory = vi.spyOn(adapters, 'legacyOrderImportFinancialAdapter');
    try {
      configuredLegacyOrderImports(config, db, {
        environment: {
          ...environment(),
          POS_LEGACY_IMPORT_SCREENING_CONTRACT: '',
          POS_SCREENING_ORIGIN_HISTORY_ADMIN_GRANTEES: 'invalid-unused-json',
        },
      });
      expect(profileFactory).not.toHaveBeenCalled();
      expect(() => adapterFactory.mock.calls[0]![4]!.assertReady(ticket)).toThrowError(
        expect.objectContaining({ code: 'ORDER_IMPORT_SCREENING_UNQUALIFIED' }),
      );
      expect(() =>
        adapterFactory.mock.calls[0]![4]!.assertReady({
          ...ticket,
          lines: [{ ...ticket.lines[0]!, productId: '42' }],
        }),
      ).not.toThrow();
      expect(get).not.toHaveBeenCalled();
    } finally {
      await db.close();
    }
  });
});
