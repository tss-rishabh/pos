import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Databases } from '../../db/pools.js';
import { MUser, PosUser, Store, UserStore } from '../../db/legacy-schema.js';
import type { Principal } from '../../domain/access.js';
import { requireStore } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { NpsQuestion } from './feedback-schema.js';
import { feedbackDimensionLimit, type FeedbackFact } from './feedback-history-contracts.js';
import type { FeedbackRecord } from './feedback.js';

export interface CurrentFeedbackDimensions {
  authorize(user: Principal, stores: readonly string[] | undefined): Promise<void>;
  emailCustomers(email: string): Promise<string[]>;
  knownStores(stores: readonly string[]): Promise<string[]>;
  enrich(facts: readonly FeedbackFact[]): Promise<FeedbackRecord[]>;
}
const tooWide = () =>
  new AppError(422, 'CUSTOMER_FEEDBACK_DIMENSION_TOO_WIDE', 'Choose a narrower feedback filter.');
function uniqueBounded(values: readonly string[]) {
  const unique = [...new Set(values)];
  if (unique.length > feedbackDimensionLimit) throw tooWide();
  return unique;
}

/** Current mutable dimensions only. No historical fact table is read through MySQL. */
export function currentFeedbackDimensions(db: Databases): CurrentFeedbackDimensions {
  return {
    async authorize(user, stores) {
      if (stores === undefined && !(user.role === 1 && user.userType === 1))
        throw new AppError(403, 'STORE_ACCESS_DENIED', 'Choose an authorized store.');
      const selected = stores === undefined ? undefined : uniqueBounded(stores);
      selected?.forEach((id) => requireStore(user, id));
      await db.get('writer').transaction(async (tx) => {
        const [operator] = await tx
          .select({ active: PosUser.is_active, role: PosUser.role, userType: PosUser.user_type })
          .from(PosUser)
          .where(eq(PosUser.id, BigInt(user.id)))
          .limit(1)
          .for('share');
        if (!operator?.active) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
        if (operator.role !== user.role || operator.userType !== user.userType)
          throw new AppError(
            409,
            'OPERATOR_CHANGED',
            'The signed-in operator changed. Sign in before continuing.',
          );
        if (user.role === 1 && user.userType === 1) return;
        if (!selected?.length) return;
        const assigned = await tx
            .select({ id: sql<string>`CAST(${UserStore.store_id} AS CHAR)` })
            .from(UserStore)
            .where(
              and(
                eq(UserStore.django_user_id, BigInt(user.id)),
                inArray(UserStore.store_id, selected.map(BigInt)),
              ),
            )
            .for('share'),
          allowed = new Set(assigned.map((row) => row.id));
        if (selected.some((id) => !allowed.has(id)))
          throw new AppError(403, 'STORE_ACCESS_DENIED', 'You do not have access to this store.');
        if (user.userType === 2) {
          const franchise = await tx
              .select({ id: Store.id })
              .from(Store)
              .where(and(inArray(Store.id, selected.map(BigInt)), eq(Store.category, 'FRANCHISE')))
              .for('share'),
            franchiseIds = new Set(franchise.map((row) => String(row.id)));
          if (selected.some((id) => !franchiseIds.has(id)))
            throw new AppError(403, 'STORE_ACCESS_DENIED', 'You do not have access to this store.');
        }
      });
    },
    async emailCustomers(email) {
      const rows = await db
        .get('primary')
        .select({ id: MUser.id })
        .from(MUser)
        .where(eq(MUser.email, email))
        .limit(feedbackDimensionLimit + 1);
      if (rows.length > feedbackDimensionLimit) throw tooWide();
      return rows.map((row) => String(row.id));
    },
    async knownStores(stores) {
      const ids = uniqueBounded(stores);
      if (!ids.length) return [];
      return (
        await db
          .get('primary')
          .select({ id: Store.id })
          .from(Store)
          .where(inArray(Store.id, ids.map(BigInt)))
      ).map((row) => String(row.id));
    },
    async enrich(facts) {
      if (facts.length > feedbackDimensionLimit) throw tooWide();
      const customerIds = uniqueBounded(
          facts.flatMap((row) => (row.customerId === null ? [] : [row.customerId])),
        ),
        storeIds = uniqueBounded(
          facts.flatMap((row) => (row.associatedStoreId === null ? [] : [row.associatedStoreId])),
        ),
        questionIds = uniqueBounded(
          facts.flatMap((row) => (row.questionId === null ? [] : [row.questionId])),
        ),
        primary = db.get('primary');
      const [customers, stores, questions] = await Promise.all([
          customerIds.length
            ? primary
                .select({
                  id: MUser.id,
                  firstName: MUser.firstname,
                  email: MUser.email,
                  telephone: MUser.telephone,
                })
                .from(MUser)
                .where(inArray(MUser.id, customerIds.map(BigInt)))
            : Promise.resolve([]),
          storeIds.length
            ? primary
                .select({ id: Store.id, name: Store.store_name })
                .from(Store)
                .where(inArray(Store.id, storeIds.map(BigInt)))
            : Promise.resolve([]),
          questionIds.length
            ? primary
                .select({ id: NpsQuestion.id, question: NpsQuestion.question })
                .from(NpsQuestion)
                .where(inArray(NpsQuestion.id, questionIds.map(Number)))
            : Promise.resolve([]),
        ]),
        customerMap = new Map(customers.map((row) => [String(row.id), row])),
        storeMap = new Map(stores.map((row) => [String(row.id), row])),
        questionMap = new Map(questions.map((row) => [String(row.id), row]));
      return facts.map((row) => {
        const customer = row.customerId === null ? undefined : customerMap.get(row.customerId),
          store = row.associatedStoreId === null ? undefined : storeMap.get(row.associatedStoreId);
        return {
          orderId: row.orderId,
          storeId: store ? String(store.id) : null,
          storeName: store?.name ?? null,
          firstName: customer?.firstName ?? null,
          email: customer?.email ?? null,
          telephone: customer?.telephone ?? null,
          feedback: row.feedback,
          question:
            row.questionId === null ? null : (questionMap.get(row.questionId)?.question ?? null),
          feedbackDate: row.feedbackDate,
          orderDate: row.orderDate,
        };
      });
    },
  };
}
