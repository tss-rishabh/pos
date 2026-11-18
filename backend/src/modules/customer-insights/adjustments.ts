import { and, eq, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { MUser } from '../../db/legacy-schema.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import { checkoutSessions } from '../checkout/schema.js';
import { operationHash } from '../checkout/crypto.js';
import type { OrderRedis } from '../fulfillment/order-redis.js';
import { contactWallTime } from '../customer-contacts/authority.js';
import {
  customerCheckoutScope,
  customerProfileEditable,
  missingCustomerProfile,
} from './checkout-scope.js';
import {
  customerProfileAdjustmentInput,
  customerProfileAdjustmentReceipt,
  customerProfileAdjustmentResponse,
  customerProfileField,
  customerProfileSchema,
  customerProfileScope,
  type CustomerProfileAdjustmentInput,
  type CustomerProfileScope,
} from './contracts.js';
import {
  customerProfileEtag,
  customerProfileSelection,
  customerProfileValue,
} from './profile-value.js';

/**
 * Lost-response replay receipt (table-disposition.md customer-insights: the rewrite-only
 * `pos_rewrite_customer_profile_adjustments` table moves to Redis). The profile values land
 * in `users` exactly as legacy (users/views.py:665-690, 1050-1075); legacy keeps no audit row.
 * `pos:customer_profile_adjustment:{operationId}` → JSON {operatorId, storeId, checkoutId,
 * customerId, requestHash, checkoutVersion, receipt}, SET NX EX 86400, written after commit.
 */
export const profileAdjustmentKey = (operationId: string) =>
  `pos:customer_profile_adjustment:${operationId}`;
const savedAdjustment = z
  .object({
    operatorId: z.string(),
    storeId: z.string(),
    checkoutId: z.string(),
    customerId: z.string(),
    requestHash: z.string(),
    checkoutVersion: z.number().int(),
    receipt: z.unknown(),
  })
  .strict();
type SavedAdjustment = z.infer<typeof savedAdjustment>;

export function customerProfileAdjustmentService(
  config: Config,
  db: Databases,
  redis: OrderRedis,
  clock: () => number = Date.now,
) {
  const withCheckout = customerCheckoutScope(config, db);
  async function saved(operationId: string): Promise<SavedAdjustment | undefined> {
    const raw = await redis.get(profileAdjustmentKey(operationId));
    if (raw === null) return undefined;
    let value: unknown = null;
    try {
      value = JSON.parse(raw);
    } catch {
      /* handled below */
    }
    const parsed = savedAdjustment.safeParse(value);
    if (!parsed.success) throw receiptUnavailable();
    return parsed.data;
  }
  function assertScopeIdentifiers(user: Principal, scope: CustomerProfileScope) {
    identifier.parse(user.id);
    customerProfileScope.parse(scope);
  }
  function receiptUnavailable(): AppError {
    return new AppError(
      503,
      'CUSTOMER_PROFILE_PROOF_INVALID',
      'The saved profile update requires review.',
    );
  }
  async function command(
    user: Principal,
    scope: CustomerProfileScope,
    operationId: string,
    input?: CustomerProfileAdjustmentInput,
  ) {
    assertScopeIdentifiers(user, scope);
    z.uuid().parse(operationId);
    let record: SavedAdjustment | undefined;
    const response = await withCheckout(user, scope, 'update', async (tx, state) => {
      const existing = await saved(operationId);
      const requestHash = input
        ? operationHash(
            'customer-profile-adjustment',
            {
              operatorId: user.id,
              ...scope,
              input,
            },
            config.SESSION_SECRET,
          )
        : null;
      if (
        existing &&
        (existing.operatorId !== user.id ||
          existing.storeId !== scope.storeId ||
          existing.checkoutId !== scope.checkoutId ||
          existing.customerId !== state.customerId)
      )
        throw new AppError(
          404,
          'CUSTOMER_PROFILE_ADJUSTMENT_NOT_FOUND',
          'This profile update was not found.',
        );
      if (existing && requestHash && existing.requestHash !== requestHash)
        throw new AppError(
          409,
          'CUSTOMER_PROFILE_OPERATION_REUSED',
          'Use the saved intent for this profile update.',
        );
      if (!existing && !input)
        throw new AppError(
          404,
          'CUSTOMER_PROFILE_ADJUSTMENT_NOT_FOUND',
          'This profile update was not found.',
        );
      const [row] = await tx
        .select({ id: MUser.id, ...customerProfileSelection })
        .from(MUser)
        .where(
          and(
            eq(MUser.id, BigInt(state.customerId)),
            eq(MUser.status, 1),
            or(isNull(MUser.is_block), eq(MUser.is_block, 0)),
          ),
        )
        .limit(1)
        .for('update');
      if (!row) throw missingCustomerProfile();
      let value = customerProfileValue(row);
      let version = state.version;
      let receipt = existing ? customerProfileAdjustmentReceipt.safeParse(existing.receipt) : null;
      if (
        existing &&
        (!receipt?.success ||
          receipt.data.operationId !== operationId ||
          receipt.data.customerId !== state.customerId ||
          receipt.data.checkoutVersion !== existing.checkoutVersion)
      )
        throw receiptUnavailable();
      if (!existing && input) {
        if (!customerProfileEditable(state))
          throw new AppError(
            409,
            'CUSTOMER_PROFILE_NOT_EDITABLE',
            'This sale is busy or already submitted.',
          );
        if (state.version !== input.expectedVersion)
          throw new AppError(
            409,
            'CUSTOMER_PROFILE_VERSION_CHANGED',
            'This sale changed. Refresh before editing customer details.',
          );
        const beforeEtag = customerProfileEtag(value);
        if (beforeEtag !== input.expectedEtag)
          throw new AppError(
            409,
            'CUSTOMER_PROFILE_CHANGED',
            'Customer details changed. Reload them before saving.',
          );
        const changes = input.changes;
        if (
          (changes.customerType !== undefined || changes.gstin !== undefined) &&
          (changes.customerType ?? value.customerType) === 'B2B' &&
          !/^[0-9A-Z]{15}$/.test(changes.gstin ?? value.gstin ?? '')
        )
          throw new AppError(
            422,
            'CUSTOMER_PROFILE_GSTIN_REQUIRED',
            'Enter a 15 character GSTIN for a business customer.',
          );
        // This endpoint intentionally excludes name/contact/login, money and
        // eligibility fields. Dates map only to verified native DATE columns.
        await tx
          .update(MUser)
          .set({
            ...(changes.birthday !== undefined ? { birthdate: changes.birthday } : {}),
            ...(changes.anniversary !== undefined ? { anniversary: changes.anniversary } : {}),
            ...(changes.gender !== undefined ? { gender: changes.gender } : {}),
            ...(changes.customerType !== undefined ? { customer_type: changes.customerType } : {}),
            ...(changes.gstin !== undefined ? { gstin: changes.gstin } : {}),
            ...(['birthday', 'anniversary', 'gender'].some((field) => field in changes)
              ? { updated_at: contactWallTime(clock(), config.BUSINESS_TIMEZONE) }
              : {}),
          })
          .where(eq(MUser.id, row.id));
        value = customerProfileValue({ ...value, ...changes });
        version++;
        const applied = customerProfileAdjustmentReceipt.parse({
          operationId,
          customerId: state.customerId,
          checkoutVersion: version,
          beforeEtag,
          etag: customerProfileEtag(value),
          fields: Object.entries(changes)
            .filter(([, field]) => field !== undefined)
            .map(([key]) => customerProfileField.parse(key)),
          appliedAt: new Date(clock()).toISOString(),
        });
        record = {
          operatorId: user.id,
          storeId: scope.storeId,
          checkoutId: scope.checkoutId,
          customerId: state.customerId,
          requestHash: requestHash!,
          checkoutVersion: version,
          receipt: applied,
        };
        await tx
          .update(checkoutSessions)
          .set({
            version,
            state: {
              ...state,
              version,
              phase: 'open',
              quote: null,
              updatedAt: clock(),
            },
          })
          .where(
            and(
              eq(checkoutSessions.id, scope.checkoutId),
              eq(checkoutSessions.version, state.version),
            ),
          );
        receipt = { success: true, data: applied };
      }
      if (!receipt?.success) throw receiptUnavailable();
      return customerProfileAdjustmentResponse.parse({
        adjustment: receipt.data,
        profile: customerProfileSchema.parse({
          customerId: state.customerId,
          checkoutVersion: version,
          etag: customerProfileEtag(value),
          editable: customerProfileEditable(state),
          profile: value,
        }),
      });
    });
    if (record)
      // A lost receipt only degrades replay: the etag check then refuses the stale intent.
      await redis
        .set(profileAdjustmentKey(operationId), JSON.stringify(record), { NX: true, EX: 86400 })
        .catch(() => false);
    return response;
  }
  return {
    apply(user: Principal, scope: CustomerProfileScope, value: unknown) {
      const input = customerProfileAdjustmentInput.parse(value);
      return command(user, scope, input.operationId, input);
    },
    read(user: Principal, scope: CustomerProfileScope, operationId: string) {
      return command(user, scope, operationId);
    },
  };
}
