import { z } from 'zod';
import { AppError } from '../../../domain/errors.js';
import type { CheckoutEnvironment } from '../gateway.js';
import type { PublicScreeningOptions } from './options.js';
import { publicScreeningBenefitsContract } from './benefit-contracts.js';
import {
  publicBenefitPreparation,
  publicBenefitPreparationContract,
  type PublicBenefitPreparationPort,
} from './benefit-preparation.js';
import {
  publicMembershipBigQueryHistory,
  readPublicMembershipBigQueryOptions,
  type PublicMembershipHistoryPort,
} from './membership-history.js';

export function readPublicBenefitPreparationOptions(env: NodeJS.ProcessEnv = process.env) {
  const optional = <T extends z.ZodType>(schema: T) =>
    z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
  const key = z.string().regex(/^[!-~]{32,4096}$/);
  return z
    .object({
      UPSTREAM_POS_PUBLIC_SCREENING_PREPARATION_CONTRACT: optional(
        z.literal(publicBenefitPreparationContract),
      ),
      TSS_POS_PUBLIC_SCREENING_PREPARATION_URL: optional(z.url()),
      TSS_POS_PUBLIC_SCREENING_PREPARATION_KEY: optional(key),
      PUBLIC_SCREENING_MEMBERSHIP_HISTORY_KEY: optional(key),
      PUBLIC_SCREENING_MEMBERSHIP_PUBLICATION_KEY: optional(key),
      POS_MEMBERSHIP_PRODUCT_IDS: z.string().max(32000).default('[]'),
    })
    .parse(env);
}
/** App composition hook. Missing BQ configuration is consulted only when the
 * literal private source preview actually requests qualified membership facts. */
export function configuredPublicBenefitPreparation(
  environment: CheckoutEnvironment,
  publicOptions: PublicScreeningOptions,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: {
    history?: PublicMembershipHistoryPort;
    fetcher?: typeof fetch;
    clock?: () => number;
  } = {},
): PublicBenefitPreparationPort | undefined {
  if (publicOptions.benefitsContract !== publicScreeningBenefitsContract) return undefined;
  try {
    const options = readPublicBenefitPreparationOptions(env);
    const ids: unknown = JSON.parse(options.POS_MEMBERSHIP_PRODUCT_IDS) as unknown;
    const members = z
      .array(z.string().regex(/^[1-9]\d{0,18}$/))
      .max(100)
      .parse(ids);
    const history: PublicMembershipHistoryPort = dependencies.history ?? {
      read(request, head, call) {
        return publicMembershipBigQueryHistory(
          readPublicMembershipBigQueryOptions(env),
          {
            sourceKey: publicOptions.proofKey ?? '',
            publicationKey: options.PUBLIC_SCREENING_MEMBERSHIP_PUBLICATION_KEY ?? '',
            historyKey: options.PUBLIC_SCREENING_MEMBERSHIP_HISTORY_KEY ?? '',
            memberIds: members,
          },
          { clock: dependencies.clock },
        ).read(request, head, call);
      },
    };
    return publicBenefitPreparation(
      {
        contract: options.UPSTREAM_POS_PUBLIC_SCREENING_PREPARATION_CONTRACT,
        url: options.TSS_POS_PUBLIC_SCREENING_PREPARATION_URL,
        key: options.TSS_POS_PUBLIC_SCREENING_PREPARATION_KEY,
        sourceKey: publicOptions.proofKey,
        historyKey: options.PUBLIC_SCREENING_MEMBERSHIP_HISTORY_KEY,
        customerContextKey: environment.customerContextKey,
        membershipProofKey: publicOptions.membershipProofKey,
      },
      { ...dependencies, history },
    );
  } catch {
    // Configuration for NEW preparation cannot disable retained GET/payment
    // evidence recovery. A selected but invalid adapter still refuses every
    // new preparation; it never falls back to the old source writer.
    return {
      async prepare() {
        throw new AppError(
          503,
          'SCREENING_BENEFITS_UNAVAILABLE',
          'Screening benefit preparation is unavailable. Keep the original sale reference for recovery.',
        );
      },
    };
  }
}
