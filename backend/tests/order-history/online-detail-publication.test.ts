import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  qualifyDetailFact,
  qualifyDetailPublication,
} from '../../src/modules/order-history/online-detail/qualification.js';
import {
  onlineDetailFact,
  onlineOrderDetailContract,
} from '../../src/modules/order-history/online-detail/contracts.js';
import { readOnlineDetailOptions } from '../../src/modules/order-history/online-detail/options.js';
const now = Date.parse('2026-11-18T12:00:00Z'),
  generation = '4918d168-c62e-4ed7-b8ae-89b0a5e70019';
const fact = onlineDetailFact.parse({
  contract: onlineOrderDetailContract,
  orderId: '9007199254740993',
  customerId: '7',
  createdAt: '2026-11-17 10:00:00',
  timeZone: 'Asia/Kolkata',
  reference: 'SYNTHETIC',
  amount: '25.49',
  payAmount: '25.49',
  status: { id: '3', label: 'Delivered' },
  paymentStatus: { id: '4', label: 'Paid' },
  paymentMethod: { id: '14', label: 'Cash' },
  global: false,
  split: false,
  storeIds: [],
  delivery: {
    locationId: null,
    locationType: '',
    ownerStoreId: null,
    transfer: false,
    nextStoreIds: [],
    startSlot: null,
    endSlot: null,
    parentOrderId: null,
    childOrderId: null,
    courier: { id: null, sourceTracking: null, destinationTracking: null },
    ticket: { id: null, status: null, message: null },
  },
  lines: [],
  timeline: [],
});
const json = JSON.stringify(fact),
  hash = createHash('sha256').update(json).digest('hex');
const metadata = {
  contract_version: onlineOrderDetailContract,
  generation_id: generation,
  order_id: fact.orderId,
  customer_id: '7',
  business_date: '2026-11-17',
  business_timezone: 'Asia/Kolkata',
  source_complete: true,
  source_snapshot_id: 'synthetic-native-checkpoint-0001',
  source_snapshot_at: '2026-11-18T11:59:00Z',
  source_cdc_watermark: '2026-11-18T11:59:10Z',
  published_at: '2026-11-18T11:59:20Z',
  source_rows: '1',
  warehouse_rows: '1',
  source_lines: '0',
  warehouse_lines: '0',
  source_events: '0',
  warehouse_events: '0',
  source_express: '0',
  warehouse_express: '0',
  source_hash: hash,
  warehouse_hash: hash,
};
const row = {
  generation_id: generation,
  order_id: fact.orderId,
  business_date: '2026-11-17',
  details_json: json,
  details_hash: hash,
};
const input = {
    orderId: fact.orderId,
    customerId: '7',
    cutoff: '2026-11-18 00:00:00',
    timeZone: 'Asia/Kolkata',
  },
  options = readOnlineDetailOptions({});
describe('complete qualified rich historical detail', () => {
  it('accepts only one matching complete generation with exact fact bytes and bound customer', () => {
    const publication = qualifyDetailPublication([metadata], input, options, now);
    expect(qualifyDetailFact([row], publication, input)).toEqual(fact);
    expect(() => qualifyDetailPublication([], input, options, now)).toThrow(
      'Complete historical order details',
    );
  });
  it('refuses partial, stale, duplicated or mismatched source checkpoints before exposing a fact', () => {
    for (const change of [
      { source_complete: false },
      { source_rows: '2' },
      { warehouse_rows: '0' },
      { source_lines: '1' },
      { source_events: '1' },
      { source_express: '1' },
      { customer_id: '8' },
      { business_timezone: 'UTC' },
      { order_id: '1' },
      { source_hash: 'a'.repeat(64) },
      { source_snapshot_at: '2026-11-18T11:00:00Z' },
      { source_cdc_watermark: '2026-11-18T11:58:00Z' },
      { published_at: '2026-11-18T12:01:00Z' },
    ])
      expect(() =>
        qualifyDetailPublication([{ ...metadata, ...change }], input, options, now),
      ).toThrow();
    expect(() => qualifyDetailPublication([metadata, metadata], input, options, now)).toThrow();
  });
  it('refuses mixed-generation, corrupt, missing or date-outside-selection facts without a fallback', () => {
    const publication = qualifyDetailPublication([metadata], input, options, now);
    for (const change of [
      { generation_id: '4918d168-c62e-4ed7-b8ae-89b0a5e70020' },
      { order_id: '1' },
      { business_date: '2026-11-16' },
      { details_json: json + ' ' },
      { details_hash: 'f'.repeat(64) },
    ])
      expect(() => qualifyDetailFact([{ ...row, ...change }], publication, input)).toThrow();
    expect(() => qualifyDetailFact([], publication, input)).toThrow();
    expect(() => qualifyDetailFact([row, row], publication, input)).toThrow();
    expect(() =>
      qualifyDetailFact([row], publication, { ...input, cutoff: '2026-11-17 00:00:00' }),
    ).toThrow('Order not found');
    const corrupt = JSON.stringify({ ...fact, customerId: '8' }),
      corruptHash = createHash('sha256').update(corrupt).digest('hex');
    expect(() =>
      qualifyDetailFact(
        [{ ...row, details_json: corrupt, details_hash: corruptHash }],
        { ...publication, source_hash: corruptHash, warehouse_hash: corruptHash },
        input,
      ),
    ).toThrow();
  });
});
