import { describe, expect, it, vi } from 'vitest';
import { readConfig } from '../../src/config.js';
import type { InvoiceAuthority } from '../../src/modules/invoice-documents/authority.js';
import {
  invoiceHistoryReader,
  invoiceHistoryPublicationContract,
  invoiceHistorySql,
} from '../../src/modules/invoice-documents/history.js';
import type { InvoiceDocumentOptions } from '../../src/modules/invoice-documents/options.js';
const now = Date.parse('2026-11-16T10:01:00Z'),
  generation = '123e4567-e89b-42d3-a456-426614174000',
  config = readConfig({
    NODE_ENV: 'test',
    DEMO_MODE: 'true',
    SESSION_SECRET: 'invoice-history-fixture-'.repeat(4),
    BIGQUERY_PROJECT_ID: 'tssgcp2025',
  }),
  scope = { storeId: '1', orderId: '9007199254740993' },
  authority: InvoiceAuthority = {
    binding: 'a'.repeat(64),
    number: null,
    customerId: '9007199254740994',
    orderStatus: '3',
    updatedAt: '2026-11-16 10:00:00',
  };
const options: InvoiceDocumentOptions = {
  historyPublicationContract: invoiceHistoryPublicationContract,
  historyOrdersView: 'tssgcp2025.tss_mysql_raw_layer.pos_invoice_orders_v1',
  historyCustomersView: 'tssgcp2025.tss_mysql_raw_layer.pos_invoice_customer_counts_v1',
  historyPublicationsView: 'tssgcp2025.tss_mysql_raw_layer.pos_invoice_publications_v1',
  historyMaxLagSeconds: 600,
};
function facts() {
  return {
    publication: [
      {
        generation_id: generation,
        contract_version: invoiceHistoryPublicationContract,
        source_table: 'orders',
        source_complete: true,
        source_snapshot_id: 'source-snapshot-position-1',
        source_snapshot_at: '2026-11-16T10:00:30.000000Z',
        source_cdc_watermark: '2026-11-16T10:00:31.000000Z',
        published_at: '2026-11-16T10:00:32.000000Z',
        source_rows: '10',
        warehouse_rows: '10',
        source_hash: 'a'.repeat(64),
        warehouse_hash: 'a'.repeat(64),
      },
    ],
    customers: [
      {
        generation_id: generation,
        customer_id: authority.customerId,
        source_rows: '3',
        warehouse_rows: '3',
        source_hash: 'b'.repeat(64),
        warehouse_hash: 'b'.repeat(64),
        source_eligible_count: '2',
        warehouse_eligible_count: '2',
      },
    ],
    selected: [
      {
        generation_id: generation,
        order_id: scope.orderId,
        customer_id: authority.customerId,
        order_status: '3',
        payment_status: '4',
        updated_at: '2026-11-16 10:00:00.000000',
      },
    ],
  };
}
describe('single-table complete invoice history publication', () => {
  it('never substitutes raw CDC metadata, missing publication or MySQL fallback for completeness', async () => {
    const estimate = vi.fn(async () => 0n),
      query = vi.fn(async () => [facts()]);
    await expect(
      invoiceHistoryReader(config, {}, estimate, query, () => now)(scope, authority),
    ).rejects.toMatchObject({ code: 'INVOICE_HISTORY_PUBLICATION_REQUIRED' });
    expect(estimate).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
  it('uses exact bound IDs, explicit generation views and source/count/hash conservation', async () => {
    const estimate = vi.fn(async () => 2000n),
      query = vi.fn(async () => [facts()]);
    const value = await invoiceHistoryReader(
      config,
      options,
      estimate,
      query,
      () => now,
    )(scope, authority);
    expect(value).toMatchObject({
      count: '2',
      evidence: {
        generationId: generation,
        customerSourceRows: '3',
        customerOrdersHash: 'b'.repeat(64),
      },
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('DENSE_RANK'),
      {
        contract: invoiceHistoryPublicationContract,
        customer: authority.customerId,
        order: scope.orderId,
      },
      { contract: 'STRING', customer: 'STRING', order: 'STRING' },
      'invoice-order-count',
    );
    const statement = invoiceHistorySql(options);
    expect(statement).not.toContain(authority.customerId);
    expect(statement).not.toContain(scope.orderId);
    expect(statement).not.toContain('FROM `tssgcp2025.tss_mysql_raw_layer.tss_orders`');
  });
  it('rejects empty/duplicate/incomplete generations, wrong ownership, stale rows and mismatched source hashes', async () => {
    const invalid: unknown[] = [];
    for (const mutate of [
      (value: ReturnType<typeof facts>) => {
        value.publication = [];
      },
      (value: ReturnType<typeof facts>) => {
        value.publication.push(value.publication[0]!);
      },
      (value: ReturnType<typeof facts>) => {
        value.publication[0]!.source_complete = false;
      },
      (value: ReturnType<typeof facts>) => {
        value.publication[0]!.warehouse_hash = 'c'.repeat(64);
      },
      (value: ReturnType<typeof facts>) => {
        value.customers = [];
      },
      (value: ReturnType<typeof facts>) => {
        value.customers[0]!.source_eligible_count = '0';
        value.customers[0]!.warehouse_eligible_count = '0';
      },
      (value: ReturnType<typeof facts>) => {
        value.customers[0]!.warehouse_rows = '2';
      },
      (value: ReturnType<typeof facts>) => {
        value.selected = [];
      },
      (value: ReturnType<typeof facts>) => {
        value.selected[0]!.customer_id = '777';
      },
      (value: ReturnType<typeof facts>) => {
        value.selected[0]!.payment_status = '1';
      },
      (value: ReturnType<typeof facts>) => {
        value.selected[0]!.updated_at = '2026-11-16 09:00:00.000000';
      },
      (value: ReturnType<typeof facts>) => {
        value.publication[0]!.source_snapshot_at = '2026-11-16T08:00:00Z';
      },
      (value: ReturnType<typeof facts>) => {
        value.publication[0]!.published_at = '2026-11-16T09:00:00Z';
      },
      (value: ReturnType<typeof facts>) => {
        value.publication[0]!.source_cdc_watermark = '2026-11-16T10:00:59Z';
      },
    ]) {
      const value = facts();
      mutate(value);
      invalid.push(value);
    }
    for (const value of invalid) {
      const query = vi.fn(async () => [value as Record<string, unknown>]);
      await expect(
        invoiceHistoryReader(
          config,
          options,
          async () => 0n,
          query,
          () => now,
        )(scope, authority),
      ).rejects.toMatchObject({ code: 'INVOICE_HISTORY_PUBLICATION_INVALID' });
    }
  });
  it('preserves an attested legitimate zero count while refusing an empty dataset as zero', async () => {
    const value = facts();
    value.customers[0]!.source_eligible_count = '0';
    value.customers[0]!.warehouse_eligible_count = '0';
    value.selected[0]!.order_status = '4';
    const query = async () => [value];
    expect(
      (
        await invoiceHistoryReader(
          config,
          options,
          async () => 0n,
          query,
          () => now,
        )(scope, { ...authority, orderStatus: '4' })
      ).count,
    ).toBe('0');
    await expect(
      invoiceHistoryReader(
        config,
        options,
        async () => 0n,
        async () => [],
        () => now,
      )(scope, authority),
    ).rejects.toMatchObject({ code: 'INVOICE_HISTORY_PUBLICATION_INVALID' });
  });
  it('enforces the unchanged byte budget before running a historical query', async () => {
    const query = vi.fn(async () => [facts()]);
    await expect(
      invoiceHistoryReader(
        config,
        options,
        async () => BigInt(config.BIGQUERY_MAX_BYTES_BILLED) + 1n,
        query,
        () => now,
      )(scope, authority),
    ).rejects.toMatchObject({ code: 'INVOICE_HISTORY_PROJECTION_REQUIRED' });
    expect(query).not.toHaveBeenCalled();
  });
});
