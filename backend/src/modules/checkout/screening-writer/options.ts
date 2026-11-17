import { z } from 'zod';
import { nodeScreeningWriterContract } from './capability.js';

/** Verification/publication configuration is independent of new admission. */
export interface PublicScreeningOptions {
  contract?: typeof nodeScreeningWriterContract;
  proofKey?: string;
  publicationUrl?: string;
  publicationKey?: string;
  publicationContract?: 'pos-node-screening-publication-resource-v1';
  negativeUrl?: string;
  negativeKey?: string;
  negativeContract?: 'pos-node-screening-negative-resource-v1';
  clock?: () => number;
  fetcher?: typeof fetch;
}
export function publicScreeningOptions(
  env: NodeJS.ProcessEnv = process.env,
): PublicScreeningOptions {
  const optional = <T extends z.ZodType>(schema: T) =>
    z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
  const value = z
    .object({
      UPSTREAM_POS_NODE_SCREENING_WRITER_CONTRACT: optional(z.literal(nodeScreeningWriterContract)),
      TSS_POS_LEGACY_IMPORT_PROOF_KEY: optional(z.string().regex(/^[!-~]{32,4096}$/)),
      TSS_POS_PUBLIC_SCREENING_PUBLICATION_URL: optional(z.url()),
      TSS_POS_PUBLIC_SCREENING_PUBLICATION_KEY: optional(z.string().regex(/^[!-~]{32,4096}$/)),
      UPSTREAM_POS_PUBLIC_SCREENING_PUBLICATION_CONTRACT: optional(
        z.literal('pos-node-screening-publication-resource-v1'),
      ),
      TSS_POS_PUBLIC_SCREENING_NEGATIVE_URL: optional(z.url()),
      TSS_POS_PUBLIC_SCREENING_NEGATIVE_KEY: optional(z.string().regex(/^[!-~]{32,4096}$/)),
      UPSTREAM_POS_PUBLIC_SCREENING_NEGATIVE_CONTRACT: optional(
        z.literal('pos-node-screening-negative-resource-v1'),
      ),
    })
    .parse(env);
  return {
    contract: value.UPSTREAM_POS_NODE_SCREENING_WRITER_CONTRACT,
    proofKey: value.TSS_POS_LEGACY_IMPORT_PROOF_KEY,
    publicationUrl: value.TSS_POS_PUBLIC_SCREENING_PUBLICATION_URL,
    publicationKey: value.TSS_POS_PUBLIC_SCREENING_PUBLICATION_KEY,
    publicationContract: value.UPSTREAM_POS_PUBLIC_SCREENING_PUBLICATION_CONTRACT,
    negativeUrl: value.TSS_POS_PUBLIC_SCREENING_NEGATIVE_URL,
    negativeKey: value.TSS_POS_PUBLIC_SCREENING_NEGATIVE_KEY,
    negativeContract: value.UPSTREAM_POS_PUBLIC_SCREENING_NEGATIVE_CONTRACT,
  };
}
