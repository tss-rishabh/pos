import {
  globalOnlineInvoiceContract,
  globalOnlineInvoiceCapability,
  issueGlobalOnlineInvoiceProof,
  globalOnlineInvoiceResponseProof,
  assertGlobalOnlineInvoiceResponse,
} from '../../src/modules/invoice-documents/global-proof.js';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { z } from 'zod';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import {
  invoiceResponseProof,
  assertInvoiceResponseProof,
  invoiceSecurityContract,
  feedbackProofContract,
  type InvoiceProofScope,
} from '../../src/modules/checkout/invoice-security.js';
import { registerInvoiceDocuments } from '../../src/modules/invoice-documents/index.js';
import { scopedInvoiceService } from '../../src/modules/invoice-documents/scoped-service.js';
import { invoiceCapabilities } from '../../src/modules/invoice-documents/capabilities.js';
import {
  scopedInvoiceContract,
  scopedInvoiceResponseProof,
  selectedInvoiceHash,
  issueScopedInvoiceProof,
  assertScopedInvoiceResponse,
} from '../../src/modules/invoice-documents/scope-proof.js';
import { onlineInvoiceService } from '../../src/modules/invoice-documents/service.js';
import {
  invoiceHistoryContract,
  invoiceHistoryResponseProof,
  issueInvoiceHistoryProof,
  assertInvoiceHistoryResponse,
} from '../../src/modules/invoice-documents/history-proof.js';
import type { InvoiceHistoryReader } from '../../src/modules/invoice-documents/history.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';
import {
  invoiceDocumentAuthority,
  invoiceScopeSnapshot,
} from '../../src/modules/invoice-documents/authority.js';

