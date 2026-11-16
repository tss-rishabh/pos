import { Temporal } from '@js-temporal/polyfill';
import { and, desc, eq, gt, gte, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { MUser, Order, OrderStore, Store } from '../../db/legacy-schema.js';
import { requireStore, type Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { routeRead } from '../../domain/routing.js';
import { warehouseService } from '../warehouse.js';
import { NpsFeedback, NpsQuestion } from './feedback-schema.js';
import { maskCustomerEmail, maskCustomerName, maskCustomerPhone } from './privacy.js';
import { feedbackHistoryOptions } from './feedback-history-options.js';
import { feedbackHistoricalSearch, type FeedbackHistoryDependencies } from './feedback-history.js';

const scalar = z
    .union([z.string().regex(/^\d+$/), z.number().int().refine(Number.isSafeInteger), z.bigint()])
    .transform(String),
  timestamp = z.string().transform((value) => value.replace('T', ' ').slice(0, 19));
const rawSchema = z.object({
  orderId: scalar,
  storeId: scalar.nullable(),
  storeName: z.string().nullable(),
  firstName: z.string().nullable(),
  email: z.string().nullable(),
  telephone: z.string().nullable(),
  feedback: z.union([z.string(), z.number(), z.null()]),
  question: z.string().nullable(),
  feedbackDate: timestamp.nullable(),
  orderDate: timestamp,
});
export type FeedbackRecord = z.infer<typeof rawSchema>;
export interface FeedbackInput {
  from: string;
  to: string;
  storeIds?: string[];
  orderIds?: string[];
  email?: string;
  page: number;
  pageSize: number;
}
export function feedbackOptions(env: NodeJS.ProcessEnv = process.env) {
  return feedbackHistoryOptions(env);
}
export function feedbackRows(rows: FeedbackRecord[], userType: 1 | 2) {
  return rows.map((row) => ({
    order_id: row.orderId,
    storeId: row.storeId,
    name: userType === 2 ? maskCustomerName(row.firstName) : row.firstName,
    email: userType === 2 ? maskCustomerEmail(row.email) : row.email,
    telephone: userType === 2 ? maskCustomerPhone(row.telephone) : row.telephone,
    feedback: row.feedback,
    question: row.question,
    store_name: row.storeName || 'Online Orders',
    feedback_date: row.feedbackDate,
    order_date: row.orderDate,
  }));
}
export function customerFeedbackService(
  config: Config,
  db: Databases,
  options: ReturnType<typeof feedbackOptions> = feedbackOptions(),
  warehouse: Pick<ReturnType<typeof warehouseService>, 'queryReport'> = warehouseService(config),
  clock = () => Temporal.Now.instant(),
  dependencies: FeedbackHistoryDependencies = {},
) {
  const historical = feedbackHistoricalSearch(config, db, options, warehouse, dependencies);
  return {
    async search(user: Principal, input: FeedbackInput) {
      const start = Temporal.PlainDateTime.from(input.from),
        end = Temporal.PlainDateTime.from(input.to);
      if (Temporal.PlainDateTime.compare(end, start) < 0)
        throw new AppError(400, 'INVALID_DATE_RANGE', 'The To time precedes the From time.');
      const range = {
          start: start.toZonedDateTime(config.BUSINESS_TIMEZONE).toInstant().toString(),
          end: end
            .add({ seconds: 1 })
            .toZonedDateTime(config.BUSINESS_TIMEZONE)
            .toInstant()
            .toString(),
        },
        reader = routeRead({ kind: 'report', range }, clock(), config.BUSINESS_TIMEZONE),
        storeIds = input.storeIds?.length
          ? [...new Set(input.storeIds)]
          : user.role === 1 && user.userType === 1
            ? undefined
            : user.storeIds;
      storeIds?.forEach((id) => requireStore(user, id));
      const empty = { reader, data: [], total: 0, page: 1, totalPages: 0 };
      if (storeIds?.length === 0 || (user.userType === 2 && !input.storeIds?.length)) return empty;
      const from = start.toString({ smallestUnit: 'second' }).replace('T', ' '),
        to = end.toString({ smallestUnit: 'second' }).replace('T', ' ');
      let total: number, page: number, totalPages: number, rows: FeedbackRecord[];
      if (reader === 'bigquery') {
        const result = await historical(user, input, storeIds, from, to);
        return {
          ...result,
          data: feedbackRows(z.array(rawSchema).parse(result.data), user.userType),
        };
      } else {
        const database = db.get('data'),
          condition = and(
            gt(NpsFeedback.orderId, 0n),
            gte(Order.created_at, from),
            lte(Order.created_at, to),
            storeIds ? inArray(Store.id, storeIds.map(BigInt)) : undefined,
            input.orderIds?.length
              ? inArray(NpsFeedback.orderId, input.orderIds.map(BigInt))
              : undefined,
            input.email ? eq(MUser.email, input.email) : undefined,
          );
        const projection = {
          orderId: Order.id,
          storeId: Store.id,
          storeName: Store.store_name,
          firstName: MUser.firstname,
          email: MUser.email,
          telephone: MUser.telephone,
          feedback: NpsFeedback.feedback,
          question: NpsQuestion.question,
          feedbackDate: NpsFeedback.createdAt,
          orderDate: Order.created_at,
        };
        const base = () =>
          database
            .select(projection)
            .from(NpsFeedback)
            .leftJoin(Order, eq(Order.id, NpsFeedback.orderId))
            .leftJoin(OrderStore, eq(OrderStore.order, Order.id))
            .leftJoin(Store, eq(Store.id, OrderStore.store))
            .leftJoin(MUser, eq(MUser.id, Order.user))
            .leftJoin(NpsQuestion, eq(NpsQuestion.id, NpsFeedback.questionId))
            .where(condition);
        // Keep the identical join multiplicity while counting without selecting contacts.
        const [count] = await database
          .select({ count: sql<number>`count(*)` })
          .from(NpsFeedback)
          .leftJoin(Order, eq(Order.id, NpsFeedback.orderId))
          .leftJoin(OrderStore, eq(OrderStore.order, Order.id))
          .leftJoin(Store, eq(Store.id, OrderStore.store))
          .leftJoin(MUser, eq(MUser.id, Order.user))
          .leftJoin(NpsQuestion, eq(NpsQuestion.id, NpsFeedback.questionId))
          .where(condition);
        total = Number(count?.count || 0);
        totalPages = Math.ceil(total / input.pageSize);
        page = input.page > totalPages ? 1 : input.page;
        rows = z.array(rawSchema).parse(
          await base()
            .orderBy(desc(Order.id))
            .limit(input.pageSize)
            .offset((page - 1) * input.pageSize),
        );
      }
      return { reader, data: feedbackRows(rows, user.userType), total, page, totalPages };
    },
  };
}
