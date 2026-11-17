import { Temporal } from '@js-temporal/polyfill';
import { originDigest, originError, sameOriginHash } from './contracts.js';
import { originHistoryKeys } from './history-contracts.js';
import {
  originCouponPreviewContract,
  originCouponPreviewRequestSchema,
  originCouponPreviewDocumentSchema,
  type OriginCouponPreviewRequest,
} from './coupon-preview-contracts.js';
import { verifyOriginCouponPublication } from './coupon-history.js';
import {
  generationScopeSchema,
  type GenerationFacts,
} from '../legacy-order-imports/benefit-profile/history-generation-contracts.js';
import {
  generationReadRunner,
  type GenerationDependencies,
} from '../legacy-order-imports/benefit-profile/history-generation-read.js';
import {
  generationOptionsSchema,
  requireGenerationOptions,
  type GenerationOptions,
} from '../legacy-order-imports/benefit-profile/history-generation-options.js';
/** Independent cart preview reader: never accepts or manufactures an order command. */
export function originCouponPreviewHistory(
  options: GenerationOptions,
  authority: { originKey: string; sourceKey: string; publicationKey: string },
  dependencies: GenerationDependencies & {
    demand?: { enqueue(request: OriginCouponPreviewRequest, signal: AbortSignal): Promise<void> };
  } = {},
) {
  const selected = generationOptionsSchema.parse(options);
  originHistoryKeys(authority.originKey, authority.sourceKey, authority.publicationKey);
  const runner = generationReadRunner(selected, { sourceKey: authority.sourceKey }, dependencies);
  return {
    async read(input: unknown, signal: AbortSignal) {
      requireGenerationOptions(selected, 'read');
      const request = originCouponPreviewRequestSchema.parse(input),
        p = request.preview,
        now = runner.clock();
      if (
        p.issuedAt > now ||
        p.expiresAt <= now ||
        !sameOriginHash(
          request.previewProof,
          originDigest(authority.originKey, 'preview-context', p),
        )
      )
        throw originError('SCREENING_ORIGIN_COUPON_PREVIEW_UNAUTHORIZED');
      const at = Temporal.PlainDateTime.from(
          request.selection.asOf.replace(' ', 'T'),
        ).toZonedDateTime(request.selection.sourceTimeZone, { disambiguation: 'reject' }),
        current = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(
          request.selection.sourceTimeZone,
        );
      if (
        at.epochMilliseconds > now ||
        now - at.epochMilliseconds >= 60000 ||
        !at.toPlainDate().equals(current.toPlainDate())
      )
        throw originError('SCREENING_ORIGIN_COUPON_PREVIEW_EXPIRED');
      const scope = generationScopeSchema.parse({
        customerId: p.customerId,
        couponId: request.selection.couponId,
        configurationHash: request.selection.configurationHash,
        sourceTimeZone: request.selection.sourceTimeZone,
        sourceDay: request.selection.asOf.slice(0, 10),
      });
      let facts: GenerationFacts;
      try {
        facts = await runner.read(scope, request.witness, signal);
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'ORDER_IMPORT_COUPON_PUBLICATION_GENERATION_INCOMPLETE' &&
          dependencies.demand
        ) {
          try {
            await dependencies.demand.enqueue(request, signal);
          } catch {
            signal.throwIfAborted();
          }
        }
        throw error;
      }
      signal.throwIfAborted();
      const checked = verifyOriginCouponPublication(
          facts,
          { customerId: p.customerId, selection: request.selection, witness: request.witness },
          authority,
          selected.comparisonFingerprint!,
          runner.clock(),
        ),
        fetchedAt = Math.min(checked.capture.capturedAt, checked.capture.control.data.observedAt),
        body = {
          contract: originCouponPreviewContract,
          preview: p,
          previewProof: request.previewProof,
          selection: request.selection,
          witness: request.witness,
          generationId: checked.capture.generationId,
          publication: {
            sourceCaptureHash: checked.capture.signature,
            seal: checked.publication.seal,
          },
          facts: checked.facts,
          reader: 'bigquery' as const,
          complete: true as const,
          fetchedAt,
          expiresAt: Math.min(
            fetchedAt + 60000,
            p.expiresAt,
            current.startOfDay().add({ days: 1 }).epochMilliseconds,
          ),
        };
      if (runner.clock() >= body.expiresAt)
        throw originError('SCREENING_ORIGIN_COUPON_PREVIEW_EXPIRED');
      return originCouponPreviewDocumentSchema.parse({
        ...body,
        signature: originDigest(authority.originKey, 'coupon-preview', body),
      });
    },
  };
}
