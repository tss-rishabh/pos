import { and, eq, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { MUser } from '../../db/legacy-schema.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import { currentRequestTrace } from '../../observability/context.js';
import { checkoutSessionStore } from '../checkout/session-store.js';
import { configuredStateStore } from '../checkout/state-store.js';
import { operationHash } from '../checkout/crypto.js';
import {
  assertCustomerContextReady,
  customerContextConfigured,
  type CustomerContextConfiguration,
} from '../checkout/customer-context.js';
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
import { customerProfileAdjustments } from './schema.js';

export function customerProfileAdjustmentService(
  config: Config,
  db: Databases,
  environment: CustomerContextConfiguration,
  clock: () => number = Date.now,
) {
  const withCheckout = customerCheckoutScope(config, db);
  const sessions = checkoutSessionStore(configuredStateStore(config));
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
    if (input) assertCustomerContextReady(environment);
    return withCheckout(user, scope, 'update', async (tx, state) => {
      const [existing] = await tx
        .select()
        .from(customerProfileAdjustments)
        .where(eq(customerProfileAdjustments.id, operationId))
        .limit(1)
        .for('update');
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
              ? { updated_at: new Date(clock()).toISOString().slice(0, 19).replace('T', ' ') }
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
        await tx.insert(customerProfileAdjustments).values({
          id: operationId,
          operatorId: user.id,
          storeId: scope.storeId,
          checkoutId: scope.checkoutId,
          customerId: state.customerId,
          requestHash: requestHash!,
          checkoutVersion: version,
          receipt: applied,
          requestId: currentRequestTrace()?.requestId ?? null,
          createdAt: applied.appliedAt.slice(0, 23).replace('T', ' '),
        });
        // W4: the sale lives in the Redis session store; replace it only at the read version.
        await sessions.replaceIfVersion(
          { ...state, version, phase: 'open', quote: null, updatedAt: clock() },
          state.version,
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
          editable: customerProfileEditable(state) && customerContextConfigured(environment),
          profile: value,
        }),
      });
    });
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
