import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { getTableName, eq, sql } from 'drizzle-orm';
import { Temporal } from '@js-temporal/polyfill';
import Fastify from 'fastify';
import { splitMigration } from '../../src/db/migrations.js';
import {
  Order,
  HasProduct,
  PosMachine,
  PosPaytmMachine,
  PosTerminalTransaction,
  PosPaytmTransaction,
  PosTerminalPaymentModes,
} from '../../src/db/legacy-schema.js';
import {
  checkoutProjections,
  checkoutProjectionLines,
  checkoutHeaderHashSql,
  checkoutLineHashSql,
} from '../../src/modules/checkout/projection.js';
import {
  checkoutCustomerConsents,
  customerConsentContract,
} from '../../src/modules/checkout/customer-consent-proof.js';
import { checkoutStateSchema } from '../../src/modules/checkout/contracts.js';
import { publicScreeningFixture, run, environment } from './native-fixture.js';
import { publicScreeningCoordinator } from '../../src/modules/checkout/screening-writer/coordinator.js';
import {
  readPublicScreeningCreation,
  type PublicScreeningCreation,
} from '../../src/modules/checkout/screening-writer/proof.js';
import { sourceKey, financialClock } from '../legacy-import-financial/fixture.js';
import { signingEnvironment } from '../checkout/fixtures.js';
import { registerPublicScreening } from '../../src/modules/checkout/screening-writer/routes.js';
import { registerPayments } from '../../src/modules/checkout/payments/routes.js';
import type { Principal } from '../../src/domain/access.js';
import type { PaymentGateway } from '../../src/modules/checkout/payments/contracts.js';
import type { PublicScreeningOptions } from '../../src/modules/checkout/screening-writer/options.js';
export const screeningUser: Principal = {
  id: '1',
  name: 'Fixture manager',
  email: 'fixture@example.test',
  role: 1,
  userType: 1,
  storeIds: [],
};
const paymentTables = [
  PosMachine,
  PosPaytmMachine,
  PosTerminalTransaction,
  PosPaytmTransaction,
  PosTerminalPaymentModes,
].map(getTableName);
export async function publicApiFixture(template: string) {
  const f = await publicScreeningFixture(template);
  // Verified physical table names are read from the generated metadata; no
  // source schema or production database is changed by this disposable fixture.
  await f.fixture.create(paymentTables);
  for (const path of [
    'migrations/0002_auth_sessions.sql',
    'src/modules/checkout/cancellations/migration.sql',
    'src/modules/checkout/screening-writer/migration.sql',
    'src/modules/checkout/payments/provider-evidence-migration.sql',
  ])
    for (const statement of splitMigration(readFileSync(path, 'utf8')))
      await f.connection.query(statement);
  for (const statement of splitMigration(
    readFileSync('src/modules/checkout/migrations/0005_financial_delivery_context.sql', 'utf8'),
  ))
    if (statement.includes('ALTER TABLE pos_rewrite_payment_outbox'))
      await f.connection.query(statement);
  async function reset() {
    for (const table of [
      'pos_rewrite_sessions',
      'pos_rewrite_payment_provider_facts',
      'pos_rewrite_public_screening_work',
      'pos_rewrite_public_screening_payment_evidence',
      'pos_rewrite_public_screening_publication_dispatches',
      'pos_rewrite_public_screening_submission_dispatches',
      'pos_rewrite_public_screening_publication_replies',
      ...paymentTables,
    ])
      await f.connection.query('DELETE FROM `' + table + '`');
    await f.reset();
  }
  let now = financialClock,
    valid = true;
  function coordinator(
    options: PublicScreeningOptions & {
      authSessionValid?: (user: Principal) => Promise<boolean>;
    } = {},
  ) {
    return publicScreeningCoordinator(
      f.config,
      f.db,
      { ...signingEnvironment, ...environment },
      {
        contract: 'pos-node-screening-writer-v1',
        proofKey: sourceKey,
        clock: () => now,
        authSessionValid: async () => valid,
        ...options,
      },
    );
  }
  async function prepare(
    options: PublicScreeningOptions = {},
    unitPrice = '25.00',
    dispatch = true,
  ) {
    const p = await f.prepare(2, false, undefined, false),
      lines = [{ productId: '390238', quantity: 2, unitPrice }],
      quote = unitPrice === '25.00' ? p.state.quote : run({ action: 'quote', lines }),
      state = checkoutStateSchema.parse({
        ...p.state,
        quote,
        cart: quote,
        screeningAdmission: { operationId: p.state.busyOperationId!, status: 'pending' },
      }),
      c = coordinator(options);
    await f.connection.execute('UPDATE pos_rewrite_checkout_sessions SET state=? WHERE id=?', [
      JSON.stringify(state),
      state.id,
    ]);
    if (unitPrice === '0.00') {
      p.value.payload.id = 3;
      p.value.payload.payment_method = 'prepaid';
    }
    const signed = await c.service.issue(
      screeningUser,
      state,
      state.busyOperationId!,
      p.value.payload,
    );
    if (dispatch) await c.service.beforeDispatch(screeningUser, state, state.busyOperationId!);
    return {
      ...p,
      state,
      c,
      value: { ...p.value, lines, header: signed.header },
      scope: { storeId: '1', checkoutId: state.id, operationId: state.busyOperationId! },
    };
  }
  async function initialQuoted() {
    const p = await f.prepare(2, false, undefined, false),
      state = checkoutStateSchema.parse({ ...p.state, busyOperationId: null });
    await f.connection.execute('UPDATE pos_rewrite_checkout_sessions SET state=? WHERE id=?', [
      JSON.stringify(state),
      state.id,
    ]);
    await f.connection.execute('DELETE FROM pos_rewrite_checkout_operations WHERE checkout_id=?', [
      state.id,
    ]);
    return { ...p, state };
  }
  async function created(options: PublicScreeningOptions = {}, unitPrice = '25.00') {
    if (unitPrice === '0.00')
      await f.connection.query('UPDATE products SET price=0 WHERE id=390238');
    const p = await prepare(options, unitPrice),
      result = run(p.value);
    if (!result || typeof result !== 'object' || !('result' in result))
      throw new Error('Actual source creation failed');
    const creation = await f.db
      .get('writer')
      .transaction((tx) => readPublicScreeningCreation(tx, p.scope.operationId, sourceKey));
    if (!creation) throw new Error('Actual source creation proof missing');
    await p.c.service.created(screeningUser, p.state, p.scope.operationId, creation.orderId);
    const state = checkoutStateSchema.parse({
      ...p.state,
      orderId: creation.orderId,
      orderSubmissionOperationId: creation.operationId,
      phase: 'order-created',
      screeningAdmission: { operationId: creation.operationId, status: 'created' },
    });
    await f.connection.execute('UPDATE pos_rewrite_checkout_sessions SET state=? WHERE id=?', [
      JSON.stringify(state),
      state.id,
    ]);
    return { ...p, state, creation };
  }
  async function confirm(creation: PublicScreeningCreation, prepaid = false) {
    if (process.env.POS_PUBLIC_SCREENING_GO_BINARY && !prepaid) {
      const result = spawnSync(
        process.env.POS_PUBLIC_SCREENING_GO_BINARY,
        ['-test.run=^TestPublicScreeningExistingSource$', '-test.v'],
        {
          input: JSON.stringify({
            url: f.config.MYSQL_WRITER_URL,
            proofKey: sourceKey,
            orderId: Number(creation.orderId),
            expectRejected: false,
          }),
          encoding: 'utf8',
          timeout: 20000,
          maxBuffer: 32000,
          env: { ...process.env, POS_PUBLIC_SCREENING_FIXTURE: '1' },
        },
      );
      if (result.status !== 0)
        throw new Error('Actual Go source confirmation failed: ' + result.stdout);
      return;
    }
    // Explicit native-projection fixture for normal Node tests. The full source
    // runner supplies the actual Go binary above for the same API scenarios.
    await f.db.get('writer').transaction(async (tx) => {
      await tx
        .update(Order)
        .set({
          payment_statuses: prepaid ? 4n : 1n,
          order_statuses: prepaid ? 3n : 1n,
          is_stock_reduced: 1,
        })
        .where(eq(Order.id, BigInt(creation.orderId)));
      await tx
        .update(HasProduct)
        .set({ status: prepaid ? 'DELIVERED' : 'PLACED' })
        .where(eq(HasProduct.order, BigInt(creation.orderId)));
      const [header] = await tx
        .select({ hash: sql<string>`${sql.raw(checkoutHeaderHashSql)}` })
        .from(Order)
        .where(eq(Order.id, BigInt(creation.orderId)));
      const lines = await tx
        .select({
          id: HasProduct.id,
          productId: HasProduct.product,
          quantity: HasProduct.qty,
          hash: sql<string>`${sql.raw(checkoutLineHashSql)}`,
        })
        .from(HasProduct)
        .where(eq(HasProduct.order, BigInt(creation.orderId)));
      await tx.insert(checkoutProjections).values({
        orderId: BigInt(creation.orderId),
        storeId: 1n,
        counterId: 2n,
        userId: 77n,
        inputHash: header!.hash,
        lineCount: lines.length,
        contractVersion: 'pos-checkout-projection-v1',
        confirmedAt: '2026-06-15 06:30:00',
      });
      await tx.insert(checkoutProjectionLines).values(
        lines.map((line) => ({
          orderId: BigInt(creation.orderId),
          lineId: line.id,
          productId: line.productId,
          quantity: line.quantity,
          inputHash: line.hash,
        })),
      );
      await tx.insert(checkoutCustomerConsents).values({
        orderId: BigInt(creation.orderId),
        customerId: 77n,
        operatorId: 1n,
        storeId: 1n,
        counterId: 2n,
        inputHash: header!.hash,
        required: 0,
        contactRevision: null,
        contactDigest: null,
        verifiedUntilMs: null,
        acceptedAtMs: BigInt(financialClock),
        contractVersion: customerConsentContract,
      });
    });
  }
  async function app(c: ReturnType<typeof coordinator>, gateway: PaymentGateway) {
    const app = Fastify();
    app.decorateRequest('principal', null);
    app.decorateRequest('authSessionValid', null);
    app.addHook('preHandler', async (request) => {
      request.principal = screeningUser;
      request.authSessionValid = async () => valid;
    });
    registerPublicScreening(app, c);
    const service = registerPayments(app, f.config, f.db, {
      screening: c.payments,
      gateway,
      hashSecret: f.config.SESSION_SECRET,
      projection: signingEnvironment,
      clock: () => Temporal.Instant.fromEpochMilliseconds(now),
    });
    return { app, service };
  }
  return {
    ...f,
    reset,
    initialQuoted,
    coordinator,
    prepare,
    created,
    confirm,
    app,
    setNow: (value: number) => {
      now = value;
    },
    setValid: (value: boolean) => {
      valid = value;
    },
    resetScope: () => {
      now = financialClock;
      valid = true;
    },
    payment: (operationId = randomUUID()) => ({
      operationId,
      channel: 'cash' as const,
      cashAmount: '50.00',
      onlineAmount: '0.00',
      cashReceived: '60.00',
    }),
  };
}
