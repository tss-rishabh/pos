import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { splitMigration } from '../../src/db/migrations.js';
import { importFinancialFixture, financialClock } from '../legacy-import-financial/fixture.js';
import { legacyImportFinancialJournal } from '../../src/modules/legacy-order-imports/financial-adapter-journal.js';
import { financialPreparationLedger } from '../../src/modules/legacy-order-imports/financial-adapter-preparation-ledger.js';
import { financialOrderPreparationContract } from '../../src/modules/legacy-order-imports/financial-adapter-contracts.js';
import {
  financialImportOperations,
  financialImportPreparations,
  financialImportStages,
} from '../../src/modules/legacy-order-imports/financial-adapter-schema.js';
import { financialImportHash } from '../../src/modules/legacy-order-imports/financial-adapter-crypto.js';

const template = process.env.CHECKOUT_MYSQL_TEST_URL;
describe.skipIf(!template)('native pre-source preparation control', () => {
  let f: Awaited<ReturnType<typeof importFinancialFixture>>, clock: number;
  beforeAll(async () => {
    f = await importFinancialFixture(template!);
    for (const statement of splitMigration(
      readFileSync('src/modules/legacy-order-imports/preparation-migration.sql', 'utf8'),
    ))
      await f.connection.query(statement);
  }, 15000);
  afterAll(async () => {
    await f?.close();
  });
  beforeEach(async () => {
    await f.db.get('writer').delete(financialImportPreparations);
    await f.reset();
    clock = financialClock;
  });
  function control() {
    return financialPreparationLedger(f.options.secret, () => clock);
  }
  function journal() {
    return legacyImportFinancialJournal(
      f.config,
      f.db,
      { ...f.options, clock: () => clock },
      undefined,
      true,
    );
  }
  async function begin() {
    const j = journal(),
      ledger = control(),
      input = f.input();
    return j.transaction(async (tx) => {
      const reserved = await j.reserve(input, undefined, {
        transaction: tx,
        preparationContract: financialOrderPreparationContract,
      });
      const execution = await ledger.begin(tx, reserved.state);
      return { j, ledger, input, reserved, execution };
    });
  }
  it('binds selected preparation into the original native request while old ordinary bytes stay absent', async () => {
    const c = await begin();
    expect(c.reserved.state.preparationContract).toBe(financialOrderPreparationContract);
    await c.j.transaction(async (tx) =>
      expect((await c.j.load(tx, c.input))?.state).toEqual(c.reserved.state),
    );
    await f.db
      .get('writer')
      .update(financialImportOperations)
      .set({ state: { ...c.reserved.state, preparationContract: undefined } });
    await expect(c.j.transaction((tx) => c.j.load(tx, c.input))).rejects.toMatchObject({
      code: 'ORDER_IMPORT_FINANCIAL_PAYLOAD_INVALID',
    });
  });
  it('consumes exactly one private owner before allowing an async preparation', async () => {
    const c = await begin();
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        c.j.transaction(async (tx) => {
          await c.j.load(tx, c.input);
          return c.ledger.consume(tx, c.reserved.state, c.execution);
        }),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.find(Boolean)?.phase).toBe('RUNNING');
    const changed = { ...c.execution, ownerToken: crypto.randomUUID() };
    await expect(
      c.j.transaction(async (tx) => {
        await c.j.load(tx, c.input);
        return c.ledger.consume(tx, c.reserved.state, changed);
      }),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_PREPARATION_RETRY_REQUIRED' });
  });
  it('does not close a live lease from GET but seals expiry only after native no-dispatch proof', async () => {
    const c = await begin();
    expect(
      await c.j.transaction(async (tx) => {
        await c.j.load(tx, c.input);
        return c.ledger.close(tx, c.reserved.state, 'ORDER_IMPORT_PREPARATION_EXPIRED');
      }),
    ).toBeNull();
    clock += 60001;
    const proof = await c.j.transaction(async (tx) => {
      await c.j.load(tx, c.input);
      return c.ledger.close(tx, c.reserved.state, 'ORDER_IMPORT_PREPARATION_EXPIRED');
    });
    expect(proof).toMatchObject({
      scope: c.reserved.state.scope,
      noFinancialEffects: true,
      code: 'ORDER_IMPORT_PREPARATION_EXPIRED',
    });
    expect(await f.db.get('writer').select().from(financialImportStages)).toEqual([]);
    await expect(
      c.j.transaction(async (tx) => {
        await c.j.load(tx, c.input);
        return c.ledger.consume(tx, c.reserved.state, c.execution);
      }),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_PREPARATION_RETRY_REQUIRED' });
  });
  it('never creates a closure when any stage exists, even with a changed kind/status', async () => {
    const c = await begin();
    await f.db
      .get('writer')
      .insert(financialImportStages)
      .values({
        id: c.input.operationId + ':altered',
        operationId: c.input.operationId,
        kind: 'other',
        nonce: crypto.randomUUID(),
        status: 'changed',
        requestHash: 'a'.repeat(64),
        createdAt: clock,
        updatedAt: clock,
      });
    clock += 60001;
    await expect(
      c.j.transaction(async (tx) => {
        await c.j.load(tx, c.input);
        return c.ledger.close(tx, c.reserved.state, 'ORDER_IMPORT_PREPARATION_EXPIRED');
      }),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_PREPARATION_PROOF_INVALID' });
    expect(
      (await f.db.get('writer').select().from(financialImportPreparations))[0]?.data.phase,
    ).toBe('RESERVED');
  });
  it('retains an encrypted prepared artifact and does not accept mutation or another attempt scope', async () => {
    const c = await begin();
    await c.j.transaction(async (tx) => {
      await c.j.load(tx, c.input);
      await c.ledger.consume(tx, c.reserved.state, c.execution);
      await c.ledger.dispatched(tx, c.reserved.state, c.execution, {});
    });
    const [stored] = await f.db.get('writer').select().from(financialImportPreparations);
    expect(stored?.artifact).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(stored?.artifact).not.toContain('{}');
    expect(
      await c.j.transaction(async (tx) => {
        await c.j.load(tx, c.input);
        return c.ledger.readArtifact(tx, c.reserved.state);
      }),
    ).toEqual({});
    await f.db.get('writer').update(financialImportPreparations).set({ artifact: 'invalid' });
    await expect(
      c.j.transaction(async (tx) => {
        await c.j.load(tx, c.input);
        return c.ledger.readArtifact(tx, c.reserved.state);
      }),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_PREPARATION_PROOF_INVALID' });
  });
  it('refuses an unsigned or oversized native control record rather than treating it as absent', async () => {
    const c = await begin();
    const [row] = await f.db.get('writer').select().from(financialImportPreparations);
    if (!row) throw new Error('Native fixture preparation missing.');
    await f.db
      .get('writer')
      .update(financialImportPreparations)
      .set({ data: { ...row.data, phase: 'RUNNING' } })
      .where(eq(financialImportPreparations.id, row.id));
    await expect(
      c.j.transaction(async (tx) => {
        await c.j.load(tx, c.input);
        return c.ledger.latest(tx, c.reserved.state);
      }),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_PREPARATION_PROOF_INVALID' });
    await f.connection.query('UPDATE pos_rewrite_import_financial_preparations SET data=?', [
      JSON.stringify({ invalid: 'x'.repeat(16001) }),
    ]);
    await expect(
      c.j.transaction(async (tx) => {
        await c.j.load(tx, c.input);
        return c.ledger.latest(tx, c.reserved.state);
      }),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_PREPARATION_PROOF_INVALID' });
  });
  it('keeps append-only old closures when explicitly authorizing a new attempt without a live owner or quota', async () => {
    const c = await begin();
    clock += 60001;
    await c.j.transaction(async (tx) => {
      await c.j.load(tx, c.input);
      await c.ledger.close(tx, c.reserved.state, 'ORDER_IMPORT_PREPARATION_EXPIRED');
      await c.ledger.authorize(tx, c.reserved.state, crypto.randomUUID());
    });
    const rows = await c.j.transaction(async (tx) => {
      await c.j.load(tx, c.input);
      return c.ledger.history(tx, c.reserved.state);
    });
    expect(rows.map((row) => row.phase)).toEqual(['AUTHORIZED', 'CLOSED']);
    expect(rows[0]).toMatchObject({ ownerHash: null, expiresAt: null, previousId: rows[1]?.id });
    expect(rows[1]?.closure?.noFinancialEffects).toBe(true);
    expect(rows[1]?.closureHash).toBe(
      financialImportHash(f.options.secret, 'native-no-dispatch', rows[1]?.closure),
    );
  });
});
