import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type mysql from 'mysql2/promise';
import {
  counterGenerationDemands,
  type CounterGenerationDemandRequest,
} from '../../src/modules/legacy-order-imports/screening-counter/counter-generation-demands.js';
import { counterGenerationPlan } from '../../src/modules/legacy-order-imports/screening-counter/counter-generation-warehouse.js';
import { generationJournalKey, generationSnapshot } from './generation-fixture.js';
import { quotaGenerationNativeFixture } from './generation-native-fixture.js';
const template = process.env.QUOTA_GENERATION_MYSQL_TEST_URL ?? process.env.CHECKOUT_MYSQL_TEST_URL;
const request = (
  customerId: string,
  headRevision = '0',
  expectedGeneration: string | null = null,
) => ({ customerId, headRevision, expectedGeneration });
describe.skipIf(!template)('native automatic quota demand admission', () => {
  let f: Awaited<ReturnType<typeof quotaGenerationNativeFixture>>;
  beforeAll(async () => {
    f = await quotaGenerationNativeFixture(template!);
  }, 30000);
  beforeEach(async () => f.reset());
  afterAll(async () => f?.close());
  async function rows(table = 'pos_rewrite_screening_counter_generation_demands') {
    const [values] = await f.connection.query<mysql.RowDataPacket[]>('SELECT * FROM ' + table);
    return values;
  }
  async function admit(input: CounterGenerationDemandRequest[], lane: 'new' | 'backfill' = 'new') {
    const cursor = await f.demands.cursor(lane);
    await f.demands.admitPage(cursor, input, input.at(-1)?.customerId ?? '0', 5000);
    return rows();
  }
  it('discovers newest users immediately while backfill advances independently and catches arrivals during cursor admission', async () => {
    await f.addUsers('1', '2', '3', '4', '5');
    const fresh = await f.demands.cursor('new'),
      page = await f.source.page(fresh);
    expect(page).toEqual({ requests: [request('5'), request('4')], after: '5' });
    await f.addUsers('6');
    await f.demands.admitPage(fresh, page.requests, page.after, 5000);
    expect(await f.source.page(await f.demands.cursor('new'))).toEqual({
      requests: [request('6')],
      after: '6',
    });
    expect(await f.source.page(await f.demands.cursor('backfill'))).toEqual({
      requests: [request('1'), request('2')],
      after: '2',
    });
  });
  it('rolls back every admission and cursor on a failure in the middle of a page', async () => {
    const cursor = await f.demands.cursor('backfill');
    await expect(
      f.demands.admitPage(cursor, [request('1'), request('invalid')], '2', 5000),
    ).rejects.toThrow();
    expect(await rows()).toHaveLength(0);
    expect(await f.demands.cursor('backfill')).toEqual(cursor);
  });
  it('CASes concurrent cursor owners and deduplicates exact head/expected generation across lanes', async () => {
    const cursor = await f.demands.cursor('new');
    const replies = await Promise.all([
      f.demands.admitPage(cursor, [request('77')], '77', 5000),
      f.demands.admitPage(cursor, [request('77')], '77', 5000),
    ]);
    expect(replies.filter(Boolean)).toHaveLength(1);
    await admit([request('77')], 'backfill');
    expect(await rows()).toHaveLength(1);
    await admit([request('77', '1'), request('77', '1', 'a'.repeat(64))]);
    expect(await rows()).toHaveLength(3);
    expect((await rows()).every((row) => !String(row.payload).includes('customerId'))).toBe(true);
  });
  it('prioritizes the latest user and durably rotates retries, older new users and historic backfill', async () => {
    await admit([request('1'), request('2')], 'backfill');
    f.clock.now++;
    await admit([request('76')]);
    f.clock.now++;
    await admit([request('77')]);
    const all = await rows();
    const requests = await Promise.all(all.map((row) => f.demands.read(String(row.id))));
    const ids = Object.fromEntries(requests.map((r) => [r.request.customerId, r.id]));
    expect((await f.demands.due(2))[0]).toBe(ids['77']);
    const restarted = counterGenerationDemands(f.db, generationJournalKey, () => f.clock.now);
    expect(await restarted.due(2)).toEqual([ids['77'], ids['76']]);
    const backfill = await restarted.due(2);
    expect(backfill[0]).toBe(ids['77']);
    expect([ids['1'], ids['2']]).toContain(backfill[1]);
    const claim = await restarted.claim(ids['76']!);
    await restarted.retry(claim!.id, claim!.lease!);
    f.clock.now += 5000;
    expect(await restarted.due(2)).toEqual([ids['77'], ids['76']]);
  });
  it('binds one capture lease atomically with its immutable generation and rejects changed heads without orphan jobs', async () => {
    const [row] = await admit([request('77', '3')]);
    const claims = await Promise.all(
      Array.from({ length: 20 }, () => f.demands.claim(String(row!.id))),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claim = claims.find(Boolean)!,
      wrong = generationSnapshot('77', '4');
    await expect(
      f.journal.create(wrong, counterGenerationPlan(wrong, f.options), null, (tx, job) =>
        f.demands.bind(tx, claim.id, claim.lease!, job),
      ),
    ).rejects.toMatchObject({ code: 'SCREENING_COUNTER_GENERATION_DISCOVERY_HEAD_CHANGED' });
    expect(await rows('pos_rewrite_screening_counter_generation_jobs')).toHaveLength(0);
    const snapshot = generationSnapshot('77', '3'),
      job = await f.journal.create(
        snapshot,
        counterGenerationPlan(snapshot, f.options),
        null,
        (tx, saved) => f.demands.bind(tx, claim.id, claim.lease!, saved),
      );
    expect(await f.demands.read(claim.id)).toMatchObject({
      phase: 'prepared',
      generationId: job.id,
      lease: null,
    });
    const retried = await f.demands.poll(claim.id, true);
    expect(retried).toMatchObject({
      phase: 'pending',
      generationId: null,
      dueAt: f.clock.now + 5000,
    });
  });
  it('rejects transplanted encrypted demands and cursor metadata tampering', async () => {
    const [a, b] = await admit([request('77'), request('78')]);
    await f.connection.execute(
      'UPDATE pos_rewrite_screening_counter_generation_demands SET payload=? WHERE id=?',
      [a!.payload, b!.id],
    );
    await expect(f.demands.read(String(b!.id))).rejects.toMatchObject({
      code: 'SCREENING_COUNTER_GENERATION_DEMAND_INVALID',
    });
    await f.connection.query(
      "UPDATE pos_rewrite_screening_counter_generation_cursors SET updated_at_ms=updated_at_ms+1 WHERE lane='new'",
    );
    await expect(f.demands.cursor('new')).rejects.toMatchObject({
      code: 'SCREENING_COUNTER_GENERATION_DEMAND_INVALID',
    });
  });
  it('continues page discovery past invalid existing baseline evidence without inventing a zero', async () => {
    await f.addUsers('77', '78');
    await f.connection.query(
      "INSERT INTO pos_rewrite_screening_counters(customer_id,sku,bought,revision,baseline,baseline_hash) VALUES(77,390238,0,0,'{}',REPEAT('a',64))",
    );
    const page = await f.source.page(await f.demands.cursor('new'));
    expect(page.requests.map((r) => r.customerId)).toEqual(['78', '77']);
    expect(await f.source.current('77')).toMatchObject({ needed: true, available: false });
    expect(await f.source.current('78')).toMatchObject({ needed: true, available: true });
  });
});
