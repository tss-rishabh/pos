import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  importFinancialFixture,
  sourceKey,
  financialClock,
} from '../legacy-import-financial/fixture.js';
import { legacyImportFinancialJournal } from '../../src/modules/legacy-order-imports/financial-adapter-journal.js';
import { financialSourceHash } from '../../src/modules/legacy-order-imports/financial-adapter-crypto.js';
const template = process.env.CHECKOUT_MYSQL_TEST_URL;
describe.skipIf(!template)('owned source screening lock/snapshot prelude', () => {
  let fixture: Awaited<ReturnType<typeof importFinancialFixture>>;
  beforeAll(async () => {
    fixture = await importFinancialFixture(template!);
    await fixture.reset();
  }, 30000);
  afterAll(async () => {
    await fixture?.close();
  });
  it('proves fresh-after-customer reads, no inverse pre-locks, sticky rollback and archived receipt scope', async () => {
    const input = fixture.input(),
      journal = legacyImportFinancialJournal(fixture.config, fixture.db, fixture.options);
    await journal.reserve(input);
    const command = await journal.dispatch(input, 'order');
    const receipt = await fixture.createOrder(command.state, command.plan);
    await fixture.fixture.insert('stores', { id: '2', is_active: 1, type: 'STORE' });
    await fixture.fixture.insert('users', {
      id: '78',
      email: 'other-source@example.test',
      status: 1,
      is_block: 0,
      is_disabled: 0,
    });
    await fixture.connection.execute('UPDATE order_stores SET store_id=2 WHERE order_id=?', [
      receipt.orderId,
    ]);
    const key = 'isolated-source-lock-capability-key-'.repeat(3);
    const cap = {
      contract: 'pos-legacy-order-import-source-v1',
      phase: 'order',
      operationId: input.operationId,
      requestHash: command.state.requestHash,
      planHash: command.state.planHash,
      namespace: command.state.namespace,
      planDigest: financialSourceHash(key, 'plan', command.plan),
      scope: command.state.scope,
      authority: command.state.authority,
      orderId: null,
      nonce: command.nonce,
      issuedAt: command.issuedAt,
      expiresAt: command.expiresAt,
    };
    const result = z
      .object({ passed: z.array(z.string()), hint: z.literal(0), current: z.literal(1) })
      .parse(
        JSON.parse(
          execFileSync(
            resolve('compatibility/upstream/offline-cash-pricing/.venv/bin/python'),
            ['-B', resolve('compatibility/upstream/legacy-order-imports/source_lock_driver.py')],
            {
              encoding: 'utf8',
              timeout: 20000,
              maxBuffer: 16000,
              input: JSON.stringify({
                url: fixture.config.MYSQL_WRITER_URL,
                key,
                proofKey: sourceKey,
                plan: command.plan,
                now: financialClock,
                cap: { ...cap, signature: financialSourceHash(key, 'capability', cap) },
                historicalOrderId: receipt.orderId,
              }),
            },
          ),
        ) as unknown,
      );
    expect(result.passed).toEqual([
      'primed-rejected',
      'sticky-order-or-snapshot-rejected',
      'sticky-order-or-snapshot-rejected',
      'sticky-order-or-snapshot-rejected',
      'owned-current-and-private-wrapper',
      'pooled-isolation-restored',
      'retained-archived-prefix',
      'cross-store-stale-hint-fresh-view',
      'two-customers-empty-control-receipts',
    ]);
  });
});
