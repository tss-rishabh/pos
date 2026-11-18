import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { installNativeHeadFixture } from '../native-head-metadata/fixture.js';
import { execFileSync, spawn } from 'node:child_process';
import Fastify from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { splitMigration } from '../../src/db/migrations.js';
import { operationHash } from '../../src/modules/checkout/crypto.js';
import { checkoutHeaderHashSql } from '../../src/modules/checkout/projection.js';
import { cancellationMembershipHashSql } from '../../src/modules/checkout/cancellations/membership.js';
import {
  cancellationMembershipProvenance,
  cancellationMembershipVersions,
} from '../../src/modules/checkout/cancellations/benefit-schema.js';
import {
  financialImportSourceReceipts,
  financialImportOrderBindings,
  financialImportProofs,
} from '../../src/modules/legacy-order-imports/financial-adapter-schema.js';
import { legacyImportFinancialJournal } from '../../src/modules/legacy-order-imports/financial-adapter-journal.js';
import { nativeImportOrder } from '../../src/modules/legacy-order-imports/financial-adapter-proof.js';
import { sourceOrderReceiptSchema } from '../../src/modules/legacy-order-imports/financial-adapter-contracts.js';
import { csvMembershipImportProfile } from '../../src/modules/legacy-order-imports/membership-profile/adapter.js';
import { validateCsvMembershipCompletionSnapshot } from '../../src/modules/legacy-order-imports/membership-profile/completion.js';
import {
  activatedMembershipContract,
  csvMemberStateSchema,
  csvMembershipReceiptHash,
  membershipProvenanceHash,
  type CsvMembershipProvenance,
} from '../../src/modules/legacy-order-imports/membership-profile/domain.js';
import { importFinancialFixture, sourceKey } from '../legacy-import-financial/fixture.js';
import { adapterOptions, memberEvidence } from './adapter-fixtures.js';
import type { FinancialSourceCommand } from '../../src/modules/legacy-order-imports/financial-adapter-transport.js';
import type { CsvMembershipOptions } from '../../src/modules/legacy-order-imports/membership-profile/native.js';
import {
  financialSourceHash,
  financialImportHash,
} from '../../src/modules/legacy-order-imports/financial-adapter-crypto.js';
import { legacyOrderImportFinancialAdapter } from '../../src/modules/legacy-order-imports/financial-adapter.js';
import { financialAdapterProfiles } from '../../src/modules/legacy-order-imports/financial-adapter-profiles.js';
import { verifiedImportCompletion } from '../../src/modules/legacy-order-imports/financial-adapter-proof.js';
import type { AdministrationTransaction } from '../../src/modules/administration/checkins.js';
import { configuredFinancialImportProfiles } from '../../src/modules/legacy-order-imports/membership-profile/options.js';
import { configuredLegacyOrderImports } from '../../src/modules/legacy-order-imports/runtime.js';
import { legacyOrderImportService } from '../../src/modules/legacy-order-imports/service.js';
import { legacyOrderImportRepository } from '../../src/modules/legacy-order-imports/repository.js';
import { registerLegacyOrderImports } from '../../src/modules/legacy-order-imports/index.js';
import { legacyOrderImportWorker } from '../../src/modules/legacy-order-imports/worker.js';
import { legacyOrderImportRows } from '../../src/modules/legacy-order-imports/schema.js';
import { PosUser } from '../../src/db/legacy-schema.js';
import { offlineOrderColumns } from '../../src/modules/legacy-order-imports/csv.js';
import { AppError } from '../../src/domain/errors.js';
import type { ImportFinancialStart } from '../../src/modules/legacy-order-imports/financial-contracts.js';
import {
  runtimeImportInput,
  runtimeImportSecret,
} from '../legacy-order-imports/runtime-fixture.js';

