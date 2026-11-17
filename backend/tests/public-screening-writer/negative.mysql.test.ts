import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { publicApiFixture, screeningUser } from './api-fixture.js';
import { python, run, runAsync } from './native-fixture.js';
import { financialClock, sourceKey } from '../legacy-import-financial/fixture.js';
import { readPublicScreeningNegative } from '../../src/modules/checkout/screening-writer/negative.js';
import { publicScreeningRecovery } from '../../src/modules/checkout/screening-writer/recovery.js';
import { nodeScreeningWriterSchema } from '../../src/modules/checkout/screening-writer/capability.js';
const template = process.env.CHECKOUT_MYSQL_TEST_URL,
  driver = resolve('tests/public-screening-writer/negative_driver.py'),
  key = 'isolated-public-negative-caller-key-'.repeat(2),
  resultSchema = z.object({
    responses: z.array(z.object({ status: z.string(), body: z.unknown() })),
    events: z.array(z.record(z.string(), z.unknown())),
  });
const noMoney = {
  configured() {},
  async start(): Promise<never> {
    throw new Error('No financial dispatch allowed');
  },
  async status(): Promise<never> {
    throw new Error('No provider inquiry allowed');
  },
  async cancel(): Promise<never> {
    throw new Error('No provider cancellation allowed');
  },
};
describe.skipIf(!template)('source no-order negative and native API closure', () => {
  let f: Awaited<ReturnType<typeof publicApiFixture>>;
  beforeAll(async () => {
    f = await publicApiFixture(template!);
  }, 30000);
  beforeEach(async () => {
    await f.reset();
    f.resetScope();
  });
  afterAll(async () => {
    await f?.close();
  });
  const base = (p: { checkoutId: string; operationId: string }) =>
    `/api/v1/stores/1/checkout-sessions/${p.checkoutId}/screening-admissions/${p.operationId}`;
  const input = (operationId: string, extra: Record<string, unknown> = {}) => ({
    url: f.config.MYSQL_WRITER_URL,
    operationId,
    proofKey: sourceKey,
    key,
    now: financialClock + 61000,
    ...extra,
  });
  function source(operationId: string, extra: Record<string, unknown> = {}) {
    return resultSchema.parse(
      JSON.parse(
        execFileSync(python, ['-B', driver], {
          input: JSON.stringify(input(operationId, extra)),
          encoding: 'utf8',
          timeout: 20000,
          maxBuffer: 64000,
        }),
      ) as unknown,
    );
  }
  async function emptyEffects() {
    for (const table of [
      'orders',
      'has_products',
      'spiderman_screening_orders',
      'pos_rewrite_import_screening_reservations',
      'pos_rewrite_public_screening_orders',
      'pos_rewrite_public_screening_effects',
      'pos_rewrite_checkout_projections',
      'pos_rewrite_payment_attempts',
      'pos_rewrite_payment_outbox',
    ]) {
      const [rows] = await f.connection.query('SELECT COUNT(*) n FROM `' + table + '`');
      expect(rows, table).toMatchObject([{ n: '0' }]);
    }
  }
  async function readNegative(operationId: string) {
    return f.db.get('writer').transaction(async (tx) => {
      const [raw] = await f.connection.query(
        'SELECT data FROM pos_rewrite_public_screening_work WHERE operation_id=?',
        [operationId],
      );
      const row = z
        .array(z.object({ data: z.unknown() }))
        .length(1)
        .parse(raw)[0]!;
      return readPublicScreeningNegative(tx, nodeScreeningWriterSchema.parse(row.data), sourceKey);
    });
  }
  it('actual pinned source stock denial seals the exact dispatched nonce; closure keeps the cart and cannot repeat source creation', async () => {
    const p = await f.prepare();
    await f.connection.query('UPDATE product_store SET stock=0 WHERE product_id=390238');
    expect(run(p.value)).toMatchObject({ code: 'SCREENING_WRITER_STOCK_CHANGED' });
    const proof = await readNegative(p.scope.operationId);
    expect(proof).toMatchObject({
      code: 'SCREENING_WRITER_STOCK_CHANGED',
      noOrder: true,
      noFinancialEffects: true,
    });
    const { app } = await f.app(p.c, noMoney);
    try {
      expect((await app.inject({ url: base(p.scope) })).json()).toMatchObject({
        status: 'source-rejected',
        canCloseNoOrder: true,
      });
      const closed = await app.inject({
        method: 'POST',
        url: base(p.scope) + '/closures',
        payload: {},
      });
      expect(closed.statusCode, closed.body).toBe(200);
      expect(closed.json()).toMatchObject({ status: 'closed-no-order' });
      const [raw] = await f.connection.query(
        'SELECT state FROM pos_rewrite_checkout_sessions WHERE id=?',
        [p.scope.checkoutId],
      );
      expect(raw).toMatchObject([
        {
          state: {
            phase: 'quoted',
            quote: p.state.quote,
            cart: p.state.cart,
            draftId: p.state.draftId,
            screeningAdmission: { operationId: p.scope.operationId, status: 'closed-no-order' },
          },
        },
      ]);
      expect(run(p.value)).toMatchObject({ code: 'SCREENING_WRITER_SCOPE_CHANGED' });
      expect(await readNegative(p.scope.operationId)).toEqual(proof);
      expect(
        (await app.inject({ method: 'POST', url: base(p.scope) + '/closures', payload: {} }))
          .statusCode,
      ).toBe(200);
      await emptyEffects();
    } finally {
      await app.close();
    }
  });
  it('expired uncertain dispatch is fenced by genuine WSGI proof even after its HTTP acknowledgment is lost', async () => {
    const methods: string[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
      methods.push(init?.method ?? 'GET');
      expect(new Headers(init?.headers).get('X-POS-Public-Screening-Negative-Key')).toBe(key);
      expect(init?.redirect).toBe('error');
      const body = z
        .object({ operationId: z.uuid() })
        .strict()
        .parse(JSON.parse(String(init?.body)) as unknown);
      const result = source(body.operationId);
      expect(result.responses[0]?.status).toBe('200 OK');
      throw new Error('Lost source commit acknowledgment');
    };
    const p = await f.prepare({
      negativeUrl: 'https://private.example.test/internal/pos/public-screening/no-order-receipts',
      negativeKey: key,
      negativeContract: 'pos-node-screening-negative-resource-v1',
      fetcher,
    });
    f.setNow(financialClock + 61000);
    await f.connection.query(
      "UPDATE pos_rewrite_checkout_sessions SET state=JSON_SET(state,'$.phase','uncertain','$.busyOperationId',NULL)",
    );
    await f.connection.query("UPDATE pos_rewrite_checkout_operations SET status='uncertain'");
    const { app } = await f.app(p.c, noMoney);
    try {
      const closed = await app.inject({
        method: 'POST',
        url: base(p.scope) + '/closures',
        payload: {},
      });
      expect(closed.statusCode, closed.body).toBe(200);
      expect(closed.json()).toMatchObject({ status: 'closed-no-order' });
      const replay = publicScreeningRecovery(f.coordinator({ contract: undefined }));
      expect(await replay.read(screeningUser, p.scope)).toMatchObject({
        status: 'closed-no-order',
      });
      expect(await replay.closeUnsent(screeningUser, p.scope)).toMatchObject({
        status: 'closed-no-order',
      });
      expect(methods).toEqual(['POST']);
      const retained = source(p.scope.operationId, {
        allowPost: false,
        requests: [{ method: 'GET' }],
      });
      expect(retained.responses[0]?.status).toBe('200 OK');
      expect(retained.events).toEqual([
        expect.objectContaining({
          resource: 'no-order-receipts',
          requestId: expect.stringMatching(/^.{128}$/),
          userId: '1',
        }),
      ]);
      await emptyEffects();
    } finally {
      await app.close();
    }
  });
  it.each(['404', 'timeout', 'fake-2xx'] as const)(
    'keeps %s transport outcome uncertain without a native source proof',
    async (kind) => {
      const fetcher: typeof fetch = async () => {
        if (kind === 'timeout') throw new Error('Uncertain request');
        return kind === '404'
          ? new Response('', { status: 404 })
          : Response.json({ noOrder: true });
      };
      const p = await f.prepare({
        negativeUrl: 'https://private.example.test/internal/pos/public-screening/no-order-receipts',
        negativeKey: key,
        negativeContract: 'pos-node-screening-negative-resource-v1',
        fetcher,
      });
      f.setNow(financialClock + 61000);
      const { app } = await f.app(p.c, noMoney);
      try {
        expect(
          (await app.inject({ method: 'POST', url: base(p.scope) + '/closures', payload: {} }))
            .statusCode,
        ).toBe(409);
        expect((await app.inject({ url: base(p.scope) })).json()).toMatchObject({
          status: 'awaiting-source',
        });
        expect(await readNegative(p.scope.operationId)).toBeNull();
        await emptyEffects();
      } finally {
        await app.close();
      }
    },
  );
  it('GET, invalid credentials and unexpired closure never mint a source negative', async () => {
    const p = await f.prepare();
    const result = source(p.scope.operationId, {
      now: financialClock,
      requests: [{ method: 'GET' }, { method: 'POST', key: 'invalid' }, { method: 'POST' }],
    });
    expect(result.responses.map((x) => x.status)).toEqual([
      '404 Not Found',
      '401 Unauthorized',
      '409 Conflict',
    ]);
    expect(await readNegative(p.scope.operationId)).toBeNull();
    expect(run(p.value)).toHaveProperty('result');
    expect(source(p.scope.operationId).responses[0]?.status).toBe('409 Conflict');
  });
  it.each(['contact', 'actor', 'checkin'] as const)(
    'changed current %s cannot create a new closure proof',
    async (field) => {
      const p = await f.prepare();
      if (field === 'contact')
        await f.connection.query("UPDATE users SET telephone='9000000001' WHERE id=77");
      if (field === 'actor') await f.connection.query('UPDATE pos_user SET is_active=0 WHERE id=1');
      if (field === 'checkin')
        await f.connection.query(
          "UPDATE pos_rewrite_operator_checkins SET expires_at='2026-06-14 23:59:59'",
        );
      expect(source(p.scope.operationId).responses[0]?.status).toBe('409 Conflict');
      expect(await readNegative(p.scope.operationId)).toBeNull();
      await emptyEffects();
    },
  );
  it('unknown late failure rolls all source writes back but does not fabricate a signed denial', async () => {
    const p = await f.prepare();
    expect(run({ ...p.value, lateFailure: true })).toMatchObject({
      code: 'SCREENING_WRITER_FIXTURE_LATE_FAILURE',
    });
    expect(await readNegative(p.scope.operationId)).toBeNull();
    await emptyEffects();
    expect(source(p.scope.operationId).responses[0]?.status).toBe('200 OK');
    expect(await readNegative(p.scope.operationId)).not.toBeNull();
  });
  it('expiry after all literal source order writes rolls back to the held guard and seals one no-effects receipt', async () => {
    const p = await f.prepare();
    expect(run({ ...p.value, finishNow: financialClock + 61000 })).toMatchObject({
      code: 'SCREENING_WRITER_EXPIRED',
    });
    expect(await readNegative(p.scope.operationId)).toMatchObject({
      code: 'SCREENING_WRITER_EXPIRED',
    });
    await emptyEffects();
    expect(run(p.value)).toMatchObject({ code: 'SCREENING_SOURCE_COMMAND_CLOSED' });
  });
  it('an attempted physical source COMMIT discards the connection and cannot leak order writes or fabricate a negative', async () => {
    const p = await f.prepare();
    expect(run({ ...p.value, escapeCommit: true })).toMatchObject({
      code: 'ORDER_IMPORT_SOURCE_COMMIT_ESCAPED',
    });
    expect(await readNegative(p.scope.operationId)).toBeNull();
    await emptyEffects();
    expect(source(p.scope.operationId).responses[0]?.status).toBe('200 OK');
  });
  it('revocation during the private call retains the source proof but denies the late Node response', async () => {
    const fetcher: typeof fetch = async (_url, init) => {
      const body = z
        .object({ operationId: z.uuid() })
        .parse(JSON.parse(String(init?.body)) as unknown);
      const proof = source(body.operationId).responses[0]!;
      f.setValid(false);
      return Response.json(proof.body);
    };
    const p = await f.prepare({
      negativeUrl: 'https://private.example.test/internal/pos/public-screening/no-order-receipts',
      negativeKey: key,
      negativeContract: 'pos-node-screening-negative-resource-v1',
      fetcher,
    });
    f.setNow(financialClock + 61000);
    const { app } = await f.app(p.c, noMoney);
    try {
      expect(
        (await app.inject({ method: 'POST', url: base(p.scope) + '/closures', payload: {} }))
          .statusCode,
      ).toBe(401);
      expect(await readNegative(p.scope.operationId)).not.toBeNull();
      f.setValid(true);
      expect((await app.inject({ url: base(p.scope) })).json()).toMatchObject({
        status: 'source-rejected',
      });
      expect(
        (
          await app.inject({ method: 'POST', url: base(p.scope) + '/closures', payload: {} })
        ).json(),
      ).toMatchObject({ status: 'closed-no-order' });
      await emptyEffects();
    } finally {
      await app.close();
    }
  });
  it('20 concurrent explicit closures retain one immutable proof and one local closure version', async () => {
    const p = await f.prepare();
    expect(source(p.scope.operationId).responses[0]?.status).toBe('200 OK');
    const service = publicScreeningRecovery(p.c),
      results = await Promise.all(
        Array.from({ length: 20 }, () => service.closeUnsent(screeningUser, p.scope)),
      );
    expect(results.every((row) => row.status === 'closed-no-order')).toBe(true);
    const [rows] = await f.connection.query(
      'SELECT version,state FROM pos_rewrite_checkout_sessions WHERE id=?',
      [p.scope.checkoutId],
    );
    expect(rows).toMatchObject([
      { version: p.state.version + 1, state: { version: p.state.version + 1 } },
    ]);
    const [proofs] = await f.connection.query(
      'SELECT COUNT(*) n FROM pos_rewrite_public_screening_negatives',
    );
    expect(proofs).toMatchObject([{ n: '1' }]);
    await emptyEffects();
  });
  it.each(['source-effects', 'payment-evidence', 'reservation'] as const)(
    'existing %s prevents source no-order proof, not a false zero',
    async (kind) => {
      const p = await f.prepare();
      if (kind === 'source-effects')
        await f.connection.execute(
          "INSERT INTO pos_rewrite_public_screening_effects VALUES(?, '', ?, 'uncertain','[]',?,?)",
          [p.scope.operationId, 'a'.repeat(64), financialClock, financialClock],
        );
      if (kind === 'payment-evidence')
        await f.connection.execute(
          "INSERT INTO pos_rewrite_public_screening_payment_evidence VALUES(?,?,?,'{}',?,NULL,NULL)",
          ['opaque-provider', p.scope.operationId, '5001', 'a'.repeat(64)],
        );
      if (kind === 'reservation')
        await f.connection.execute(
          "INSERT INTO pos_rewrite_import_screening_reservations(operation_id,customer_id,sku,data,proof_hash) VALUES(?,77,'390238','{}',?)",
          [p.scope.operationId, 'a'.repeat(64)],
        );
      expect(source(p.scope.operationId).responses[0]?.status).toBe('409 Conflict');
      expect(await readNegative(p.scope.operationId)).toBeNull();
    },
  );
  it('a winning source closure blocks an original sender waiting on its native creation guard', async () => {
    const p = await f.prepare(),
      folder = mkdtempSync(join(tmpdir(), 'pos-public-screening-')),
      gate = join(folder, 'release'),
      child = spawn(python, ['-B', driver], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    const ready = new Promise<void>((resolveReady, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes('PUBLIC_BODY_READY\n')) resolveReady();
      });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code !== 0) reject(new Error('Closure fixture failed'));
      });
    });
    const done = new Promise<number | null>((resolveDone) => child.once('close', resolveDone));
    child.stdin.end(JSON.stringify(input(p.scope.operationId, { gate })));
    try {
      await ready;
      const delayed = runAsync(p.value);
      writeFileSync(gate, 'release');
      expect(await done).toBe(0);
      expect(await delayed.completed).toMatchObject({ code: 'SCREENING_SOURCE_COMMAND_CLOSED' });
      expect(await readNegative(p.scope.operationId)).not.toBeNull();
      await emptyEffects();
    } finally {
      child.kill();
      rmSync(folder, { recursive: true, force: true });
    }
  }, 20000);
  it('a winning actual source creation prevents an expired closure from claiming no order', async () => {
    const p = await f.prepare(),
      folder = mkdtempSync(join(tmpdir(), 'pos-public-screening-')),
      gate = join(folder, 'release'),
      creating = runAsync({ ...p.value, gate });
    try {
      await creating.ready;
      const child = spawn(python, ['-B', driver], { stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      const done = new Promise<number | null>((resolveDone) => child.once('close', resolveDone));
      child.stdin.end(JSON.stringify(input(p.scope.operationId)));
      writeFileSync(gate, 'release');
      expect(await creating.completed).toHaveProperty('result');
      expect(await done).toBe(0);
      expect(resultSchema.parse(JSON.parse(output) as unknown).responses[0]?.status).toBe(
        '409 Conflict',
      );
      expect(await readNegative(p.scope.operationId)).toBeNull();
    } finally {
      creating.stop();
      rmSync(folder, { recursive: true, force: true });
    }
  }, 20000);
  it.each(['proof', 'intent', 'dispatch', 'oversized'] as const)(
    '%s tampering never closes or reopens an admission',
    async (kind) => {
      const p = await f.prepare();
      expect(source(p.scope.operationId).responses[0]?.status).toBe('200 OK');
      if (kind === 'proof')
        await f.connection.query(
          "UPDATE pos_rewrite_public_screening_negatives SET proof_hash=REPEAT('b',64)",
        );
      if (kind === 'intent')
        await f.connection.query(
          "UPDATE pos_rewrite_public_screening_negatives SET data=JSON_SET(data,'$.intent.requestHash',REPEAT('b',64))",
        );
      if (kind === 'dispatch')
        await f.connection.query(
          "UPDATE pos_rewrite_public_screening_submission_dispatches SET proof_hash=REPEAT('b',64)",
        );
      if (kind === 'oversized')
        await f.connection.query(
          "UPDATE pos_rewrite_public_screening_negatives SET data=JSON_SET(data,'$.padding',REPEAT('x',13000))",
        );
      const { app } = await f.app(p.c, noMoney);
      try {
        expect(
          (await app.inject({ method: 'POST', url: base(p.scope) + '/closures', payload: {} }))
            .statusCode,
        ).toBe(409);
        expect((await app.inject({ url: base(p.scope) })).statusCode).toBe(409);
        expect(run(p.value)).not.toHaveProperty('result');
        await emptyEffects();
      } finally {
        await app.close();
      }
    },
  );
});
