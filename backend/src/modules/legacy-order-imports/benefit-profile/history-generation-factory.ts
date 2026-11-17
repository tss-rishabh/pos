import type { Databases } from '../../../db/pools.js';
import { couponWarehouseKeys } from './history-warehouse-contracts.js';
import { generationError } from './history-generation-contracts.js';
import { generationOptionsSchema, type GenerationOptions } from './history-generation-options.js';
import { generationJournal } from './history-generation-journal.js';
import { couponGenerationSource, type GenerationSourcePort } from './history-generation-source.js';
import { couponGenerationCandidate } from './history-generation-candidate.js';
import { couponGenerationPublisher } from './history-generation-publisher.js';
import {
  couponGenerationWorker,
  type GenerationWorkerOptions,
} from './history-generation-worker.js';
import {
  generationControlHttp,
  type GenerationControlHttpOptions,
} from './history-generation-control-http.js';
import type { GenerationSourceOrigin } from './history-generation-origin.js';
import type { GenerationControlPort } from './history-generation-control.js';
import type { GenerationAuthority } from './history-generation-runtime.js';
import type { GenerationWritePort } from './history-generation-writer.js';
import type { GenerationDependencies } from './history-generation-read.js';
/** Explicit background process composition. No credentials, connection, SDK,
 * source resource, native counts or timers are touched during construction.
 * Missing new-work dependencies still permit retained original-job recovery. */
export function couponGenerationPublishingRuntime(
  supplied: GenerationOptions,
  authority: GenerationAuthority & { journalKey: string },
  dependencies: {
    db: Pick<Databases, 'get'>;
    origin?: GenerationSourceOrigin;
    source?: GenerationSourcePort;
    sourceOptions?: Parameters<typeof couponGenerationSource>[2];
    control?: GenerationControlPort;
    controlHttp?: GenerationControlHttpOptions;
    writer?: GenerationWritePort;
    newWorkEnabled?: () => boolean;
    worker?: Partial<GenerationWorkerOptions>;
    query?: GenerationDependencies;
    clock?: () => number;
  },
) {
  const parsed = generationOptionsSchema.safeParse(supplied);
  if (!parsed.success) throw generationError('CONFIGURATION', 503);
  couponWarehouseKeys(
    authority.sourceKey,
    authority.publicationKey,
    authority.historyKey,
    authority.journalKey,
  );
  const options = parsed.data,
    clock = dependencies.clock ?? Date.now;
  let source = dependencies.source;
  if (!source && dependencies.origin) {
    if (!options.comparisonFingerprint || !options.sourceTimeZone)
      throw generationError('CONFIGURATION', 503);
    source = couponGenerationSource(
      dependencies.origin,
      {
        sourceKey: authority.sourceKey,
        comparisonFingerprint: options.comparisonFingerprint,
        sourceTimeZone: options.sourceTimeZone,
      },
      { ...dependencies.sourceOptions, clock },
    );
  }
  source ??= {
    async capture() {
      throw generationError('ORIGIN_REQUIRED', 503);
    },
  };
  const control =
    dependencies.control ??
    (dependencies.controlHttp
      ? generationControlHttp(
          dependencies.controlHttp,
          {
            sourceKey: authority.sourceKey,
            separateFrom: [authority.publicationKey, authority.historyKey, authority.journalKey],
          },
          { clock },
        )
      : undefined);
  const journal = generationJournal(dependencies.db, authority, clock),
    candidate = couponGenerationCandidate(options, authority, { ...dependencies.query, clock });
  const publisher = couponGenerationPublisher(options, authority, {
    source,
    journal,
    candidate,
    control,
    writer: dependencies.writer,
    newWorkEnabled: dependencies.newWorkEnabled,
    clock,
  });
  const worker = couponGenerationWorker(publisher, journal, dependencies.worker);
  return { publisher, worker };
}