const template = process.env.CHECKOUT_MYSQL_TEST_URL;
describe.skipIf(!template)('server-installed membership adapter on isolated native writer', () => {
  let f: Awaited<ReturnType<typeof importFinancialFixture>>;
  let heads: Awaited<ReturnType<typeof installNativeHeadFixture>>;
  let previousEnvironment: Record<string, string | undefined> = {};
  let baseFixture: Awaited<ReturnType<typeof importFinancialFixture>>;
  beforeAll(async () => {
    baseFixture = await importFinancialFixture(template!);
    f = baseFixture;
    for (const path of [
      'src/modules/checkout/cancellations/benefit-migration.sql',
      'src/modules/checkout/cancellations/membership-producer-migration.sql',
    ])
      for (const statement of splitMigration(readFileSync(path, 'utf8')))
        await f.connection.query(statement);
    await f.connection.query('CREATE INDEX fixture_users_email ON users(email)');
    heads = await installNativeHeadFixture(f.connection, template!, {
      families: ['membershipRevision'],
    });
    previousEnvironment = Object.fromEntries(
      Object.keys(heads.environment).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, heads.environment);
    const operational = [
      'pos_rewrite_cancellation_membership_provenance',
      'pos_rewrite_legacy_order_imports',
      'pos_rewrite_legacy_order_import_rows',
      'pos_rewrite_import_authority_heads',
      'pos_rewrite_import_authority_successions',
      'pos_rewrite_import_authority_stage_claims',
      'pos_rewrite_import_authority_continuations',
      'pos_rewrite_import_financial_operations',
      'pos_rewrite_import_financial_stages',
      'pos_rewrite_import_financial_approvals',
      'pos_rewrite_import_financial_references',
      'pos_rewrite_import_financial_source_receipts',
      'pos_rewrite_import_financial_order_bindings',
      'pos_rewrite_import_financial_source_effects',
      'pos_rewrite_import_financial_proofs',
      'pos_rewrite_import_financial_close_impacts',
      'pos_rewrite_customer_contact_revisions',
      'pos_rewrite_operator_auth_epochs',
      'pos_rewrite_checkout_customer_consents',
      'pos_rewrite_checkout_projection_lines',
      'pos_rewrite_checkout_projections',
      'pos_rewrite_payment_attempts',
      'pos_rewrite_payment_outbox',
      'pos_rewrite_administration_outbox',
      'pos_rewrite_gift_card_issuances',
      'product_store',
      'product_stocks',
      'product_inventory_logs',
      'pos_product_inventory_logs',
      'pos_inventory_sync_log',
      'products_inventory_logs',
      'order_stores',
      'order_status',
      'amount_to_be_refunded_log',
      'comments',
      'pos_transaction_logs',
      'gift_vouchers',
      'store_day_close',
    ];
    for (const table of ['stores', 'pos_user', 'products'])
      await f.connection.query(
        'GRANT UPDATE ON ' +
          mysql.escapeId(heads.schema) +
          '.' +
          mysql.escapeId(table) +
          ' TO ' +
          mysql.escape(heads.names.app) +
          "@'%'",
      );
    for (const table of operational)
      await f.connection.query(
        'GRANT INSERT, UPDATE, DELETE ON ' +
          mysql.escapeId(heads.schema) +
          '.' +
          mysql.escapeId(table) +
          ' TO ' +
          mysql.escape(heads.names.app) +
          "@'%'",
      );
    f = {
      ...baseFixture,
      db: heads.appDb,
      config: {
        ...baseFixture.config,
        MYSQL_WRITER_URL: heads.appUrl,
        MYSQL_PRIMARY_READER_URL: heads.appUrl,
      },
    };
  }, 30000);
  afterAll(async () => {
    await heads?.close();
    await baseFixture?.close();
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await f.reset();
    await f.connection.query('DELETE FROM pos_rewrite_cancellation_membership_provenance');
    await f.connection.query('DELETE FROM pos_rewrite_membership_versions');
  });
  async function memberRows() {
    const [rows] = await f.db.get('writer').execute(sql`
      SELECT attribute,value,is_active AS active,
       DATE_FORMAT(TIMESTAMPADD(SECOND,UNIX_TIMESTAMP(created_at),'1970-01-01 00:00:00'),'%Y-%m-%d %H:%i:%s') AS createdAt,
       DATE_FORMAT(TIMESTAMPADD(SECOND,UNIX_TIMESTAMP(updated_at),'1970-01-01 00:00:00'),'%Y-%m-%d %H:%i:%s') AS updatedAt,
       ${sql.raw(cancellationMembershipHashSql)} AS hash
      FROM user_eav WHERE entity='private-import@example.test' ORDER BY attribute`);
    return z.array(csvMemberStateSchema).parse(rows);
  }
  async function prepare(
    kind: 'offline' | 'shopify' = 'offline',
    free = false,
    command?: FinancialSourceCommand,
    profileOptions: CsvMembershipOptions = adapterOptions,
    replacement = false,
  ) {
    const evidence = memberEvidence(kind, free),
      j = legacyImportFinancialJournal(f.config, f.db, f.options);
    if (replacement) evidence.plan = replacementPlan(kind);
    const reserved = command ?? (await j.reserve(f.input(evidence.plan)));
    evidence.state = { ...reserved.state, orderId: '5001', stage: 'confirmation' };
    evidence.plan = reserved.plan;
    const payable = replacement ? '2300.00' : evidence.plan.originalTenderAmount;
    await f.fixture.insert('orders', {
      id: '5001',
      user_id: '77',
      payment_method: kind === 'offline' ? 14 : 15,
      payment_status: kind === 'offline' ? 0 : 1,
      order_status: kind === 'offline' ? 0 : 1,
      created_at: evidence.plan.createdAt,
      updated_at: evidence.plan.createdAt,
      pay_amt: Number(payable),
      order_amt: Number(payable),
      cashback_used: 0,
      tss_money_used: 0,
      tss_points_used: 0,
      voucher_used: 0,
      voucher_amt_used: 0,
      coupon_used: 0,
      coupon_amt_used: 0,
      parent_order_id: 0,
      original_order_id: 0,
      hl_parent_order_id: 0,
      location_id: 0,
      order_ref_no: 'MEMBER-FIXTURE',
    });
    await f.fixture.insert('order_stores', {
      id: '1',
      order_id: '5001',
      store_id: '1',
      counter_id: '2',
    });
    for (const line of evidence.order.lines) {
      await f.fixture.insert('has_products', {
        id: line.id,
        order_id: '5001',
        prod_id: line.productId,
        sub_prod_id: 0,
        qty: 1,
        price: free && line.productId === '12' ? 0 : Number(payable),
        amount_to_be_refunded: free && line.productId === '12' ? 0 : Number(payable),
        status: 'INCOMPLETE',
        created_at: evidence.plan.createdAt,
        updated_at: evidence.plan.createdAt,
      });
      await f.fixture.insert('amount_to_be_refunded_log', {
        order_id: '5001',
        prod_id: line.productId,
        has_product_id: line.id,
        amount_to_be_refunded: free && line.productId === '12' ? 0 : Number(payable),
      });
    }
    const native = await f.db.get('writer').transaction((tx) => nativeImportOrder(tx, '5001'));
    evidence.order = sourceOrderReceiptSchema.parse({
      ...evidence.order,
      operationId: evidence.state.scope.operationId,
      requestHash: evidence.state.requestHash,
      namespace: evidence.state.namespace,
      headerHash: native.header.headerHash,
      lineHash: native.lineHash,
      lines: native.lines,
      ...(replacement ? { payable: '2300.00' } : {}),
    });
    for (const row of evidence.snapshot.receipt.provenance.confirmed)
      await f.fixture.insert('user_eav', {
        entity: evidence.plan.email,
        attribute: row.attribute,
        value: row.value,
        is_active: 0,
        created_at: evidence.plan.createdAt,
        updated_at: evidence.plan.createdAt,
      });
    const [revision] = await f.db.get('writer').select().from(cancellationMembershipVersions),
      [header] = await f.db
        .get('writer')
        .execute(sql`SELECT ${sql.raw(checkoutHeaderHashSql)} AS hash FROM orders WHERE id=5001`),
      headerHash = z.array(z.object({ hash: z.string() })).parse(header)[0]!.hash,
      member = evidence.order.lines.find((line) =>
        profileOptions.productIds.includes(line.productId),
      )!;
    const receipt = evidence.snapshot.receipt;
    Object.assign(receipt, {
      operationId: evidence.state.scope.operationId,
      requestHash: evidence.state.requestHash,
      planHash: evidence.state.planHash,
      namespace: evidence.state.namespace,
      authorityHash: operationHash(
        'legacy-order-imports.source.membership-authority.v1',
        evidence.state.authority,
        profileOptions.sourceProofKey,
      ),
      headerHash: evidence.order.headerHash,
      lineHash: evidence.order.lineHash,
      memberLines: [{ ...member, quantity: 1 }],
      additionalLines: free ? [{ ...member, quantity: 1 }] : [],
    });
    if (replacement)
      receipt.replacement = {
        contract: 'pos-csv-membership-replacement-v1',
        sourceAction: 'AddFreeMembership.remove_exclusive_membership',
        originalLine: {
          ...evidence.plan.lines[0]!,
          quantity: 1,
          sourceRows: [...evidence.plan.lines[0]!.sourceRows],
        },
        memberLine: { ...member, quantity: 1 },
      };
    Object.assign(receipt.provenance, {
      revision: String(revision!.revision),
      headerHash,
      confirmed: await memberRows(),
    });
    receipt.provenance.proofHash = membershipProvenanceHash(
      receipt.provenance,
      profileOptions.membershipProofKey,
    );
    evidence.snapshot.sourceReceiptHash = csvMembershipReceiptHash(
      receipt,
      profileOptions.sourceProofKey,
    );
    await f.db
      .get('writer')
      .insert(cancellationMembershipProvenance)
      .values({
        ...receipt.provenance,
        orderId: 5001n,
        customerId: 77n,
        revision: BigInt(receipt.provenance.revision),
      });
    await f.db
      .get('writer')
      .insert(financialImportSourceReceipts)
      .values({
        id: evidence.state.scope.operationId + ':membership',
        operationId: evidence.state.scope.operationId,
        kind: 'membership',
        requestHash: evidence.state.requestHash,
        status: 'completed',
        proof: receipt,
        proofHash: evidence.snapshot.sourceReceiptHash,
        createdAt: evidence.state.createdAt,
      });
    return evidence;
  }
  function replacementPlan(kind: 'offline' | 'shopify') {
    const plan = memberEvidence(kind, true).plan;
    plan.lines = [
      { productId: '10', quantity: 1, unitPrice: '100.00', sourceRows: [2] },
      { productId: '11', quantity: 1, unitPrice: '2300.00', sourceRows: [3] },
    ];
    plan.originalTenderAmount = '2400.00';
    if (plan.kind === 'shopify') {
      plan.declaredSubtotal = '2400.00';
      plan.declaredTotal = '2400.00';
    }
    return plan;
  }
  async function activate(evidence: Awaited<ReturnType<typeof prepare>>) {
    await f.connection.query(
      "UPDATE user_eav SET is_active=1 WHERE entity='private-import@example.test'",
    );
    const [version] = await f.db.get('writer').select().from(cancellationMembershipVersions);
    const provenance: CsvMembershipProvenance = {
      ...evidence.snapshot.receipt.provenance,
      contract: activatedMembershipContract,
      revision: String(version!.revision),
      confirmed: await memberRows(),
    };
    provenance.proofHash = membershipProvenanceHash(provenance, adapterOptions.membershipProofKey);
    await f.db
      .get('writer')
      .update(cancellationMembershipProvenance)
      .set({
        contract: provenance.contract,
        confirmed: provenance.confirmed,
        revision: BigInt(provenance.revision),
        proofHash: provenance.proofHash,
      })
      .where(eq(cancellationMembershipProvenance.orderId, 5001n));
  }
  async function core(
    kind: 'offline' | 'shopify' = 'shopify',
    free = false,
    qualified = true,
    originalInput?: ImportFinancialStart,
    replacement = false,
  ) {
    for (const [index, product] of ['10', '11', '12'].entries()) {
      await f.fixture.insert('products', {
        id: product,
        prod_type: 1,
        parent_prod_id: 0,
        price: 100,
      });
      await f.fixture.insert('product_stocks', {
        prod_id: product,
        parent_prod_id: 0,
        stock: 100,
        stocked: 0,
      });
      await f.fixture.insert('product_store', {
        id: 101 + index,
        product_id: product,
        store_id: 1,
        stock: 100,
        is_avail: 1,
        is_del: 0,
      });
    }
    const membership = { ...adapterOptions, sourceProofKey: sourceKey },
      profile = financialAdapterProfiles(qualified ? { membership } : {}),
      options = { ...f.options },
      input =
        originalInput ??
        f.input(replacement ? replacementPlan(kind) : memberEvidence(kind, free).plan),
      transport = f.transport();
    let evidence: Awaited<ReturnType<typeof prepare>> | null = null,
      cacheJobs = 1,
      ready = true;
    transport.assertReady = vi.fn(() => {
      if (!ready) throw new Error('isolated disabled source');
    });
    transport.order = vi.fn(async (command) => {
      evidence = await prepare(kind, free, command, membership, replacement);
      await f.db
        .get('writer')
        .insert(financialImportSourceReceipts)
        .values({
          id: command.state.scope.operationId + ':order',
          operationId: command.state.scope.operationId,
          kind: 'order',
          requestHash: command.state.requestHash,
          status: 'completed',
          proof: evidence.order,
          proofHash: financialSourceHash(sourceKey, 'order', evidence.order),
          createdAt: command.issuedAt,
        });
      await f.db
        .get('writer')
        .insert(financialImportOrderBindings)
        .values({
          orderId: evidence.order.orderId,
          operationId: command.state.scope.operationId,
          requestHash: command.state.requestHash,
          proofHash: financialSourceHash(sourceKey, 'order', evidence.order),
          status: 'held',
        });
    });
    const originalConfirm = transport.confirm;
    transport.confirm = vi.fn(async (...args: Parameters<typeof originalConfirm>) => {
      await originalConfirm(...args);
      if (!evidence) throw new Error('isolated member source missing');
      await activate(evidence);
      for (const sku of replacement ? ['10', '11'] : [free ? '11' : '10'])
        await f.connection.query(
          'UPDATE product_store SET stock=99 WHERE product_id=? AND store_id=1',
          [sku],
        );
    });
    transport.publication = vi.fn(async (command, order) => {
      const proof = {
        contract: 'pos-legacy-order-import-publication-v1',
        operationId: command.state.scope.operationId,
        orderId: order.orderId,
        requestHash: command.state.requestHash,
        sourceHash: order.effectsHash,
        acceptedAt: command.issuedAt,
        delivery: 'durable-queue-accepted',
        jobs: [
          { id: 'source-job-1', kind: 'kinesis-chain' },
          { id: 'source-job-2', kind: 'engagement' },
          ...Array.from({ length: cacheJobs }, (_, index) => ({
            id: 'source-member-job-' + index,
            kind: 'membership-cache',
          })),
        ],
      };
      await f.db
        .get('writer')
        .insert(financialImportSourceReceipts)
        .values({
          id: command.state.scope.operationId + ':publication',
          operationId: command.state.scope.operationId,
          kind: 'publication',
          requestHash: command.state.requestHash,
          status: 'completed',
          proof,
          proofHash: financialSourceHash(sourceKey, 'publication', proof),
          createdAt: command.issuedAt,
        });
    });
    return {
      options,
      input,
      transport,
      profile,
      adapter: legacyOrderImportFinancialAdapter(f.config, f.db, options, transport, profile),
      evidence: () => {
        if (!evidence) throw new Error('isolated member source missing');
        return evidence;
      },
      cacheJobs: (value: number) => {
        cacheJobs = value;
      },
      disable: () => {
        ready = false;
        options.sourceProofKey = '';
      },
    };
  }
  function execute(
    evidence: Awaited<ReturnType<typeof prepare>>,
    phase: 'staged' | 'settled',
    options = adapterOptions,
  ) {
    const profile = csvMembershipImportProfile(options);
    return f.db.get('writer').transaction(async (tx) => {
      await profile.lock!(tx, evidence);
      await profile.sourceReceipt!(tx, evidence, evidence.order);
      return profile.expectedQuantities!(tx, evidence, evidence.order, phase);
    });
  }
  function nativeReplacement(
    e: Awaited<ReturnType<typeof prepare>>,
    replaced: ReadonlyArray<(typeof e.plan.lines)[number]>,
  ) {
    const raw = execFileSync(
      'compatibility/upstream/offline-cash-pricing/.venv/bin/python',
      ['-B', 'tools/legacy-import-membership/native_replacement.py'],
      {
        input: JSON.stringify({
          url: f.config.MYSQL_WRITER_URL,
          plan: e.plan,
          capability: { scope: e.state.scope, authority: e.state.authority },
          additional: [{ productId: '12', quantity: 1, unitPrice: '0.00' }],
          replaced,
        }),
        encoding: 'utf8',
        timeout: 10_000,
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    return z
      .union([
        z.object({ code: z.string() }).strict(),
        z
          .object({
            lines: sourceOrderReceiptSchema.shape.lines,
            lineHash: z.string().regex(/^[a-f0-9]{64}$/),
            payable: z.string(),
          })
          .strict(),
      ])
      .parse(JSON.parse(raw) as unknown);
  }
  function recoveryRegistration(workerEnabled = true, creationSelected = false) {
    return configuredLegacyOrderImports(f.config, f.db, {
      environment: {
        LEGACY_ORDER_IMPORT_ENCRYPTION_KEY_V1: runtimeImportSecret,
        LEGACY_ORDER_IMPORT_WORKER_ENABLED: String(workerEnabled),
        LEGACY_ORDER_IMPORT_WORKER_BATCH_SIZE: '1',
        ...(creationSelected ? { LEGACY_ORDER_IMPORT_CONTRACT: 'pos-legacy-order-import-v1' } : {}),
        // The selected-but-incomplete current member configuration must block
        // NEW work without preventing an authenticated frozen completion.
        POS_LEGACY_IMPORT_MEMBERSHIP_CONTRACT: adapterOptions.contract,
      },
    });
  }
  async function lostJob() {
    const repository = legacyOrderImportRepository(f.db, { secret: runtimeImportSecret }),
      command = runtimeImportInput(),
      values: Record<(typeof offlineOrderColumns)[number], string> = {
        SerialNo: 'member-runtime-fixture',
        StoreId: '1',
        Email: 'private-import@example.test',
        UserName: 'Private fixture',
        IsExclusive: '1',
        ProductId: '10',
        ProductQty: '1',
        ProductPrice: '100.00',
        PaymentMode: 'cash',
        OrderDate: '2026-06-15 12:00:00',
        OrderPlacedSms: '0',
        OrderMessage: '',
      };
    command.csv =
      offlineOrderColumns.join(',') +
      '\n' +
      offlineOrderColumns.map((key) => values[key]).join(',');
    await repository.stage('1', 'retained-import-runtime-fixture', command);
    const [row] = await repository.results('1', command.id),
      input = await repository.financialContext('1', command.id, row!.operationId),
      c = await core('offline', false, true, input);
    await repository.runOne({
      async start(value) {
        const result = await c.adapter.start(value);
        expect(result.status).toBe('completed');
        throw new Error('isolated committed financial reply lost before queue acknowledgment');
      },
      read: c.adapter.read,
    });
    expect((await repository.results('1', command.id))[0]?.state).toBe('RECONCILING');
    await f.connection.query(
      "UPDATE pos_rewrite_import_financial_operations SET state=JSON_SET(state,'$.status','unknown')",
    );
    await f.connection.query(
      "UPDATE users SET email='changed@example.test',is_block=1 WHERE id=77",
    );
    await f.connection.query("UPDATE user_eav SET value='changed',is_active=0");
    await f.connection.query('UPDATE pos_rewrite_operator_auth_epochs SET epoch=epoch+1');
    await f.connection.query(
      "UPDATE pos_rewrite_import_financial_source_receipts SET proof='{}',proof_hash=REPEAT('0',64) WHERE kind='membership'",
    );
    c.disable();
    return { command, repository, c };
  }
  async function expireLease() {
    await f.connection.query(
      'UPDATE pos_rewrite_legacy_order_imports SET lease_until=UTC_TIMESTAMP(3)-INTERVAL 1 SECOND',
    );
  }
  async function financialEffects() {
    const [effects] = await f.connection.query(`SELECT
      (SELECT COUNT(*) FROM orders) AS orders,
      (SELECT COUNT(*) FROM has_products) AS line_count,
      (SELECT COUNT(*) FROM pos_transaction_logs) AS payments,
      (SELECT COUNT(*) FROM amount_to_be_refunded_log) AS refunds,
      (SELECT COUNT(*) FROM pos_rewrite_import_financial_stages) AS stages,
      (SELECT COUNT(*) FROM pos_rewrite_import_financial_source_receipts) AS receipts,
      (SELECT COUNT(*) FROM pos_rewrite_import_financial_proofs) AS proofs,
      (SELECT COUNT(*) FROM pos_rewrite_import_financial_source_effects) AS effects,
      (SELECT SUM(offline_payment) FROM order_stores) AS cash,
      (SELECT SUM(offline_payment_recieved) FROM order_stores) AS received,
      (SELECT SUM(online_other_payment) FROM order_stores) AS manual_other,
      (SELECT SUM(amount_to_be_refunded) FROM amount_to_be_refunded_log) AS refund_amount,
      (SELECT SUM(stock) FROM product_store) AS stock`);
    return effects;
  }
  const runtimeOperator = {
    id: '1',
    role: 1 as const,
    userType: 1 as const,
    storeIds: [],
    name: 'Fixture',
    email: 'fixture@example.test',
  };
  function recoveryApi(valid: () => Promise<boolean> = async () => true, creationSelected = false) {
    const app = Fastify({ logger: false });
    app.decorateRequest('principal', null);
    app.decorateRequest('authSessionValid', null);
    app.addHook('preHandler', async (request) => {
      request.principal = runtimeOperator;
      request.authSessionValid = valid;
    });
    app.setErrorHandler((error, _request, reply) =>
      error instanceof AppError
        ? reply.code(error.status).send({ error: { code: error.code } })
        : reply.code(500).send({ error: { code: 'INTERNAL_ERROR' } }),
    );
    registerLegacyOrderImports(app, f.config, f.db, recoveryRegistration(false, creationSelected));
    return app;
  }
  it.each([false, true])(
    'actual runtime job GET recovers the original completed member receipt after flags/keys/contact changes without dispatch (creation selected=%s)',
    async (creationSelected) => {
      const { command, c } = await lostJob();
      await expireLease();
      const before = await financialEffects(),
        network = vi.spyOn(globalThis, 'fetch'),
        app = recoveryApi(undefined, creationSelected);
      try {
        const capabilities = await app.inject({
          method: 'GET',
          url: '/api/v1/admin/order-imports/capabilities',
        });
        expect(capabilities.json()).toMatchObject({ ready: false });
        const detail = await app.inject({
          method: 'GET',
          url: '/api/v1/admin/order-imports/' + command.id,
        });
        expect(detail.statusCode).toBe(200);
        expect(detail.json()).toMatchObject({ state: 'COMPLETED', importedOrders: 1 });
        const results = await app.inject({
          method: 'GET',
          url: '/api/v1/admin/order-imports/' + command.id + '/results',
        });
        expect(results.statusCode).toBe(200);
        expect(results.json()).toMatchObject({ data: [{ state: 'IMPORTED', orderId: '5001' }] });
        expect(results.body).not.toMatch(
          /private-import|changed@example|Private fixture|membership|proofHash/,
        );
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/api/v1/admin/order-imports',
              payload: runtimeImportInput(),
            })
          ).statusCode,
        ).toBe(503);
        expect(await financialEffects()).toEqual(before);
        expect(network).not.toHaveBeenCalled();
        expect(c.transport.order).toHaveBeenCalledTimes(1);
        expect(c.transport.confirm).toHaveBeenCalledTimes(1);
        expect(c.transport.publication).toHaveBeenCalledTimes(1);
      } finally {
        await app.close();
      }
    },
    15000,
  );
  it('an explicitly enabled recovery worker skips earlier PENDING jobs and retains one completed proof despite changed old actor authority', async () => {
    const pending = runtimeImportInput(),
      repository = legacyOrderImportRepository(f.db, { secret: runtimeImportSecret });
    await repository.stage('1', 'pending-runtime-fixture', pending);
    await f.connection.query(
      'UPDATE pos_rewrite_legacy_order_imports SET lease_until=UTC_TIMESTAMP(3)+INTERVAL 1 HOUR WHERE id=?',
      [pending.id],
    );
    const { command, c } = await lostJob();
    await expireLease();
    await f.connection.query('UPDATE pos_user SET is_active=0 WHERE id=1');
    const registration = recoveryRegistration(),
      service = legacyOrderImportService(f.config, f.db, registration),
      before = await financialEffects(),
      network = vi.spyOn(globalThis, 'fetch'),
      events: unknown[] = [],
      workers = Array.from({ length: 4 }, () =>
        legacyOrderImportWorker(service, (_level, event) => events.push(event)),
      );
    expect(registration.canStart).toBe(false);
    expect(service.ready).toBe(false);
    expect(service.recoveryReady).toBe(true);
    try {
      await Promise.all(workers.map((worker) => worker.runOnce()));
    } finally {
      await Promise.all(workers.map((worker) => worker.stop()));
    }
    const rows = await f.db.get('writer').select().from(legacyOrderImportRows);
    expect(rows.find((row) => row.jobId === pending.id)).toMatchObject({
      state: 'PENDING',
      orderId: null,
    });
    expect(rows.find((row) => row.jobId === command.id)).toMatchObject({
      state: 'IMPORTED',
      orderId: '5001',
    });
    expect(await financialEffects()).toEqual(before);
    expect(network).not.toHaveBeenCalled();
    expect(c.transport.order).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toMatch(
      /private-import|changed@example|Private fixture|payload|csv/,
    );
  }, 15000);
  it('recovery GET respects active coordinator leases and current native caller authorization', async () => {
    const { command } = await lostJob(),
      app = recoveryApi(),
      before = await financialEffects();
    try {
      const leased = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/order-imports/' + command.id,
      });
      expect(leased.statusCode).toBe(200);
      expect(leased.json()).toMatchObject({ state: 'RUNNING', importedOrders: 0 });
      await expireLease();
      await f.db.get('writer').update(PosUser).set({ role: 4 }).where(eq(PosUser.id, 1n));
      const denied = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/order-imports/' + command.id,
      });
      expect(denied.statusCode).toBe(403);
      expect((await f.db.get('writer').select().from(legacyOrderImportRows))[0]?.state).toBe(
        'RECONCILING',
      );
      expect(await financialEffects()).toEqual(before);
    } finally {
      await app.close();
    }
  }, 15000);
  it('withholds a recovered job DTO when the current HTTP session is revoked while retaining the committed recovery', async () => {
    const { command } = await lostJob();
    await expireLease();
    let validations = 0;
    const app = recoveryApi(async () => ++validations === 1);
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/order-imports/' + command.id,
      });
      expect(response.statusCode).toBe(401);
      expect((await f.db.get('writer').select().from(legacyOrderImportRows))[0]?.state).toBe(
        'IMPORTED',
      );
    } finally {
      await app.close();
    }
  }, 15000);
  it('the production worker entry point actually reconciles retained proof with creation disabled and no HTTP transports', async () => {
    const { command } = await lostJob();
    await expireLease();
    const before = await financialEffects(),
      env: NodeJS.ProcessEnv = {
        NODE_ENV: 'test',
        TZ: 'UTC',
        SESSION_SECRET: runtimeImportSecret,
        MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
        MYSQL_WRITER_URL: f.config.MYSQL_WRITER_URL,
        MYSQL_PRIMARY_READER_URL: f.config.MYSQL_PRIMARY_READER_URL,
        LEGACY_ORDER_IMPORT_ENCRYPTION_KEY_V1: runtimeImportSecret,
        LEGACY_ORDER_IMPORT_WORKER_ENABLED: 'true',
        LEGACY_ORDER_IMPORT_WORKER_INTERVAL_MS: '1000',
        LEGACY_ORDER_IMPORT_WORKER_BATCH_SIZE: '1',
      };
    for (const name of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'COMSPEC'])
      if (process.env[name]) env[name] = process.env[name];
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--import',
        './tests/legacy-order-imports/forbid-financial-network.ts',
        'src/modules/legacy-order-imports/worker-main.ts',
      ],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '',
      errors = '';
    child.stdout.setEncoding('utf8').on('data', (data: string) => {
      output += data;
    });
    child.stderr.setEncoding('utf8').on('data', (data: string) => {
      errors += data;
    });
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    try {
      let imported = false;
      const deadline = Date.now() + 10000;
      while (!imported && Date.now() < deadline && child.exitCode === null) {
        const [row] = await f.db
          .get('writer')
          .select()
          .from(legacyOrderImportRows)
          .where(eq(legacyOrderImportRows.jobId, command.id));
        imported = row?.state === 'IMPORTED';
        if (!imported) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(imported).toBe(true);
      child.kill('SIGTERM');
      expect(await closed).toBe(0);
      expect(errors).toBe('');
      expect(output).toContain('administration.historical-order-import-worker.started');
      expect(output).toContain('administration.historical-order-import.imported');
      expect(output).not.toMatch(
        /private-import|changed@example|Private fixture|password|payload|stack/,
      );
      expect(await financialEffects()).toEqual(before);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await closed;
    }
  }, 15000);
  it('does not start any unstarted financial stage or PENDING row when a recovery read finds no native operation', async () => {
    const repository = legacyOrderImportRepository(f.db, { secret: runtimeImportSecret }),
      command = runtimeImportInput();
    await repository.stage('1', 'missing-financial-runtime-fixture', command);
    const pending = runtimeImportInput();
    await repository.stage('1', 'pending-runtime-fixture', pending);
    await f.db
      .get('writer')
      .update(legacyOrderImportRows)
      .set({ state: 'STARTING' })
      .where(eq(legacyOrderImportRows.jobId, command.id));
    const service = legacyOrderImportService(f.config, f.db, recoveryRegistration()),
      before = await financialEffects(),
      network = vi.spyOn(globalThis, 'fetch');
    expect(await service.runOne()).toMatchObject({ state: 'RECONCILING', jobId: command.id });
    expect(
      (await f.db.get('writer').select().from(legacyOrderImportRows)).find(
        (row) => row.jobId === pending.id,
      )?.state,
    ).toBe('PENDING');
    expect(await f.db.get('writer').select().from(financialImportProofs)).toEqual([]);
    expect(await financialEffects()).toEqual(before);
    expect(network).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'validates actual staged membership and explicit free manifest (free=%s)',
    async (free) => {
      const e = await prepare('offline', free),
        before = structuredClone(e.plan);
      expect(await execute(e, 'staged')).toEqual(
        new Map(
          free
            ? [
                ['11', 1],
                ['12', 1],
              ]
            : [['10', 1]],
        ),
      );
      expect(e.plan).toEqual(before);
      await expect(execute(e, 'settled')).rejects.toMatchObject({
        code: 'ORDER_IMPORT_MEMBERSHIP_PROOF_INVALID',
      });
      await activate(e);
      expect(await execute(e, 'settled')).toEqual(
        new Map(
          free
            ? [
                ['11', 1],
                ['12', 1],
              ]
            : [['10', 1]],
        ),
      );
      await expect(execute(e, 'staged')).rejects.toMatchObject({
        code: 'ORDER_IMPORT_MEMBERSHIP_PROOF_INVALID',
      });
    },
  );
  it('keeps Shopify STAGED and preserves the original stock plan.lines after an explicit free addition', async () => {
    const e = await prepare('shopify', true),
      before = structuredClone(e.plan.lines);
    expect(await execute(e, 'settled')).toEqual(
      new Map([
        ['11', 1],
        ['12', 1],
      ]),
    );
    expect(e.plan.lines).toEqual(before);
    const profile = csvMembershipImportProfile(adapterOptions);
    const frozen = await f.db.get('writer').transaction(async (tx) => {
      await profile.lock!(tx, e);
      return profile.completionSnapshot(tx, e, e.order);
    });
    expect(frozen).toEqual(e.snapshot);
    await activate(e);
    await expect(execute(e, 'settled')).rejects.toThrow();
  });
  it.each(['offline', 'shopify'] as const)(
    'validates native %s HP/provenance for an authenticated paid-to-free replacement',
    async (kind) => {
      const e = await prepare(kind, true, undefined, adapterOptions, true),
        original = structuredClone(e.plan),
        expected = new Map([
          ['11', 1],
          ['12', 1],
        ]);
      expect(await execute(e, 'staged')).toEqual(expected);
      if (kind === 'offline') await activate(e);
      expect(await execute(e, 'settled')).toEqual(expected);
      expect(e.plan).toEqual(original);
      const profile = csvMembershipImportProfile(adapterOptions),
        snapshot = await f.db.get('writer').transaction(async (tx) => {
          await profile.lock!(tx, e);
          return profile.completionSnapshot(tx, e, e.order);
        });
      expect(snapshot?.receipt.replacement?.originalLine).toEqual(original.lines[0]);
      expect(snapshot?.receipt.memberLines[0]?.productId).toBe('12');
    },
  );
  it.each(['offline', 'shopify'] as const)(
    'native Python/Node SQL agree on replaced %s HP while retaining original tender guard',
    async (kind) => {
      const e = await prepare(kind, true, undefined, adapterOptions, true),
        before = await financialEffects();
      expect(nativeReplacement(e, [])).toEqual({ code: 'ORDER_IMPORT_NATIVE_LINES_MISMATCH' });
      expect(nativeReplacement(e, [e.plan.lines[0]!])).toEqual(
        kind === 'offline'
          ? { code: 'ORDER_IMPORT_ORIGINAL_TENDER_MISMATCH' }
          : { lines: e.order.lines, lineHash: e.order.lineHash, payable: '2300.00' },
      );
      expect(nativeReplacement(e, [{ ...e.plan.lines[0]!, unitPrice: '99.99' }])).toEqual({
        code: 'ORDER_IMPORT_MEMBERSHIP_LINE_REVIEW',
      });
      expect(await financialEffects()).toEqual(before);
    },
  );
  it('completes Shopify with replaced HP, original stock scope and immutable recovery', async () => {
    const c = await core('shopify', true, true, undefined, true),
      original = structuredClone(c.input.plan),
      result = await c.adapter.start(c.input);
    expect(result.status).toBe('completed');
    const proof = await f.db
      .get('writer')
      .transaction((tx) => verifiedImportCompletion(tx, c.input.operationId, c.options.secret));
    expect(proof?.membership?.receipt.replacement?.originalLine).toEqual(original.lines[0]);
    const [stock] = await f.connection.query(
      'SELECT CAST(product_id AS CHAR) AS product,stock FROM product_store ORDER BY product_id',
    );
    expect(stock).toEqual([
      { product: '10', stock: 99 },
      { product: '11', stock: 99 },
      { product: '12', stock: 100 },
      { product: '9007199254740993', stock: 100 },
    ]);
    const effects = await financialEffects();
    c.disable();
    expect(await c.adapter.start(c.input)).toEqual(result);
    expect(c.input.plan).toEqual(original);
    expect(await financialEffects()).toEqual(effects);
    expect(c.transport.order).toHaveBeenCalledTimes(1);
    expect(c.transport.confirm).not.toHaveBeenCalled();
    expect(c.transport.publication).toHaveBeenCalledTimes(1);
  });
  it('requires the early exact customer lock witness before invoking native Order/provenance checks', async () => {
    const e = await prepare(),
      profile = csvMembershipImportProfile(adapterOptions);
    await expect(
      f.db.get('writer').transaction((tx) => profile.expectedQuantities!(tx, e, e.order, 'staged')),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_MEMBERSHIP_LOCK_REQUIRED' });
    await f.connection.beginTransaction();
    await f.connection.query('SELECT id FROM orders WHERE id=5001 FOR UPDATE');
    try {
      // Early lock must complete while a foreign transaction holds Order.
      await f.db.get('writer').transaction((tx) => profile.lock!(tx, e));
    } finally {
      await f.connection.rollback();
    }
    expect(await execute(e, 'staged')).toEqual(new Map([['10', 1]]));
  }, 10000);
  it('waits for the customer before locking Order when a concurrent writer owns that customer', async () => {
    const e = await prepare(),
      profile = csvMembershipImportProfile(adapterOptions);
    await f.connection.beginTransaction();
    await f.connection.query('SELECT id FROM users WHERE id=77 FOR UPDATE');
    const work = f.db.get('writer').transaction(async (tx) => {
      await profile.lock!(tx, e);
      return profile.expectedQuantities!(tx, e, e.order, 'staged');
    });
    void work.catch(() => undefined);
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const [rows] = await f.connection.query(
          "SELECT COUNT(*) AS n FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID WHERE l.OBJECT_SCHEMA=? AND l.OBJECT_NAME='users'",
          [new URL(f.config.MYSQL_WRITER_URL!).pathname.slice(1)],
        );
        waiting =
          BigInt(z.array(z.object({ n: z.union([z.string(), z.number()]) })).parse(rows)[0]!.n) >
          0n;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      // This would fail if the checker had taken Order before waiting on us.
      await expect(
        f.connection.query('SELECT id FROM orders WHERE id=5001 FOR UPDATE NOWAIT'),
      ).resolves.toBeDefined();
    } finally {
      await f.connection.rollback();
      expect(await work).toEqual(new Map([['10', 1]]));
    }
  }, 10000);
  it('rejects altered free-line value and a changed-then-restored membership revision before effects', async () => {
    const e = await prepare('offline', true);
    await f.connection.query('UPDATE has_products SET price=1 WHERE prod_id=12');
    await expect(execute(e, 'staged')).rejects.toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_PROOF_INVALID',
    });
    await f.connection.query('UPDATE has_products SET price=0 WHERE prod_id=12');
    await f.connection.query(
      "UPDATE user_eav SET value='changed' WHERE attribute='EXCLUSIVE_MEMBER'",
    );
    await f.connection.query("UPDATE user_eav SET value='1' WHERE attribute='EXCLUSIVE_MEMBER'");
    await expect(execute(e, 'staged')).rejects.toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_PROOF_INVALID',
    });
  });
  it.each([
    'disabled',
    'malformed',
    'oversized',
    'wrong-id',
    'request-hash',
    'disabled-malformed',
    'disabled-oversized',
  ] as const)(
    'refuses existing %s descriptor instead of treating it as a nonmember',
    async (changed) => {
      const e = await prepare(),
        profile = csvMembershipImportProfile({
          ...adapterOptions,
          ...(changed.startsWith('disabled')
            ? { contract: '', productIds: [], freeProductId: '' }
            : {}),
        });
      if (changed.endsWith('malformed') || changed.endsWith('oversized'))
        await f.connection.query(
          "UPDATE pos_rewrite_import_financial_source_receipts SET proof=? WHERE kind='membership'",
          [
            JSON.stringify({
              invalid: changed.endsWith('oversized') ? 'x'.repeat(262145) : 'invalid',
            }),
          ],
        );
      if (changed === 'wrong-id')
        await f.connection.query(
          "UPDATE pos_rewrite_import_financial_source_receipts SET id=CONCAT(id,'-bad')",
        );
      if (changed === 'request-hash')
        await f.connection.query(
          "UPDATE pos_rewrite_import_financial_source_receipts SET request_hash=REPEAT('f',64)",
        );
      await expect(
        f.db.get('writer').transaction((tx) => profile.lock!(tx, e)),
      ).rejects.toMatchObject({ code: 'ORDER_IMPORT_MEMBERSHIP_PROOF_INVALID' });
    },
  );
  it('does not hide a descriptor committed after an earlier RR snapshot when contracts are disabled', async () => {
    const e = await prepare(),
      profile = csvMembershipImportProfile({
        ...adapterOptions,
        contract: '',
        productIds: [],
        freeProductId: '',
      });
    await f.connection.query(
      "DELETE FROM pos_rewrite_import_financial_source_receipts WHERE kind='membership'",
    );
    await f.db.get('writer').transaction(async (tx) => {
      await tx.select().from(financialImportSourceReceipts);
      await f.db
        .get('writer')
        .insert(financialImportSourceReceipts)
        .values({
          id: e.state.scope.operationId + ':membership',
          operationId: e.state.scope.operationId,
          kind: 'membership',
          requestHash: e.state.requestHash,
          status: 'completed',
          proof: {},
          proofHash: '0'.repeat(64),
          createdAt: e.state.createdAt,
        });
      await expect(profile.lock!(tx, e)).rejects.toMatchObject({
        code: 'ORDER_IMPORT_MEMBERSHIP_PROOF_INVALID',
      });
    });
  });
  it('preserves completed evidence after current contact, entitlement, key and flag changes', async () => {
    const e = await prepare();
    await activate(e);
    const profile = csvMembershipImportProfile(adapterOptions),
      frozen = await f.db.get('writer').transaction(async (tx) => {
        await profile.lock!(tx, e);
        return profile.completionSnapshot(tx, e, e.order);
      });
    expect(frozen).toEqual(e.snapshot);
    await f.connection.query(
      "UPDATE users SET email='changed@example.test',is_block=1 WHERE id=77",
    );
    await f.connection.query("UPDATE user_eav SET value='changed',is_active=0");
    await f.connection.query(
      "UPDATE pos_rewrite_import_financial_source_receipts SET proof='{}',proof_hash=REPEAT('0',64)",
    );
    const disabled = csvMembershipImportProfile({
        ...adapterOptions,
        contract: '',
        sourceProofKey: '',
        membershipProofKey: '',
        productIds: [],
        freeProductId: '',
      }),
      completed = { ...e.state, kind: e.plan.kind, order: e.order };
    await f.db
      .get('writer')
      .transaction((tx) =>
        disabled.lock!(tx, { ...e, state: { ...e.state, status: 'completed' } }),
      );
    expect(validateCsvMembershipCompletionSnapshot(frozen, completed)).toEqual(e.snapshot);
    await expect(execute(e, 'settled')).rejects.toThrow();
  });
  it('does not permit an unrelated transaction or changed scope to reuse the early lock witness', async () => {
    const e = await prepare(),
      profile = csvMembershipImportProfile(adapterOptions);
    await f.db.get('writer').transaction((tx) => profile.lock!(tx, e));
    await expect(
      f.db.get('writer').transaction((tx) => profile.expectedQuantities!(tx, e, e.order, 'staged')),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_MEMBERSHIP_LOCK_REQUIRED' });
    await f.db.get('writer').transaction(async (tx) => {
      await profile.lock!(tx, e);
      await expect(
        profile.expectedQuantities!(
          tx,
          { ...e, state: { ...e.state, scope: { ...e.state.scope, counterId: '3' } } },
          e.order,
          'staged',
        ),
      ).rejects.toThrow();
    });
  });
  it('rolls back the caller transaction after a late profile failure and does not renew or alter the source descriptor', async () => {
    const e = await prepare(),
      profile = csvMembershipImportProfile(adapterOptions),
      marker = new Error('isolated adapter rollback');
    await expect(
      f.db.get('writer').transaction(async (tx) => {
        await profile.lock!(tx, e);
        await profile.expectedQuantities!(tx, e, e.order, 'staged');
        await tx
          .update(financialImportSourceReceipts)
          .set({ status: 'invalid' })
          .where(
            and(
              eq(financialImportSourceReceipts.operationId, e.state.scope.operationId),
              eq(financialImportSourceReceipts.kind, 'membership'),
            ),
          );
        throw marker;
      }),
    ).rejects.toBe(marker);
    expect(await execute(e, 'staged')).toEqual(new Map([['10', 1]]));
  });
  it('leaves ordinary plans available with optional contracts absent and never fabricates a member snapshot', async () => {
    const e = memberEvidence(),
      profile = csvMembershipImportProfile({
        ...adapterOptions,
        contract: '',
        sourceProofKey: '',
        membershipProofKey: '',
      });
    e.plan.lines[0]!.productId = '11';
    e.order.lines[0]!.productId = '11';
    profile.assertReady!(e.plan);
    await f.db.get('writer').transaction(async (tx) => {
      await profile.lock!(tx, e);
      expect(await profile.expectedQuantities!(tx, e, e.order, 'staged')).toBeNull();
      expect(await profile.completionSnapshot(tx, e, e.order)).toBeNull();
    });
  });
  it.each([
    ['offline', false],
    ['shopify', false],
    ['shopify', true],
  ] as const)(
    'seals full native membership in actual %s financial completion (free=%s)',
    async (kind, free) => {
      const c = await core(kind, free),
        plan = structuredClone(c.input.plan);
      const result = await c.adapter.start(c.input);
      expect(result.status).toBe('completed');
      expect(c.input.plan).toEqual(plan);
      const proof = await f.db
        .get('writer')
        .transaction((tx) => verifiedImportCompletion(tx, c.input.operationId, c.options.secret));
      expect(proof?.membership).toEqual(c.evidence().snapshot);
      expect(proof?.publication.jobs.filter((job) => job.kind === 'membership-cache')).toHaveLength(
        1,
      );
      expect(await c.adapter.start(c.input)).toEqual(result);
      expect(c.transport.order).toHaveBeenCalledTimes(1);
      expect(c.transport.publication).toHaveBeenCalledTimes(1);
      expect(c.transport.confirm).toHaveBeenCalledTimes(kind === 'offline' ? 1 : 0);
      if (free) {
        const [stock] = await f.connection.query(
          'SELECT CAST(product_id AS CHAR) AS product,stock FROM product_store WHERE product_id IN (11,12) ORDER BY product_id',
        );
        expect(stock).toEqual([
          { product: '11', stock: 99 },
          { product: '12', stock: 100 },
        ]);
      }
    },
    15000,
  );
  it('default composition refuses a planned member descriptor even when its HP quantity matches the original plan', async () => {
    const c = await core('shopify', false, false);
    await expect(c.adapter.start(c.input)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_PROOF_INVALID',
    });
    expect(c.transport.order).toHaveBeenCalledTimes(1);
    expect(c.transport.confirm).not.toHaveBeenCalled();
    expect(c.transport.publication).not.toHaveBeenCalled();
    expect(await f.db.get('writer').select().from(financialImportProofs)).toEqual([]);
    await expect(c.adapter.start(c.input)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_PROOF_INVALID',
    });
    expect(c.transport.order).toHaveBeenCalledTimes(1);
  });
  it('retains completed proof after an actual final commit succeeds but its acknowledgment is lost', async () => {
    const c = await core('shopify', true),
      writer = f.db.get('writer'),
      native = writer.transaction.bind(writer);
    let lost = false;
    const intercept = async <T>(
      work: (tx: AdministrationTransaction) => Promise<T>,
      options?: Parameters<typeof writer.transaction>[1],
    ): Promise<T> => {
      const result = await native(work, options);
      const [rows] = await f.connection.query(
        'SELECT COUNT(*) AS n FROM pos_rewrite_import_financial_proofs',
      );
      const count = BigInt(
        z.array(z.object({ n: z.union([z.string(), z.number()]) })).parse(rows)[0]!.n,
      );
      if (!lost && count > 0n) {
        lost = true;
        // Native commit is already visible. No new signature/current entitlement
        // can be required to recover that original completed financial receipt.
        c.disable();
        await f.connection.query(
          "UPDATE users SET email='changed@example.test',is_block=1 WHERE id=77",
        );
        await f.connection.query("UPDATE user_eav SET value='changed',is_active=0");
        await f.connection.query(
          "UPDATE pos_rewrite_import_financial_source_receipts SET proof='{}',proof_hash=REPEAT('0',64) WHERE kind='membership'",
        );
        throw new Error('isolated lost final commit acknowledgment');
      }
      return result;
    };
    const spy = vi.spyOn(writer, 'transaction').mockImplementation(intercept);
    // Databases.get creates a new Drizzle facade. Pin only this adapter's
    // writer facade so the post-native-COMMIT failure reaches the real journal.
    const tracked = {
        ...f.db,
        get: (name: Parameters<typeof f.db.get>[0]) =>
          name === 'writer' ? writer : f.db.get(name),
      },
      adapter = legacyOrderImportFinancialAdapter(
        f.config,
        tracked,
        c.options,
        c.transport,
        c.profile,
      );
    try {
      const result = await adapter.start(c.input);
      expect(lost).toBe(true);
      expect(result.status).toBe('completed');
      expect(await adapter.start(c.input)).toEqual(result);
      const reader = legacyOrderImportFinancialAdapter(
        f.config,
        tracked,
        { ...c.options, sourceProofKey: '' },
        c.transport,
        configuredFinancialImportProfiles(
          { sourceProofKey: '' },
          {
            POS_LEGACY_IMPORT_MEMBERSHIP_CONTRACT: adapterOptions.contract,
            POS_MEMBERSHIP_FRESH_READER_CONTRACT: adapterOptions.freshReaderContract,
            POS_MEMBERSHIP_NATIVE_REVISION_CONTRACT: 'pos-membership-native-revision-v1',
            POS_MEMBERSHIP_PROOF_KEY: adapterOptions.membershipProofKey,
            POS_MEMBERSHIP_PRODUCT_IDS: JSON.stringify(adapterOptions.productIds),
            EXCLUSIVE_QUARTERLY_ID_FREE: adapterOptions.freeProductId,
          },
        ),
      );
      // Simulate a journal written by the previous unconditional uncertain path.
      await f.connection.query(
        "UPDATE pos_rewrite_import_financial_operations SET state=JSON_SET(state,'$.status','unknown')",
      );
      expect(await reader.read(c.input)).toEqual(result);
      const [status] = await f.connection.query(
        "SELECT JSON_UNQUOTE(JSON_EXTRACT(state,'$.status')) AS status FROM pos_rewrite_import_financial_operations",
      );
      expect(status).toEqual([{ status: 'completed' }]);
      expect(c.transport.order).toHaveBeenCalledTimes(1);
      expect(c.transport.publication).toHaveBeenCalledTimes(1);
      expect(c.transport.confirm).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  }, 15000);
  it.each([0, 2])(
    'does not seal membership when source cache queue acknowledgment count is %s',
    async (count) => {
      const c = await core('shopify');
      c.cacheJobs(count);
      await expect(c.adapter.start(c.input)).rejects.toMatchObject({
        code: 'ORDER_IMPORT_MEMBERSHIP_PROOF_INVALID',
      });
      expect(await f.db.get('writer').select().from(financialImportProofs)).toEqual([]);
      expect(c.transport.order).toHaveBeenCalledTimes(1);
      expect(c.transport.publication).toHaveBeenCalledTimes(1);
    },
  );
  it('keeps unfinished imports behind current gates even if the journal flag is altered', async () => {
    const c = await core(),
      j = legacyImportFinancialJournal(f.config, f.db, c.options, c.profile);
    await j.reserve(c.input);
    await c.transport.order(await j.dispatch(c.input, 'order'));
    const reader = legacyOrderImportFinancialAdapter(
      f.config,
      f.db,
      { ...c.options, sourceProofKey: '' },
      c.transport,
    );
    await f.connection.query(
      "UPDATE pos_rewrite_import_financial_operations SET state=JSON_SET(state,'$.status','unknown')",
    );
    await expect(reader.read(c.input)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_PROOF_INVALID',
    });
    await f.connection.query(
      "UPDATE pos_rewrite_import_financial_operations SET state=JSON_SET(state,'$.status','completed')",
    );
    await expect(reader.read(c.input)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_RECEIPT_INVALID',
    });
    expect(c.transport.order).toHaveBeenCalledTimes(1);
    expect(c.transport.confirm).not.toHaveBeenCalled();
    expect(c.transport.publication).not.toHaveBeenCalled();
    expect(await f.db.get('writer').select().from(financialImportProofs)).toEqual([]);
  });
  it('authenticates frozen membership before structural validation and rejects unqualified legacy omission', async () => {
    const c = await core();
    expect((await c.adapter.start(c.input)).status).toBe('completed');
    const [stored] = await f.db.get('writer').select().from(financialImportProofs);
    if (!stored?.data.membership) throw new Error('isolated membership snapshot missing');
    const changed = structuredClone(stored.data);
    changed.membership!.receipt.customerId = '88';
    await f.db.get('writer').update(financialImportProofs).set({ data: changed });
    await expect(c.adapter.read(c.input)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_RECEIPT_INVALID',
    });
    await f.db
      .get('writer')
      .update(financialImportProofs)
      .set({ proofHash: financialImportHash(c.options.secret, 'completed', changed) });
    await expect(c.adapter.read(c.input)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_PROOF_INVALID',
    });
    const { membership: _member, ...legacy } = stored.data;
    await f.db
      .get('writer')
      .update(financialImportProofs)
      .set({ data: legacy, proofHash: financialImportHash(c.options.secret, 'completed', legacy) });
    await expect(c.adapter.read(c.input)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_PROOF_INVALID',
    });
    expect(c.transport.order).toHaveBeenCalledTimes(1);
  });
  it('does not filter away an oversized stored completion as though no financial proof exists', async () => {
    const c = await core();
    expect((await c.adapter.start(c.input)).status).toBe('completed');
    await f.connection.query('UPDATE pos_rewrite_import_financial_proofs SET data=?', [
      JSON.stringify({ invalid: 'x'.repeat(1000001) }),
    ]);
    await expect(c.adapter.read(c.input)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_RECEIPT_INVALID',
    });
    expect(c.transport.order).toHaveBeenCalledTimes(1);
    expect(c.transport.publication).toHaveBeenCalledTimes(1);
  });
  it('takes the customer before Order during immutable unknown-state recovery with contracts disabled', async () => {
    const c = await core(),
      result = await c.adapter.start(c.input);
    expect(result.status).toBe('completed');
    c.disable();
    await f.connection.query(
      "UPDATE pos_rewrite_import_financial_operations SET state=JSON_SET(state,'$.status','unknown')",
    );
    const reader = legacyOrderImportFinancialAdapter(f.config, f.db, c.options, c.transport);
    await f.connection.beginTransaction();
    await f.connection.query('SELECT id FROM users WHERE id=77 FOR UPDATE');
    const work = reader.read(c.input);
    void work.catch(() => undefined);
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const [rows] = await f.connection.query(
          "SELECT COUNT(*) AS n FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID WHERE l.OBJECT_SCHEMA=? AND l.OBJECT_NAME='users'",
          [new URL(f.config.MYSQL_WRITER_URL!).pathname.slice(1)],
        );
        waiting =
          BigInt(z.array(z.object({ n: z.union([z.string(), z.number()]) })).parse(rows)[0]!.n) >
          0n;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await expect(
        f.connection.query('SELECT id FROM orders WHERE id=5001 FOR UPDATE NOWAIT'),
      ).resolves.toBeDefined();
    } finally {
      await f.connection.rollback();
      expect(await work).toEqual(result);
    }
  }, 10000);
  it('refuses new unconfigured dispatch before inserting an operation', async () => {
    const c = await core();
    c.disable();
    await expect(c.adapter.start(c.input)).rejects.toThrow('isolated disabled source');
    const [rows] = await f.connection.query(
      'SELECT (SELECT COUNT(*) FROM pos_rewrite_import_financial_operations) AS operations,(SELECT COUNT(*) FROM orders) AS orders_count',
    );
    expect(rows).toEqual([{ operations: '0', orders_count: '0' }]);
    expect(c.transport.order).not.toHaveBeenCalled();
  });
});
