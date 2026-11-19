import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, vi } from 'vitest';
import { readConfig } from '../../src/config.js';
import type { Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import { AppError } from '../../src/domain/errors.js';
import {
  customerFeedbackService,
  feedbackOptions,
} from '../../src/modules/operational-reports/feedback.js';
import type { FeedbackFact } from '../../src/modules/operational-reports/feedback-history-contracts.js';
import type { FeedbackHistoryStatement } from '../../src/modules/operational-reports/feedback-history.js';

const user: Principal = {
    id: '10',
    name: 'Fixture operator',
    email: 'operator@example.test',
    role: 4,
    userType: 2,
    storeIds: ['1'],
  },
  config = readConfig({
    NODE_ENV: 'test',
    MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
    SESSION_SECRET: 'feedback-routing-fixture-'.repeat(3),
  }),
  clock = () => Temporal.Instant.from('2026-11-16T08:00:00Z'),
  input = {
    from: '2026-11-15T00:00:00',
    to: '2026-11-15T23:59:59',
    storeIds: ['1'],
    email: 'fixture@example.test',
    page: 1,
    pageSize: 25,
  },
  fact: FeedbackFact = {
    orderId: '9007199254740993',
    customerId: '7',
    associatedStoreId: '1',
    questionId: '2',
    feedback: 'Fixture feedback',
    feedbackDate: null,
    orderDate: '2026-11-15 12:00:00',
  };
function setup() {
  const db: Databases = {
      get: () => {
        throw new Error('Unexpected direct MySQL access; inject only current dimensions.');
      },
      close: async () => {},
    },
    calls: { query: string; params: Record<string, unknown>; resource?: string }[] = [],
    response: { total: string; page: number; items: FeedbackFact[] } = {
      total: '1',
      page: 1,
      items: [fact],
    },
    warehouse = {
      queryReport: async (
        query: string,
        params: Record<string, unknown>,
        _types: Record<string, string | string[]>,
        resource?: string,
      ) => {
        calls.push({ query, params, resource });
        return [response];
      },
    },
    dimensions = {
      authorize: vi.fn(async (_actor: Principal, _stores: readonly string[] | undefined) => {}),
      emailCustomers: vi.fn(async (_email: string) => ['7']),
      knownStores: vi.fn(async (stores: readonly string[]) => [...stores]),
      enrich: vi.fn(async (facts: readonly FeedbackFact[]) =>
        facts.map((row) => ({
          orderId: row.orderId,
          storeId: row.associatedStoreId,
          storeName: 'Fixture store',
          firstName: 'Fixture',
          email: 'fixture@example.test',
          telephone: '+91 1234567890',
          feedback: row.feedback,
          question: null,
          feedbackDate: row.feedbackDate,
          orderDate: row.orderDate,
        })),
      ),
    },
    estimate = vi.fn(async (_query: FeedbackHistoryStatement) => 1n),
    service = customerFeedbackService(config, db, feedbackOptions({}), warehouse, clock, {
      dimensions,
      estimate,
    });
  return { service, calls, response, dimensions, estimate };
}
describe('customer-feedback historical facts with bounded current dimensions', () => {
  it('preserves large IDs and masks after one warehouse count/page query, without email/contact/query literals', async () => {
    const fixture = setup(),
      result = await fixture.service.search(user, input);
    expect(result.reader).toBe('bigquery');
    expect(result.total).toBe(1);
    expect(fixture.calls).toHaveLength(1);
    const call = fixture.calls[0]!;
    expect(call.resource).toBe('customer-feedback');
    expect(call.params.customers).toEqual(['7']);
    expect(call.params).not.toHaveProperty('email');
    expect(call.query).not.toContain(input.email);
    expect(call.query).not.toMatch(/LOWER\(|nps_questions|tss_users/);
    expect(fixture.dimensions.emailCustomers).toHaveBeenCalledTimes(2);
    expect(fixture.dimensions.authorize).toHaveBeenCalledTimes(3);
    expect(result.data[0]).toMatchObject({
      order_id: '9007199254740993',
      name: 'F*****e',
      email: 'f******@e******.test',
      telephone: '********7890',
      question: null,
      feedback_date: null,
    });
  });
  it('uses source empty-selection franchise behavior and rejects a foreign selected store before warehouse work', async () => {
    const fixture = setup();
    expect((await fixture.service.search(user, { ...input, storeIds: undefined })).total).toBe(0);
    expect(fixture.calls).toHaveLength(0);
    expect(fixture.dimensions.enrich).not.toHaveBeenCalled();
    await expect(
      fixture.service.search({ ...user, role: 1 }, { ...input, storeIds: ['2'] }),
    ).rejects.toMatchObject({ code: 'STORE_ACCESS_DENIED' });
    expect(fixture.calls).toHaveLength(0);
  });
  it('applies proven empty equality/store predicates without querying historical facts', async () => {
    const noEmail = setup();
    noEmail.dimensions.emailCustomers.mockResolvedValue([]);
    expect((await noEmail.service.search(user, input)).total).toBe(0);
    expect(noEmail.calls).toHaveLength(0);
    const noStore = setup();
    noStore.dimensions.knownStores.mockResolvedValue([]);
    expect((await noStore.service.search(user, input)).total).toBe(0);
    expect(noStore.calls).toHaveLength(0);
  });
  it('refuses over-budget estimates before execution with no historical MySQL fact fallback', async () => {
    const fixture = setup();
    fixture.estimate.mockResolvedValue(BigInt(config.BIGQUERY_MAX_BYTES_BILLED) + 1n);
    await expect(fixture.service.search(user, input)).rejects.toMatchObject({
      code: 'CUSTOMER_FEEDBACK_PROJECTION_REQUIRED',
    });
    expect(fixture.calls).toHaveLength(0);
    expect(fixture.dimensions.enrich).not.toHaveBeenCalled();
  });
  it('does not return contacts after email membership or store authority changes', async () => {
    const fixture = setup();
    fixture.dimensions.emailCustomers.mockResolvedValueOnce(['7']).mockResolvedValueOnce(['8']);
    await expect(fixture.service.search(user, input)).rejects.toMatchObject({
      code: 'CUSTOMER_FEEDBACK_DIMENSION_CHANGED',
    });
    const revoked = setup();
    revoked.dimensions.authorize
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new AppError(403, 'STORE_ACCESS_DENIED', 'Fixture revoked.'));
    await expect(revoked.service.search(user, input)).rejects.toMatchObject({
      code: 'STORE_ACCESS_DENIED',
    });
    expect(revoked.dimensions.enrich).not.toHaveBeenCalled();
  });
  it('retains joined recordsTotal and source out-of-range page fallback without dropping duplicate rows', async () => {
    const fixture = setup();
    fixture.response.total = '2';
    const result = await fixture.service.search(user, { ...input, page: 999, pageSize: 1 });
    expect(result).toMatchObject({ total: 2, page: 1, totalPages: 2 });
    expect(result.data).toHaveLength(1);
    expect(fixture.calls[0]!.params).toMatchObject({ page: 999, pageSize: 1 });
  });
  it('rejects contradictory warehouse paging/contracts before exposing dimensions', async () => {
    const fixture = setup();
    fixture.response.items = [];
    await expect(fixture.service.search(user, input)).rejects.toMatchObject({
      code: 'CUSTOMER_FEEDBACK_DATA_INVALID',
    });
    expect(fixture.dimensions.enrich).not.toHaveBeenCalled();
    const page = setup();
    page.response.page = 2;
    await expect(page.service.search(user, input)).rejects.toMatchObject({
      code: 'CUSTOMER_FEEDBACK_DATA_INVALID',
    });
  });
  it('rejects a projection returning another store, email owner or date before reading contacts', async () => {
    for (const change of [
      { associatedStoreId: '2' },
      { customerId: '8' },
      { orderDate: '2026-11-14 12:00:00' },
    ]) {
      const fixture = setup();
      fixture.response.items = [{ ...fact, ...change }];
      await expect(fixture.service.search(user, input)).rejects.toMatchObject({
        code: 'CUSTOMER_FEEDBACK_DATA_INVALID',
      });
      expect(fixture.dimensions.enrich).not.toHaveBeenCalled();
    }
  });
});
