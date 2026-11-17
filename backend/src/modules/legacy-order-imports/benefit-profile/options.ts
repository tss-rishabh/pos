import { z } from 'zod';
import { AppError } from '../../../domain/errors.js';
import { importFinancialError } from '../financial-adapter-crypto.js';
import type { FinancialImportProfileHooks } from '../financial-adapter-profiles.js';
import type { LegacyImportFinancialOptions } from '../financial-adapter-options.js';
import { automaticCouponContract, complementaryContract } from './contracts.js';
import type { CsvBenefitProfileOptions } from './adapter.js';

/** Independent blank-by-default profile selection. Existing descriptors remain
 * mandatory even when current selection is absent or invalid. */
export function configuredCsvImportBenefits(
  financial: Pick<LegacyImportFinancialOptions, 'sourceProofKey'>,
  environment: NodeJS.ProcessEnv,
) {
  const optional = <T extends z.ZodType>(schema: T) =>
      z.preprocess((value) => (value === '' ? undefined : value), schema.optional()),
    parsed = z
      .object({
        POS_LEGACY_IMPORT_AUTOMATIC_COUPON_CONTRACT: optional(z.literal(automaticCouponContract)),
        POS_LEGACY_IMPORT_COMPLEMENTARY_CONTRACT: optional(z.literal(complementaryContract)),
      })
      .safeParse(environment);
  try {
    if (!parsed.success)
      throw importFinancialError('ORDER_IMPORT_BENEFIT_CONFIGURATION_REQUIRED', 503);
    const value = parsed.data;
    if (
      (value.POS_LEGACY_IMPORT_AUTOMATIC_COUPON_CONTRACT ||
        value.POS_LEGACY_IMPORT_COMPLEMENTARY_CONTRACT) &&
      !z
        .string()
        .regex(/^[!-~]{32,4096}$/)
        .safeParse(financial.sourceProofKey).success
    )
      throw importFinancialError('ORDER_IMPORT_BENEFIT_CONFIGURATION_REQUIRED', 503);
    const options: CsvBenefitProfileOptions = {
      sourceProofKey: financial.sourceProofKey ?? '',
      ...(value.POS_LEGACY_IMPORT_AUTOMATIC_COUPON_CONTRACT
        ? { automaticCoupon: value.POS_LEGACY_IMPORT_AUTOMATIC_COUPON_CONTRACT }
        : {}),
      ...(value.POS_LEGACY_IMPORT_COMPLEMENTARY_CONTRACT
        ? { complementary: value.POS_LEGACY_IMPORT_COMPLEMENTARY_CONTRACT }
        : {}),
    };
    return { ready: true, options, guard: undefined };
  } catch (error: unknown) {
    if (!(error instanceof AppError) || error.status !== 503) throw error;
    const deny = () => {
        throw importFinancialError('ORDER_IMPORT_BENEFIT_CONFIGURATION_REQUIRED', 503);
      },
      denyAsync = async () => deny(),
      guard: FinancialImportProfileHooks = {
        requiresCurrentReads: true,
        assertReady: deny,
        lock: denyAsync,
        dispatch: denyAsync,
        sourceReceipt: denyAsync,
        expectedQuantities: denyAsync,
        completionSnapshot: denyAsync,
        benefitSnapshot: denyAsync,
        qualifiedBenefits: denyAsync,
      };
    return {
      ready: false,
      options: { sourceProofKey: financial.sourceProofKey ?? '' } as CsvBenefitProfileOptions,
      guard,
    };
  }
}
