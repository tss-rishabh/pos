import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import type { Principal } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import type { CustomerVerificationClient } from '../customer-verification.js';
import { localReturnVerificationService } from './local-verification.js';
import type { ReturnState } from './state.js';
export { returnVerificationSchema } from './verification-state.js';

export interface ReturnVerificationOptions {
  customerOtp?: CustomerVerificationClient;
  assertCheckIn?: (
    userId: string,
    storeId: string,
    counterId: string,
    transaction: AdministrationTransaction,
  ) => Promise<void>;
  now?: () => number;
  state: ReturnState;
}

/**
 * Return customer verification. Only the purpose-bound customer-otp delivery exists; without it
 * every call refuses (the old in-module OTP fallback had no deliverable channel and is removed,
 * together with its `pos_rewrite_return_verification_limits` budget — customer-otp owns limits).
 */
export function returnVerificationService(
  db: Databases,
  config: Config,
  options: ReturnVerificationOptions,
) {
  if (options.customerOtp)
    return localReturnVerificationService(db, config, {
      ...options,
      customerOtp: options.customerOtp,
    });
  const unavailable = async (..._args: unknown[]): Promise<never> => {
    throw new AppError(
      503,
      'CUSTOMER_OTP_UNAVAILABLE',
      'Customer verification requires configured secure delivery.',
    );
  };
  return {
    create: unavailable as (
      user: Principal,
      storeId: string,
      orderId: string,
      id: string,
      counterId: string,
    ) => Promise<never>,
    read: unavailable as (user: Principal, storeId: string, id: string) => Promise<never>,
    reconcile: unavailable as (
      user: Principal,
      storeId: string,
      id: string,
      operationId: string,
    ) => Promise<never>,
    verify: unavailable as (
      user: Principal,
      storeId: string,
      id: string,
      operationId: string,
      code: string,
    ) => Promise<never>,
    lines: unavailable as (
      user: Principal,
      storeId: string,
      id: string,
      after?: string,
    ) => Promise<never>,
  };
}
