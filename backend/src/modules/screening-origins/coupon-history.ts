import { Temporal } from '@js-temporal/polyfill';
import { originDigest, originError, sameOriginHash } from './contracts.js';
import { originHistoryKeys } from './history-contracts.js';
import {
  originCouponHistoryContract,
  originCouponHistoryDocumentSchema,
  originCouponHistoryRequestSchema,
  type OriginCouponHistoryRequest,
} from './coupon-contracts.js';
import { benefitDigest } from '../legacy-order-imports/benefit-profile/crypto.js';
import {
  generationHeadHash,
  generationPublicationSchema,
  generationScopeSchema,
  verifyGenerationFacts,
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
export interface OriginCouponDemandPort {
  enqueue(request: OriginCouponHistoryRequest, signal: AbortSignal): Promise<void>;
}
/** Shared generic publication proof, independently rebound to a REAL origin
 * command. No CSV operation/plan or Node operator/checkout is manufactured. */
export function verifyOriginCouponGeneration(
  value: GenerationFacts,
  request: OriginCouponHistoryRequest,
  authority: { sourceKey: string; publicationKey: string },
  fingerprint: string,
  now: number,
) {
  const scope = generationScopeSchema.parse({
      customerId: request.command.customerId,
      couponId: request.selection.couponId,
      configurationHash: request.selection.configurationHash,
      sourceTimeZone: request.selection.sourceTimeZone,
      sourceDay: request.selection.asOf.slice(0, 10),
    }),
    actual = verifyGenerationFacts(value, authority.sourceKey, fingerprint, now),
    publication = generationPublicationSchema.parse(actual.publication),
    { seal, ...body } = publication,
    c = actual.capture;
  if (
    JSON.stringify(c.scope) !== JSON.stringify(scope) ||
    JSON.stringify(publication.scope) !== JSON.stringify(scope) ||
    publication.generationId !== c.generationId ||
    publication.snapshotId !== c.snapshotId ||
    publication.captureHash !== c.signature ||
    publication.headHash !== c.headHash ||
    publication.controlsHash !== c.controlsHash ||
    publication.sourceFinishedAt !== c.finishedAt ||
    publication.materializedAt !== actual.materializedAt ||
    publication.publishedAt < publication.materializedAt ||
    publication.publishedAt > now ||
    !sameOriginHash(c.headHash, generationHeadHash(scope, request.witness, authority.sourceKey)) ||
    !sameOriginHash(
      publication.factsHash,
      benefitDigest(
        'coupon-generation-facts',
        { scope, facts: actual.facts },
        authority.publicationKey,
      ),
    ) ||
    !sameOriginHash(
      publication.projectionsHash,
      benefitDigest(
        'coupon-generation-projections',
        { scope, projections: actual.projections },
        authority.publicationKey,
      ),
    ) ||
    !sameOriginHash(
      seal,
      benefitDigest('coupon-generation-publication', body, authority.publicationKey),
    )
  )
    throw originError('SCREENING_ORIGIN_COUPON_PUBLICATION_INVALID');
  return { ...actual, publication };
}
export function originCouponHistory(
  options: GenerationOptions,
  authority: { originKey: string; sourceKey: string; publicationKey: string },
  dependencies: GenerationDependencies & { demand?: OriginCouponDemandPort } = {},
) {
  const selected = generationOptionsSchema.parse(options);
  originHistoryKeys(authority.originKey, authority.sourceKey, authority.publicationKey);
  const runner = generationReadRunner(selected, { sourceKey: authority.sourceKey }, dependencies);
  return {
    async read(input: unknown, signal: AbortSignal) {
      requireGenerationOptions(selected, 'read');
      const request = originCouponHistoryRequestSchema.parse(input),
        now = runner.clock(),
        command = request.command;
      if (
        command.phase !== 'PREPARED' ||
        command.orderId !== null ||
        request.issuedAt > now ||
        request.expiresAt <= now ||
        request.expiresAt > Math.min(command.expiresAt, request.issuedAt + 30000) ||
        !sameOriginHash(request.commandProof, originDigest(authority.originKey, 'command', command))
      )
        throw originError('SCREENING_ORIGIN_COUPON_HISTORY_UNAUTHORIZED');
      const at = Temporal.PlainDateTime.from(
          request.selection.asOf.replace(' ', 'T'),
        ).toZonedDateTime(request.selection.sourceTimeZone, { disambiguation: 'reject' }),
        current = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(
          request.selection.sourceTimeZone,
        );
      if (
        at.epochMilliseconds > now ||
        now - at.epochMilliseconds >= 60000 ||
        at.toPlainDate().toString() !== current.toPlainDate().toString()
      )
        throw originError('SCREENING_ORIGIN_COUPON_HISTORY_EXPIRED');
      const scope = generationScopeSchema.parse({
        customerId: command.customerId,
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
      const checked = verifyOriginCouponGeneration(
          facts,
          request,
          authority,
          selected.comparisonFingerprint!,
          runner.clock(),
        ),
        fetchedAt = Math.min(checked.capture.capturedAt, checked.capture.control.data.observedAt),
        body = {
          contract: originCouponHistoryContract,
          commandId: command.id,
          origin: command.origin,
          customerId: command.customerId,
          requestHash: command.requestHash,
          cartHash: command.cartHash,
          authorityHash: command.authorityHash,
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
            command.expiresAt,
            current.startOfDay().add({ days: 1 }).epochMilliseconds,
          ),
        };
      if (runner.clock() >= body.expiresAt)
        throw originError('SCREENING_ORIGIN_COUPON_HISTORY_EXPIRED');
      return originCouponHistoryDocumentSchema.parse({
        ...body,
        signature: originDigest(authority.originKey, 'coupon-history', body),
      });
    },
  };
}