describe.skipIf(!process.env.MYSQL_INTEGRATION_URL)(
  'native online invoice authority/transport',
  () => {
    let connection: mysql.Connection,
      db: Databases,
      fixture: ReturnType<typeof verifiedMysqlFixture>,
      config: ReturnType<typeof readConfig>,
      schema = '';
    const orderId = '9007199254740993',
      lineId = '9007199254740994',
      scope = { storeId: '1', orderId },
      key = 'private-online-invoice-fixture-key-'.repeat(3),
      user: Principal = {
        id: '7',
        role: 4,
        userType: 1,
        storeIds: ['1'],
        name: 'Fixture operator',
        email: 'fixture@example.test',
      },
      options = {
        onlineUrl: 'http://127.0.0.1/internal/pos/invoices/online',
        serviceKey: key,
        securityContract: invoiceSecurityContract,
        feedbackContract: feedbackProofContract,
        historyContract: invoiceHistoryContract,
        scopedContract: scopedInvoiceContract,
        sameDayUrl: 'http://127.0.0.1/internal/pos/invoices/same-day',
        expressUrl: 'http://127.0.0.1/internal/pos/invoices/express',
      };
    const history: InvoiceHistoryReader = async () => ({
      count: '2',
      evidence: {
        generationId: '123e4567-e89b-42d3-a456-426614174000',
        sourceSnapshotId: 'controlled-source-snapshot-1',
        sourceSnapshotAt: new Date(Date.now() - 1000).toISOString(),
        sourceCdcWatermark: new Date(Date.now() - 500).toISOString(),
        publishedAt: new Date(Date.now() - 100).toISOString(),
        customerSourceRows: '3',
        customerOrdersHash: 'a'.repeat(64),
      },
    });
    const invoice = (fetcher: typeof fetch, settings = options) =>
      onlineInvoiceService(db, config, settings, fetcher, history);
    const html =
      '<!doctype html><html><body><h1>Tax invoice</h1><table><tr><td>HSN</td><td>GSTIN FIXTURE</td><td>CGST 2.50</td></tr></table><img src="data:image/png;base64,aA=="><script>BAD_SCRIPT</script></body></html>';
    function renderer(mutate?: () => Promise<void>, tamper = false, expectedOrderId = orderId) {
      return vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(String(input)),
          headers = new Headers(init?.headers);
        expect([...url.searchParams]).toEqual([['order_id', expectedOrderId]]);
        expect(url.pathname).toBe('/internal/pos/invoices/online');
        expect(headers.get('X-POS-Invoice-Key')).toBe(key);
        expect(init?.redirect).toBe('error');
        const historyProof = headers.get('X-POS-Invoice-History')!;
        expect(historyProof).toMatch(/^pos-online-invoice-history-v1\./);
        const proofScope: InvoiceProofScope = {
          kind: 'online',
          orderId: expectedOrderId,
          operatorId: headers.get('X-POS-Operator-ID')!,
          requestId: headers.get('X-Request-ID')!,
          nonce: headers.get('X-POS-Invoice-Nonce')!,
        };
        if (mutate) await mutate();
        return new Response(tamper ? html + 'changed' : html, {
          headers: {
            'Content-Type': 'text/html',
            'X-POS-Invoice-Contract': invoiceSecurityContract,
            'X-POS-Feedback-Contract': feedbackProofContract,
            'X-POS-Invoice-Nonce': proofScope.nonce,
            'X-POS-Invoice-Proof': invoiceResponseProof(proofScope, html, key),
            'X-POS-Invoice-History-Contract': invoiceHistoryContract,
            'X-POS-Invoice-History-Proof': invoiceHistoryResponseProof(historyProof, html, key),
          },
        });
      });
    }
    function scopedRenderer(
      kind: 'same-day' | 'express',
      mutate?: () => Promise<void>,
      tamper = false,
    ) {
      return vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(String(input)),
          headers = new Headers(init?.headers),
          capability = headers.get('X-POS-Invoice-Scope')!;
        expect(url.pathname).toBe('/internal/pos/invoices/' + kind);
        expect([...url.searchParams]).toEqual(
          kind === 'same-day'
            ? [
                ['order_id', scope.orderId],
                ['is_sdd_shipment', '0'],
              ]
            : [['order_id', '12345']],
        );
        expect(url.searchParams.has('pos_token')).toBe(false);
        expect(init?.redirect).toBe('error');
        expect(headers.get('X-POS-Invoice-Key')).toBe(key);
        const payload = JSON.parse(
          Buffer.from(capability.split('.')[1]!, 'base64url').toString('utf8'),
        ) as Record<string, unknown>;
        expect(payload).toMatchObject({
          storeId: '1',
          operatorId: user.id,
          kind,
          selection:
            kind === 'express' ? 'store-express-line-items-v1' : 'source-is-sdd-shipment-0',
        });
        if (kind === 'express')
          expect(payload).toMatchObject({
            selectedHash: selectedInvoiceHash(['77']),
            selectedCount: 1,
          });
        if (mutate) await mutate();
        const proofScope: InvoiceProofScope = {
          kind: kind === 'express' ? 'store' : 'same-day',
          orderId: url.searchParams.get('order_id')!,
          operatorId: user.id,
          requestId: headers.get('X-Request-ID')!,
          nonce: headers.get('X-POS-Invoice-Nonce')!,
        };
        return new Response(html, {
          headers: {
            'Content-Type': 'text/html',
            'X-POS-Invoice-Contract': invoiceSecurityContract,
            'X-POS-Feedback-Contract': feedbackProofContract,
            'X-POS-Invoice-Nonce': proofScope.nonce,
            'X-POS-Invoice-Proof': invoiceResponseProof(proofScope, html, key),
            'X-POS-Invoice-Scope-Contract': scopedInvoiceContract,
            'X-POS-Invoice-Scope-Proof': scopedInvoiceResponseProof(
              tamper ? capability + 'wrong' : capability,
              html,
              key,
            ),
          },
        });
      });
    }
    async function expressFixture() {
      await connection.query('DELETE FROM order_stores');
      await connection.query('UPDATE orders SET id=12345,is_split_order=1 WHERE id=?', [orderId]);
      await connection.query(
        'UPDATE has_products SET id=77,order_id=12345,order_platform_id=5 WHERE id=?',
        [lineId],
      );
      await fixture.insert('has_products', {
        id: 78,
        order_id: 12345,
        prod_id: 66,
        qty: 3,
        price: 500,
        order_platform_id: 5,
      });
      await fixture.insert('express_line_item', {
        order_id: 12345,
        has_product_id: 77,
        store_id: 1,
      });
      await fixture.insert('express_line_item', {
        order_id: 12345,
        has_product_id: 78,
        store_id: 2,
      });
      return { storeId: '1', orderId: '12345' };
    }
    beforeAll(async () => {
      const url = new URL(process.env.MYSQL_INTEGRATION_URL!);
      if (
        url.protocol !== 'mysql:' ||
        !['127.0.0.1', 'localhost'].includes(url.hostname) ||
        url.pathname !== '/pos_rewrite_integration' ||
        url.search ||
        url.hash
      )
        throw new Error('GUARDED_LOCAL_INVOICE_DATABASE_REQUIRED');
      schema = 'pos_rewrite_invoice_test_' + randomUUID().replaceAll('-', '').slice(0, 12);
      connection = await mysql.createConnection({
        host: url.hostname,
        port: Number(url.port || 3306),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        supportBigNumbers: true,
        bigNumberStrings: true,
        dateStrings: true,
      });
      await connection.query('CREATE DATABASE ' + mysql.escapeId(schema));
      await connection.changeUser({ database: schema });
      fixture = verifiedMysqlFixture(connection, [
        'evidence/mysql-order-point-cashback-schema.json',
        'evidence/mysql-admin-shipping-schema.json',
      ]);
      await fixture.create([
        'pos_user',
        'stores',
        'user_stores',
        'orders',
        'order_stores',
        'order_addons',
        'has_products',
        'express_line_item',
        'gift_vouchers',
        'order_point_cashback',
        'has_addresses',
      ]);
      await connection.query(
        'CREATE TABLE pos_rewrite_operator_auth_epochs(operator_id VARCHAR(32) PRIMARY KEY,epoch BIGINT UNSIGNED NOT NULL DEFAULT 0)',
      );
      await connection.query(
        'CREATE TABLE invoice_read_guard(id BIGINT PRIMARY KEY,marker VARCHAR(32) NOT NULL)',
      );
      await connection.query("INSERT INTO invoice_read_guard VALUES(1,'read-only')");
      await fixture.insert('pos_user', {
        id: 7,
        role: 4,
        user_type: 1,
        is_active: 1,
        username: 'fixture-operator',
      });
      await fixture.insert('stores', { id: 1, is_active: 1, type: 'STORE', category: 'IN_HOUSE' });
      await fixture.insert('stores', { id: 2, is_active: 1, type: 'STORE', category: 'IN_HOUSE' });
      url.pathname = '/' + schema;
      config = readConfig({
        NODE_ENV: 'test',
        DEMO_MODE: 'false',
        SESSION_SECRET: 'native-online-invoice-'.repeat(4),
        MYSQL_WRITER_URL: url.href,
        MYSQL_PRIMARY_READER_URL: url.href,
        MYSQL_DATA_READER_URL: url.href,
        MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      });
      db = createDatabases(config);
    }, 30000);
    beforeEach(async () => {
      for (const table of [
        'order_addons',
        'pos_rewrite_operator_auth_epochs',
        'has_addresses',
        'order_point_cashback',
        'gift_vouchers',
        'express_line_item',
        'has_products',
        'order_stores',
        'orders',
        'user_stores',
      ])
        await connection.query('DELETE FROM ' + mysql.escapeId(table));
      await connection.query('UPDATE pos_user SET is_active=1,role=4,user_type=1');
      await connection.query('UPDATE stores SET is_active=1,category="IN_HOUSE"');
      await fixture.insert('user_stores', { django_user_id: 7, store_id: 1 });
      await fixture.insert('orders', {
        id: orderId,
        user_id: 777,
        payment_method: 14,
        payment_status: 4,
        order_status: 3,
        pay_amt: 100,
      });
      await fixture.insert('order_stores', {
        id: '9007199254740995',
        order_id: orderId,
        store_id: 1,
        counter_id: 3,
        order_invoice: 'FIXTURE/INV/1',
      });
      await fixture.insert('has_products', {
        id: lineId,
        order_id: orderId,
        prod_id: 66,
        qty: 2,
        price: 100,
        order_platform_id: 2,
      });
    });
    afterAll(async () => {
      if (db) await db.close();
      if (connection) {
        if (schema) await connection.query('DROP DATABASE IF EXISTS ' + mysql.escapeId(schema));
        await connection.end();
      }
    });
    const globalScope = { ...scope, access: 'global-online' as const };
    const globalOptions = {
      ...options,
      globalOnlineContract: globalOnlineInvoiceContract,
      historyPublicationContract: 'pos-invoice-orders-publication-v1',
      historyOrdersView: 'fixture-project.reports.orders',
      historyCustomersView: 'fixture-project.reports.customers',
      historyPublicationsView: 'fixture-project.reports.publications',
      historyMaxLagSeconds: 600,
    };
    async function genuineOnline() {
      await connection.query('DELETE FROM order_stores');
      await connection.query("UPDATE orders SET location_id=NULL,location_type='' WHERE id=?", [
        orderId,
      ]);
      await connection.query('UPDATE has_products SET order_platform_id=1 WHERE order_id=?', [
        orderId,
      ]);
    }
    function globalRenderer(
      kind: 'online' | 'same-day' = 'online',
      mutate?: () => Promise<void>,
      tamper = false,
    ) {
      return vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(String(input)),
          headers = new Headers(init?.headers),
          proof = headers.get('X-POS-Global-Invoice')!,
          historyProof = headers.get('X-POS-Invoice-History')!;
        const value = globalOnlineInvoiceCapability.parse(
          JSON.parse(Buffer.from(proof.split('.')[1]!, 'base64url').toString('utf8')) as unknown,
        );
        expect(value).toMatchObject({
          kind,
          orderId,
          customerId: '777',
          ownerStoreId: null,
          userType: 1,
          issuerPolicy: kind === 'online' ? 'pinned-online-renderer' : 'source-sdd-renderer',
          selection: kind === 'online' ? 'full-order' : 'source-is-sdd-shipment-0',
        });
        expect(value.contextStoreId).toMatch(/^[12]$/);
        expect([...url.searchParams]).toEqual(
          kind === 'online'
            ? [['order_id', orderId]]
            : [
                ['order_id', orderId],
                ['is_sdd_shipment', '0'],
              ],
        );
        const proofScope: InvoiceProofScope = {
          kind,
          orderId,
          operatorId: user.id,
          nonce: headers.get('X-POS-Invoice-Nonce')!,
          requestId: headers.get('X-Request-ID')!,
        };
        if (mutate) await mutate();
        return new Response(html, {
          headers: {
            'Content-Type': 'text/html',
            'X-POS-Invoice-Contract': invoiceSecurityContract,
            'X-POS-Feedback-Contract': feedbackProofContract,
            'X-POS-Invoice-Nonce': proofScope.nonce,
            'X-POS-Invoice-Proof': invoiceResponseProof(proofScope, html, key),
            'X-POS-Invoice-History-Contract': invoiceHistoryContract,
            'X-POS-Invoice-History-Proof': invoiceHistoryResponseProof(historyProof, html, key),
            'X-POS-Global-Invoice-Contract': globalOnlineInvoiceContract,
            'X-POS-Global-Invoice-Proof': globalOnlineInvoiceResponseProof(
              tamper ? proof + 'wrong' : proof,
              html,
              key,
            ),
            ...(kind === 'same-day'
              ? {
                  'X-POS-Invoice-Scope-Contract': scopedInvoiceContract,
                  'X-POS-Invoice-Scope-Proof': scopedInvoiceResponseProof(
                    headers.get('X-POS-Invoice-Scope')!,
                    html,
                    key,
                  ),
                }
              : {}),
          },
        });
      });
    }
    it('allows all five genuine internal global-reader roles only with explicit N access, never inventing ownership', async () => {
      await genuineOnline();
      for (const role of [1, 2, 3, 4, 5] as const) {
        await connection.query('UPDATE pos_user SET role=?', [role]);
        const actor = { ...user, role };
        await expect(invoiceDocumentAuthority(db)(actor, scope)).rejects.toMatchObject({
          code: 'INVOICE_SCOPE_UNCONFIRMED',
        });
        const fetcher = globalRenderer();
        const result = await onlineInvoiceService(
          db,
          config,
          globalOptions,
          fetcher,
          history,
        )(actor, globalScope);
        expect(result).toMatchObject({ access: 'global-online', orderId, number: null });
        expect(fetcher).toHaveBeenCalledTimes(1);
        const capabilities = await invoiceCapabilities(db, globalOptions)(actor, globalScope);
        expect(capabilities).toMatchObject({
          access: 'global-online',
          actions: [{ kind: 'online', available: true }],
        });
      }
      const [rows] = await connection.query<mysql.RowDataPacket[]>(
        'SELECT COUNT(*) AS total FROM order_stores',
      );
      expect(rows[0]!.total).toBe('0');
    });
    it('treats authorized context stores as context only and rejects franchise or unqualified provider contracts', async () => {
      await genuineOnline();
      await fixture.insert('user_stores', { django_user_id: 7, store_id: 2 });
      const actor = { ...user, storeIds: ['1', '2'] };
      const fetcher = globalRenderer();
      const service = onlineInvoiceService(db, config, globalOptions, fetcher, history);
      const first = await service(actor, globalScope),
        second = await service(actor, { ...globalScope, storeId: '2' });
      expect(first.html).toBe(second.html);
      expect(first.number).toBeNull();
      expect(second.number).toBeNull();
      const unavailable = globalRenderer();
      await expect(
        onlineInvoiceService(db, config, options, unavailable, history)(actor, globalScope),
      ).rejects.toMatchObject({ code: 'INVOICE_SECURITY_UNCONFIRMED' });
      expect(unavailable).not.toHaveBeenCalled();
      await connection.query('UPDATE stores SET category="FRANCHISE"');
      await connection.query('UPDATE pos_user SET role=1,user_type=2');
      await expect(service({ ...actor, role: 1, userType: 2 }, globalScope)).rejects.toMatchObject({
        code: 'INVOICE_SCOPE_UNCONFIRMED',
      });
    });
    for (const [name, statement] of [
      [
        'mapping',
        "INSERT INTO order_stores(id,order_id,store_id,counter_id,order_invoice) SELECT 1,id,1,3,'FIXTURE' FROM orders",
      ],
      ['location', 'UPDATE orders SET location_id=1'],
      ['inactive-actor', 'UPDATE pos_user SET is_active=0'],
      ['inactive-store', 'UPDATE stores SET is_active=0'],
      ['customer', 'UPDATE orders SET user_id=778'],
      ['line', 'UPDATE has_products SET qty=qty+1'],
      ['address', "UPDATE orders SET address1='changed-fixture'"],
      ['assignment', 'DELETE FROM user_stores'],
      ['type', 'UPDATE pos_user SET user_type=2'],
      ['role', 'UPDATE pos_user SET role=5'],
      [
        'authentication',
        "INSERT INTO pos_rewrite_operator_auth_epochs(operator_id,epoch) VALUES('7',1)",
      ],
    ] as const)
      it('withholds global HTML after current ' + name + ' changes during rendering', async () => {
        await genuineOnline();
        const fetcher = globalRenderer('online', async () => {
          await connection.query(statement);
        });
        await expect(
          onlineInvoiceService(db, config, globalOptions, fetcher, history)(user, globalScope),
        ).rejects.toBeDefined();
        expect(fetcher).toHaveBeenCalledTimes(1);
      });
    it('rejects a foreign customer address before any global renderer or historical read', async () => {
      await genuineOnline();
      await fixture.insert('has_addresses', { id: 55, user_id: 778 });
      await connection.query('UPDATE orders SET has_address_id=55');
      const fetcher = globalRenderer(),
        read = vi.fn(history);
      await expect(
        onlineInvoiceService(db, config, globalOptions, fetcher, read)(user, globalScope),
      ).rejects.toMatchObject({ code: 'INVOICE_SCOPE_UNCONFIRMED' });
      expect(fetcher).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    });
    it('refuses unavailable history before rendering and requires exact global HTML acknowledgement', async () => {
      await genuineOnline();
      const fetcher = globalRenderer();
      await expect(
        onlineInvoiceService(db, config, globalOptions, fetcher, async () => {
          throw new Error('Unqualified fixture history');
        })(user, globalScope),
      ).rejects.toThrow('Unqualified fixture history');
      expect(fetcher).not.toHaveBeenCalled();
      await expect(
        onlineInvoiceService(
          db,
          config,
          globalOptions,
          globalRenderer('online', undefined, true),
          history,
        )(user, globalScope),
      ).rejects.toMatchObject({ code: 'INVOICE_GLOBAL_PROOF_UNCONFIRMED' });
    });
    it('preserves source mixed-shipment SDD zero selection with global and historical proof, never Express scope', async () => {
      await genuineOnline();
      await connection.query('UPDATE orders SET is_split_order=1');
      await fixture.insert('has_products', {
        id: '9007199254740997',
        order_id: orderId,
        prod_id: 66,
        qty: 1,
        price: 0,
        order_platform_id: 3,
      });
      const fetcher = globalRenderer('same-day');
      expect(
        await scopedInvoiceService(
          db,
          config,
          globalOptions,
          fetcher,
          history,
        )(user, globalScope, 'same-day'),
      ).toMatchObject({ kind: 'same-day', access: 'global-online', number: null });
      await expect(
        scopedInvoiceService(
          db,
          config,
          globalOptions,
          globalRenderer('same-day'),
          history,
        )(user, globalScope, 'express'),
      ).rejects.toMatchObject({ code: 'INVOICE_SCOPE_UNCONFIRMED' });
    });
    for (const mode of [
      'selected-fee',
      'parent-fee',
      'selected-insert',
      'parent-reference',
      'reference',
      'voucher-value',
      'voucher-link',
    ] as const)
      it(
        'binds actual source ' + mode + ' financial inputs before and after rendering',
        async () => {
          await genuineOnline();
          await fixture.insert('order_addons', {
            order_id: mode === 'selected-fee' ? orderId : '55',
            platform_fee: '7.89',
          });
          await connection.query('UPDATE orders SET parent_order_id=55');
          await fixture.insert('gift_vouchers', {
            id: 66,
            order_id: orderId,
            voucher_initial_value: '12.34',
          });
          if (mode === 'voucher-link')
            for (const id of [77, 78])
              await fixture.insert('has_products', {
                id,
                order_id: '9999',
                prod_id: 66,
                qty: 1,
                price: 0,
                gift_voucher_id: 0,
              });
          const mutate = async () => {
            if (mode === 'selected-fee' || mode === 'parent-fee')
              await connection.query('UPDATE order_addons SET platform_fee=platform_fee+1');
            else if (mode === 'selected-insert')
              await fixture.insert('order_addons', { order_id: orderId, platform_fee: '0' });
            else if (mode === 'parent-reference')
              await connection.query('UPDATE orders SET parent_order_id=56');
            else if (mode === 'reference')
              await connection.query("UPDATE orders SET order_ref_no='changed-fixture-reference'");
            else if (mode === 'voucher-value')
              await connection.query(
                'UPDATE gift_vouchers SET voucher_initial_value=voucher_initial_value+1 WHERE id=66',
              );
            else
              await connection.query(
                'UPDATE has_products SET gift_voucher_id=66 WHERE id IN (77,78)',
              );
          };
          const fetcher = globalRenderer('online', mutate);
          await expect(
            onlineInvoiceService(db, config, globalOptions, fetcher, history)(user, globalScope),
          ).rejects.toMatchObject({ code: 'INVOICE_SCOPE_CHANGED' });
          expect(fetcher).toHaveBeenCalledTimes(1);
        },
      );
    it('renders the exact current fullwidth order once, sanitizes active content and performs no financial writes', async () => {
      const fetcher = renderer(),
        service = invoice(fetcher),
        [before] = await connection.query(
          'SELECT pay_amt,payment_status,order_status FROM orders WHERE id=?',
          [orderId],
        );
      const document = await service(user, scope);
      expect(document).toMatchObject({
        kind: 'online',
        orderId,
        storeId: '1',
        number: 'FIXTURE/INV/1',
      });
      expect(document.html).toContain('GSTIN FIXTURE');
      expect(document.html).not.toContain('BAD_SCRIPT');
      expect(document.html).toContain('data:image/png;base64,aA==');
      expect(fetcher).toHaveBeenCalledTimes(1);
      const [after] = await connection.query(
        'SELECT pay_amt,payment_status,order_status FROM orders WHERE id=?',
        [orderId],
      );
      expect(after).toEqual(before);
    });
    it('rejects cross-store/unpaid/inactive or revoked scope before calling the renderer', async () => {
      const fetcher = renderer(),
        service = invoice(fetcher);
      await expect(
        service({ ...user, storeIds: ['2'] }, { storeId: '2', orderId }),
      ).rejects.toMatchObject({ code: 'STORE_ACCESS_DENIED' });
      await connection.query('UPDATE orders SET payment_status=1');
      await expect(service(user, scope)).rejects.toMatchObject({ code: 'INVOICE_PAYMENT_PENDING' });
      await connection.query('UPDATE orders SET payment_status=4');
      await connection.query('UPDATE stores SET is_active=0 WHERE id=1');
      await expect(service(user, scope)).rejects.toMatchObject({ code: 'STORE_NOT_FOUND' });
      await connection.query('UPDATE stores SET is_active=1');
      await connection.query('DELETE FROM user_stores');
      await expect(service(user, scope)).rejects.toMatchObject({ code: 'STORE_ACCESS_DENIED' });
      expect(fetcher).not.toHaveBeenCalled();
    });
    it('rechecks current authority after HTTP without retaining SQL locks over the render', async () => {
      const fetcher = renderer(async () => {
        await connection.query('SET SESSION innodb_lock_wait_timeout=1');
        await connection.query('DELETE FROM user_stores WHERE django_user_id=7');
      });
      await expect(invoice(fetcher)(user, scope)).rejects.toMatchObject({
        code: 'STORE_ACCESS_DENIED',
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it('refuses changed native financial/header or line scope during the render', async () => {
      const fetcher = renderer(async () => {
        await connection.query('UPDATE has_products SET price=99 WHERE id=?', [lineId]);
      });
      await expect(invoice(fetcher)(user, scope)).rejects.toMatchObject({
        code: 'INVOICE_SCOPE_CHANGED',
      });
    });
    it('binds the resolved current address to the original customer and detects its native changes without exposing contacts', async () => {
      await fixture.insert('has_addresses', {
        id: 1,
        user_id: 777,
        firstname: 'Fixture',
        lastname: 'Address',
        phone_no: '0000000000',
      });
      await connection.query('UPDATE orders SET has_address_id=1');
      await expect(
        invoice(
          renderer(async () => {
            await connection.query("UPDATE has_addresses SET phone_no='0000000001' WHERE id=1");
          }),
        )(user, scope),
      ).rejects.toMatchObject({ code: 'INVOICE_SCOPE_CHANGED' });
      await connection.query('UPDATE has_addresses SET user_id=888 WHERE id=1');
      const fetcher = renderer();
      await expect(invoice(fetcher)(user, scope)).rejects.toMatchObject({
        code: 'INVOICE_SCOPE_UNCONFIRMED',
      });
      expect(fetcher).not.toHaveBeenCalled();
      await connection.query('UPDATE has_addresses SET user_id=777 WHERE id=1');
      expect((await invoice(fetcher)(user, scope)).orderId).toBe(orderId);
    });
    it('withholds a completed protected render when its accepted session is revoked during the provider read', async () => {
      // Express avoids the separately gated BQ display count. Its real writer
      // scope/proof checks finish, then the HTTP session is revalidated.
      const selectedScope = await expressFixture(),
        selectedFetcher = scopedRenderer('express');
      const scopedApp = Fastify();
      scopedApp.decorateRequest('principal', null);
      scopedApp.decorateRequest('authSessionValid', null);
      scopedApp.addHook('preHandler', async (request) => {
        request.principal = user;
        request.authSessionValid = async () => false;
      });
      scopedApp.setErrorHandler((error, _request, reply) => {
        const parsed = z.object({ status: z.number(), code: z.string() }).safeParse(error);
        return reply
          .status(parsed.success ? parsed.data.status : 500)
          .send({ error: { code: parsed.success ? parsed.data.code : 'FIXTURE_ERROR' } });
      });
      registerInvoiceDocuments(scopedApp, config, db, options, selectedFetcher);
      try {
        const response = await scopedApp.inject({
          url: `/api/v1/operators/${user.id}/stores/1/orders/${selectedScope.orderId}/invoices/express/preview`,
        });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({ error: { code: 'SESSION_EXPIRED' } });
        expect(response.body).not.toContain('GSTIN FIXTURE');
        expect(selectedFetcher).toHaveBeenCalledTimes(1);
      } finally {
        await scopedApp.close();
      }
    });
    it('does not expose a partial/mixed-store Express order as a full invoice', async () => {
      // The physically verified Express foreign IDs are signed INT, while the
      // ordinary orders/HP test above deliberately exercises real BIGINT IDs.
      const expressOrderId = '12345',
        expressScope = { storeId: '1', orderId: expressOrderId };
      await connection.query('DELETE FROM order_stores');
      await connection.query('UPDATE orders SET id=? WHERE id=?', [expressOrderId, orderId]);
      await connection.query('UPDATE has_products SET id=77,order_id=? WHERE id=?', [
        expressOrderId,
        lineId,
      ]);
      await fixture.insert('has_products', {
        id: '78',
        order_id: expressOrderId,
        prod_id: 66,
        qty: 1,
        price: 50,
        order_platform_id: 5,
      });
      await fixture.insert('express_line_item', {
        order_id: expressOrderId,
        has_product_id: '77',
        store_id: 1,
      });
      const fetcher = renderer(undefined, false, expressOrderId),
        service = invoice(fetcher);
      await expect(service(user, expressScope)).rejects.toMatchObject({
        code: 'INVOICE_SCOPE_UNCONFIRMED',
      });
      await fixture.insert('express_line_item', {
        order_id: expressOrderId,
        has_product_id: '78',
        store_id: 2,
      });
      await expect(service(user, expressScope)).rejects.toMatchObject({
        code: 'INVOICE_SCOPE_UNCONFIRMED',
      });
      await connection.query('UPDATE express_line_item SET store_id=1');
      expect((await service(user, expressScope)).orderId).toBe(expressOrderId);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it('does not let a stale franchise role1 principal bypass current assignment/category policy', async () => {
      await connection.query('UPDATE pos_user SET role=1,user_type=2');
      const fetcher = renderer();
      await expect(
        invoice(fetcher)({ ...user, role: 1, userType: 1 }, scope),
      ).rejects.toMatchObject({ code: 'STORE_ACCESS_DENIED' });
      expect(fetcher).not.toHaveBeenCalled();
    });
    for (const global of [false, true])
      it(
        'matches actual Python/MySQL ' +
          (global ? 'explicit global N' : 'owned') +
          ' native scope and intercepts history without any writer binding',
        async () => {
          if (global) await genuineOnline();
          await fixture.insert('order_addons', { order_id: orderId, platform_fee: '7.89' });
          await fixture.insert('gift_vouchers', {
            id: 66,
            order_id: orderId,
            voucher_initial_value: '12.34',
          });
          await connection.query('UPDATE has_products SET gift_voucher_id=66 WHERE id=?', [lineId]);
          const selectedScope = global ? globalScope : scope;
          await connection.query('UPDATE order_stores SET order_invoice=?', ['FIXTURE/INV/café']);
          for (const id of ['2', '10'])
            await fixture.insert('has_products', {
              id,
              order_id: orderId,
              prod_id: 66,
              qty: 1,
              price: 0.125,
              order_platform_id: 2,
              gst: 5,
              pre_gst_amt: 0.12,
            });
          await connection.query('UPDATE has_products SET gift_voucher_id=66 WHERE order_id=?', [
            orderId,
          ]);
          const authority = await invoiceDocumentAuthority(db)(user, selectedScope),
            proofScope: InvoiceProofScope = {
              kind: 'online',
              orderId,
              operatorId: user.id,
              requestId: 'native-invoice-' + randomUUID(),
              nonce: 'a'.repeat(32),
            },
            evidence = await history(selectedScope, authority),
            capability = issueInvoiceHistoryProof(
              proofScope,
              scope.storeId,
              authority,
              evidence,
              key,
            );
          const globalCapability = global
            ? issueGlobalOnlineInvoiceProof(
                'online',
                proofScope,
                scope.storeId,
                authority,
                capability,
                key,
              )
            : undefined;
          const raw = JSON.parse(
            execFileSync(
              'uv',
              [
                'run',
                '--frozen',
                '--project',
                resolve('compatibility/upstream/invoice-security/runtime'),
                'python',
                resolve('compatibility/upstream/invoice-documents/runtime_probe.py'),
              ],
              {
                input: JSON.stringify({
                  url: config.MYSQL_WRITER_URL,
                  orderId,
                  storeId: scope.storeId,
                  customerId: authority.customerId,
                  operatorId: user.id,
                  nonce: proofScope.nonce,
                  requestId: proofScope.requestId,
                  key,
                  capability,
                  ...(global ? { globalCapability } : {}),
                }),
                encoding: 'utf8',
                timeout: 20000,
                maxBuffer: 128 * 1024,
                env: {
                  PATH: process.env.PATH,
                  HOME: process.env.HOME,
                  PYTHONDONTWRITEBYTECODE: '1',
                },
                stdio: ['pipe', 'pipe', 'pipe'],
              },
            ),
          ) as unknown;
          const result = z
            .object({
              snapshot: z.object({ binding: z.string(), customerId: z.string() }),
              writeRejected: z.literal(true),
              rows: z.literal(1),
              sqlModeUnchanged: z.literal(true),
              isolation: z.literal('REPEATABLE READ'),
              status: z.literal(200),
              missingHistoryStatus: z.literal(503),
              html: z.string(),
              headers: z.record(z.string(), z.string()),
              boughtVoucherInitialValues: z.array(z.literal('12.34')).length(3),
              historyFallbacks: z.literal(0),
              renderCalls: z.literal(1),
              writerBindingsAbsent: z.literal(true),
              redisWriterAbsent: z.literal(true),
            })
            .parse(raw);
          expect(result.snapshot).toEqual({
            binding: authority.binding,
            customerId: authority.customerId,
          });
          expect(result.html).toContain('Orders: 2');
          const response = new Response(result.html, { headers: result.headers });
          if (global)
            assertGlobalOnlineInvoiceResponse(response, globalCapability!, result.html, key);
          assertInvoiceResponseProof(response, proofScope, result.html, key);
          assertInvoiceHistoryResponse(response, capability, result.html, key);
        },
        30000,
      );
    it('executes the exact source SDD shipment-zero request only for a current full mixed shipment', async () => {
      await connection.query('UPDATE orders SET is_split_order=1');
      await connection.query('UPDATE has_products SET order_platform_id=3');
      await fixture.insert('has_products', {
        id: '9007199254740996',
        order_id: orderId,
        prod_id: 67,
        qty: 1,
        price: 25,
        order_platform_id: 1,
      });
      const fetcher = scopedRenderer('same-day'),
        service = scopedInvoiceService(db, config, options, fetcher);
      expect(await service(user, scope, 'same-day')).toMatchObject({
        kind: 'same-day',
        orderId,
        storeId: '1',
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect((await invoiceCapabilities(db, options)(user, scope)).actions).toContainEqual({
        kind: 'same-day',
        available: true,
      });
      await connection.query('UPDATE orders SET is_split_order=0');
      await expect(service(user, scope, 'same-day')).rejects.toMatchObject({
        code: 'INVOICE_SCOPE_UNCONFIRMED',
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it('authorizes only the selected store Express HP set, preserving other shipment rows and all financial state', async () => {
      const selectedScope = await expressFixture(),
        fetcher = scopedRenderer('express'),
        service = scopedInvoiceService(db, config, options, fetcher);
      const [before] = await connection.query('SELECT * FROM has_products ORDER BY id');
      expect(await service(user, selectedScope, 'express')).toMatchObject({
        kind: 'express',
        orderId: '12345',
        storeId: '1',
        number: null,
      });
      expect(await invoiceCapabilities(db, options)(user, selectedScope)).toEqual({
        ...selectedScope,
        actions: [{ kind: 'express', available: true }],
      });
      const [after] = await connection.query('SELECT * FROM has_products ORDER BY id');
      expect(after).toEqual(before);
      expect(fetcher).toHaveBeenCalledTimes(1);
      await fixture.insert('express_line_item', {
        order_id: 12345,
        has_product_id: 77,
        store_id: 2,
      });
      await expect(service(user, selectedScope, 'express')).rejects.toMatchObject({
        code: 'INVOICE_SCOPE_UNCONFIRMED',
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it('freezes substituted selected proofs and changed association or actor scope before releasing HTML', async () => {
      const selectedScope = await expressFixture();
      await expect(
        scopedInvoiceService(
          db,
          config,
          options,
          scopedRenderer('express', undefined, true),
        )(user, selectedScope, 'express'),
      ).rejects.toMatchObject({ code: 'INVOICE_SCOPE_PROOF_UNCONFIRMED' });
      await expect(
        scopedInvoiceService(
          db,
          config,
          options,
          scopedRenderer('express', async () => {
            await connection.query(
              'UPDATE express_line_item SET store_id=2 WHERE has_product_id=77',
            );
          }),
        )(user, selectedScope, 'express'),
      ).rejects.toMatchObject({ code: 'INVOICE_SCOPE_UNCONFIRMED' });
      await connection.query('UPDATE express_line_item SET store_id=1 WHERE has_product_id=77');
      await expect(
        scopedInvoiceService(
          db,
          config,
          options,
          scopedRenderer('express', async () => {
            await connection.query('DELETE FROM user_stores');
          }),
        )(user, selectedScope, 'express'),
      ).rejects.toMatchObject({ code: 'STORE_ACCESS_DENIED' });
    });
    it('verifies the selected Express capability against actual isolated Python/MySQL scope without accepting caller HP IDs', async () => {
      const selectedScope = await expressFixture();
      await connection.query(
        'UPDATE has_products SET gift_voucher_id=CASE id WHEN 77 THEN 10 ELSE 20 END',
      );
      for (const [id, line, amount] of [
        [10, 77, 25],
        [20, 78, 500],
      ]) {
        await fixture.insert('gift_vouchers', {
          id: id!,
          order_id: 12345,
          voucher_initial_value: amount!,
          voucher_value: amount!,
          voucher_code: 'FIXTURE-' + id,
        });
        await fixture.insert('order_point_cashback', {
          order_id: 12345,
          has_product_id: line!,
          hp_point_credited: id === 10 ? 1 : 99,
        });
      }
      const snapshot = await invoiceScopeSnapshot(db)(user, selectedScope),
        proofScope: InvoiceProofScope = {
          kind: 'store',
          orderId: '12345',
          operatorId: user.id,
          requestId: 'selected-native-' + randomUUID(),
          nonce: 'a'.repeat(32),
        },
        capability = issueScopedInvoiceProof('express', proofScope, '1', snapshot, ['77'], key);
      const raw = JSON.parse(
        execFileSync(
          'uv',
          [
            'run',
            '--frozen',
            '--project',
            resolve('compatibility/upstream/invoice-security/runtime'),
            'python',
            resolve('compatibility/upstream/invoice-documents/runtime_probe.py'),
          ],
          {
            input: JSON.stringify({
              url: config.MYSQL_WRITER_URL,
              orderId: '12345',
              storeId: '1',
              operatorId: user.id,
              nonce: proofScope.nonce,
              requestId: proofScope.requestId,
              key,
              scopeCapability: capability,
            }),
            encoding: 'utf8',
            timeout: 20000,
            maxBuffer: 128 * 1024,
            env: {
              PATH: process.env.PATH,
              HOME: process.env.HOME,
              PYTHONDONTWRITEBYTECODE: '1',
              UV_CACHE_DIR: process.env.UV_CACHE_DIR,
              UV_OFFLINE: 'true',
            },
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        ),
      ) as unknown;
      const result = z
        .object({
          snapshot: z.object({ binding: z.string(), customerId: z.string() }),
          writeRejected: z.literal(true),
          rows: z.literal(1),
          isolation: z.literal('REPEATABLE READ'),
          sqlModeUnchanged: z.literal(true),
          status: z.literal(200),
          selectedPoints: z.literal(1),
          selectedGiftIds: z.tuple([z.literal('10')]),
          missingScopeStatus: z.literal(503),
          substitutedIdsStatus: z.literal(400),
          html: z.string(),
          headers: z.record(z.string(), z.string()),
          historyFallbacks: z.literal(0),
          renderCalls: z.literal(1),
        })
        .parse(raw);
      expect(result.snapshot.binding).toBe(snapshot.binding);
      expect(result.html).toContain('Selected: 77');
      expect(result.html).not.toContain('78');
      const response = new Response(result.html, { headers: result.headers });
      assertInvoiceResponseProof(response, proofScope, result.html, key);
      assertScopedInvoiceResponse(response, capability, result.html, key);
    }, 30000);
    it('does not dispatch a legacy unsigned transport or retry an uncertain read outcome', async () => {
      const selectedScope = await expressFixture(),
        fetcher = vi.fn<typeof fetch>(async () => {
          throw new Error('controlled lost response');
        });
      await expect(
        scopedInvoiceService(
          db,
          config,
          { ...options, scopedContract: undefined },
          fetcher,
        )(user, selectedScope, 'express'),
      ).rejects.toMatchObject({ code: 'INVOICE_SECURITY_UNCONFIRMED' });
      expect(fetcher).not.toHaveBeenCalled();
      await expect(
        scopedInvoiceService(db, config, options, fetcher)(user, selectedScope, 'express'),
      ).rejects.toMatchObject({ code: 'INVOICE_UNAVAILABLE' });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(
        (
          await invoiceCapabilities(db, { ...options, scopedContract: undefined })(
            user,
            selectedScope,
          )
        ).actions,
      ).toEqual([{ kind: 'express', available: false }]);
    });
    it('rejects substituted HTML and missing private contract without returning content', async () => {
      await expect(invoice(renderer(undefined, true))(user, scope)).rejects.toMatchObject({
        code: 'INVOICE_SECURITY_UNCONFIRMED',
      });
      const fetcher = renderer();
      await expect(
        onlineInvoiceService(db, config, {}, fetcher, history)(user, scope),
      ).rejects.toMatchObject({ code: 'INVOICE_SECURITY_UNCONFIRMED' });
      expect(fetcher).not.toHaveBeenCalled();
    });
  },
);
