import { z } from 'zod';
import { identifier } from '../../domain/validation.js';
import { originPreviewSchema } from './preview-contracts.js';
import {
  membershipExecutionSchema,
  membershipExecution,
  membershipSelectionSchema,
  publicMembershipHeadSchema,
  qualifyMembershipGeneration,
  membershipGenerationPublicationContract,
  assertMembershipHistoryKeys,
  type MembershipExecution,
  type PublicMembershipHead,
} from '../checkout/screening-writer/membership-history.js';
import { csvMembershipSourceInstant } from '../legacy-order-imports/membership-profile/bigquery.js';
import {
  boundedWarehouseSelect,
  qualifiedWarehouseTable,
  type BoundedSelectPort,
} from '../warehouse/bounded-select.js';
import {
  originCommandSchema,
  originDigest,
  originError,
  originHashSchema,
  sameOriginHash,
  screeningOriginSchema,
} from './contracts.js';

export const originMembershipHistoryContract = 'pos-screening-origin-membership-history-v1';
export const originMembershipScopeSchema = z
  .object({
    contract: z.literal(originMembershipHistoryContract),
    commandId: z.uuid(),
    origin: screeningOriginSchema,
    customerId: identifier,
    requestHash: originHashSchema,
    cartHash: originHashSchema,
    authorityHash: originHashSchema,
    configurationHash: originHashSchema,
    sourceTimeZone: z.string().min(1).max(128),
    asOf: z.string(),
    cutoff: z.string(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      !membershipExecutionSchema.safeParse({
        customerId: value.customerId,
        configurationHash: value.configurationHash,
        sourceTimeZone: value.sourceTimeZone,
        asOf: value.asOf,
        cutoff: value.cutoff,
      }).success
    )
      context.addIssue({ code: 'custom', message: 'Invalid membership execution point.' });
  });
export const originMembershipDocumentSchema = z
  .object({
    contract: z.literal(originMembershipHistoryContract),
    scope: originMembershipScopeSchema,
    head: publicMembershipHeadSchema,
    generationId: originHashSchema,
    sourceCaptureHash: originHashSchema,
    publicationHash: originHashSchema,
    reader: z.literal('bigquery'),
    complete: z.literal(true),
    fetchedAt: z.number().int().safe().positive(),
    expiresAt: z.number().int().safe().positive(),
    selection: membershipSelectionSchema,
    signature: originHashSchema,
  })
  .strict();
export const originMembershipPreviewContract = 'pos-screening-origin-membership-preview-v1';
export const originMembershipPreviewScopeSchema = z
  .object({
    contract: z.literal(originMembershipPreviewContract),
    preview: originPreviewSchema,
    configurationHash: originHashSchema,
    sourceTimeZone: z.string().min(1).max(128),
    asOf: z.string(),
    cutoff: z.string(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      !membershipExecutionSchema.safeParse({
        customerId: value.preview.customerId,
        configurationHash: value.configurationHash,
        sourceTimeZone: value.sourceTimeZone,
        asOf: value.asOf,
        cutoff: value.cutoff,
      }).success
    )
      context.addIssue({ code: 'custom', message: 'Invalid membership preview point.' });
  });
export const originMembershipPreviewDocumentSchema = originMembershipDocumentSchema.extend({
  contract: z.literal(originMembershipPreviewContract),
  scope: originMembershipPreviewScopeSchema,
});
export type OriginMembershipScope = z.infer<typeof originMembershipScopeSchema>;
export type OriginMembershipDocument = z.infer<typeof originMembershipDocumentSchema>;
export interface OriginMembershipDemandPort {
  requestGeneration(
    scope: MembershipExecution,
    head: PublicMembershipHead,
    call: { signal?: AbortSignal },
  ): Promise<void>;
}
export interface OriginMembershipHistoryOptions {
  view: string;
  maxBytes: number;
  timeoutMs: number;
  sourceTimeZone: string;
}
/** Read a genuine generic generation and bind it to the actual source command.
 * No Node checkout/capability, native history capture or publisher is created. */
export function originMembershipHistory(
  options: OriginMembershipHistoryOptions,
  authority: {
    originKey: string;
    captureKey: string;
    publicationKey: string;
    memberIds: readonly string[];
  },
  dependencies: {
    select?: BoundedSelectPort;
    demands?: OriginMembershipDemandPort;
    clock?: () => number;
  } = {},
) {
  const view = qualifiedWarehouseTable.parse(options.view),
    clock = dependencies.clock ?? Date.now;
  assertMembershipHistoryKeys(authority.originKey, authority.captureKey, authority.publicationKey);
  const members = z.array(identifier).min(1).max(1000).parse(authority.memberIds);
  if (new Set(members).size !== members.length)
    throw originError('SCREENING_ORIGIN_MEMBERSHIP_CONFIGURATION');
  const select =
    dependencies.select ??
    boundedWarehouseSelect({
      maxBytes: options.maxBytes,
      timeoutMs: options.timeoutMs,
      maxDocumentBytes: 2000000,
      resource: 'origin-membership-history',
    });
  async function generation(
    execution: MembershipExecution,
    head: PublicMembershipHead,
    expiresAt: number,
    signal: AbortSignal,
  ) {
    const statement = originMembershipStatement(view, execution, head);
    let raw: unknown;
    try {
      raw = JSON.parse(await select.read(statement, signal)) as unknown;
    } catch {
      signal.throwIfAborted();
      throw originError('SCREENING_ORIGIN_MEMBERSHIP_UNAVAILABLE');
    }
    const data = z
      .object({
        generations: z
          .array(
            z
              .object({
                generationId: originHashSchema,
                sourceCapture: z.unknown(),
                publication: z.unknown(),
                warehouseSelection: z.unknown(),
              })
              .strict(),
          )
          .max(2),
      })
      .strict()
      .parse(raw);
    if (!data.generations.length) {
      await dependencies.demands?.requestGeneration(execution, head, { signal });
      throw originError('SCREENING_ORIGIN_MEMBERSHIP_GENERATION_REQUIRED');
    }
    if (data.generations.length !== 1) throw originError('SCREENING_ORIGIN_MEMBERSHIP_UNQUALIFIED');
    const record = data.generations[0]!,
      now = clock();
    const qualified = qualifyMembershipGeneration({
      request: execution,
      head,
      generation: record.sourceCapture,
      publication: record.publication,
      warehouseSelection: record.warehouseSelection,
      memberIds: members,
      sourceKey: authority.captureKey,
      publicationKey: authority.publicationKey,
      expiresAt,
      now,
      maximumAgeMs: null,
    });
    if (record.generationId !== qualified.generationId)
      throw originError('SCREENING_ORIGIN_MEMBERSHIP_UNQUALIFIED');
    signal.throwIfAborted();
    return qualified;
  }
  return {
    async read(
      input: {
        command: z.infer<typeof originCommandSchema>;
        commandProof: string;
        scope: OriginMembershipScope;
        head: PublicMembershipHead;
      },
      signal: AbortSignal,
    ): Promise<OriginMembershipDocument> {
      signal.throwIfAborted();
      const command = originCommandSchema.parse(input.command),
        scope = originMembershipScopeSchema.parse(input.scope),
        head = publicMembershipHeadSchema.parse(input.head),
        before = clock();
      if (
        command.phase !== 'PREPARED' ||
        command.orderId !== null ||
        command.expiresAt <= before ||
        !sameOriginHash(
          originDigest(authority.originKey, 'command', command),
          input.commandProof,
        ) ||
        command.id !== scope.commandId ||
        command.origin !== scope.origin ||
        command.customerId !== scope.customerId ||
        command.requestHash !== scope.requestHash ||
        command.cartHash !== scope.cartHash ||
        command.authorityHash !== scope.authorityHash ||
        scope.sourceTimeZone !== options.sourceTimeZone
      )
        throw originError('SCREENING_ORIGIN_MEMBERSHIP_SCOPE_CHANGED');
      const execution = membershipExecution(scope),
        point = csvMembershipSourceInstant(scope.asOf, scope.sourceTimeZone);
      if (point > before || point < command.createdAt - 999 || point + 60000 <= before)
        throw originError('SCREENING_ORIGIN_MEMBERSHIP_EXPIRED');
      const qualified = await generation(
        execution,
        head,
        Math.min(command.expiresAt, point + 60000),
        signal,
      );
      const body = { contract: originMembershipHistoryContract, scope, ...qualified };
      return originMembershipDocumentSchema.parse({
        ...body,
        signature: originDigest(authority.originKey, 'membership-history', body),
      });
    },
    async readPreview(
      input: {
        preview: z.infer<typeof originPreviewSchema>;
        previewProof: string;
        scope: z.infer<typeof originMembershipPreviewScopeSchema>;
        head: PublicMembershipHead;
      },
      signal: AbortSignal,
    ) {
      signal.throwIfAborted();
      const preview = originPreviewSchema.parse(input.preview),
        scope = originMembershipPreviewScopeSchema.parse(input.scope),
        head = publicMembershipHeadSchema.parse(input.head),
        before = clock();
      if (
        preview.issuedAt > before ||
        preview.expiresAt <= before ||
        scope.sourceTimeZone !== options.sourceTimeZone ||
        !sameOriginHash(
          originDigest(authority.originKey, 'preview-context', preview),
          input.previewProof,
        ) ||
        !sameOriginHash(
          originDigest(authority.originKey, 'preview-context', scope.preview),
          input.previewProof,
        )
      )
        throw originError('SCREENING_ORIGIN_MEMBERSHIP_SCOPE_CHANGED');
      const execution = membershipExecution({ ...scope, customerId: preview.customerId }),
        point = csvMembershipSourceInstant(scope.asOf, scope.sourceTimeZone);
      if (point > before || point < preview.issuedAt - 999 || point + 60000 <= before)
        throw originError('SCREENING_ORIGIN_MEMBERSHIP_EXPIRED');
      const qualified = await generation(
        execution,
        head,
        Math.min(preview.expiresAt, point + 60000),
        signal,
      );
      const body = { contract: originMembershipPreviewContract, scope, ...qualified };
      return originMembershipPreviewDocumentSchema.parse({
        ...body,
        signature: originDigest(authority.originKey, 'membership-preview', body),
      });
    },
  };
}
export function originMembershipStatement(
  view: string,
  scope: MembershipExecution,
  head: PublicMembershipHead,
) {
  const table = qualifiedWarehouseTable.parse(view);
  return {
    sql: `WITH eligible AS (SELECT generation_id,source_capture,publication,warehouse_selection,as_of FROM \`${table}\`
WHERE scope_shard=@shard AND contract=@contract AND customer_id=@customer
AND source_time_zone=@zone AND configuration_hash=@configuration AND as_of<=@asOf AND cutoff<=@cutoff
AND JSON_VALUE(source_capture,'$.head.revision')=@revision
AND JSON_VALUE(source_capture,'$.head.origin.schema')=@schema
AND JSON_VALUE(source_capture,'$.head.origin.serverUuid')=@server
AND JSON_VALUE(source_capture,'$.head.writersHash')=@writers
), generations AS (SELECT generation_id,source_capture,publication,warehouse_selection FROM eligible
WHERE as_of=(SELECT MAX(as_of) FROM eligible) LIMIT 2)
SELECT TO_JSON_STRING(STRUCT(ARRAY(SELECT AS STRUCT generation_id AS generationId,
source_capture AS sourceCapture,publication,warehouse_selection AS warehouseSelection FROM generations) AS generations)) AS document`,
    params: {
      shard: Number(BigInt(scope.customerId) % 1024n),
      contract: membershipGenerationPublicationContract,
      customer: scope.customerId,
      zone: scope.sourceTimeZone,
      configuration: scope.configurationHash,
      asOf: scope.asOf,
      cutoff: scope.cutoff,
      revision: head.revision,
      schema: head.origin.schema,
      server: head.origin.serverUuid,
      writers: head.writersHash,
    },
    types: {
      shard: 'INT64',
      contract: 'STRING',
      customer: 'STRING',
      zone: 'STRING',
      configuration: 'STRING',
      asOf: 'DATETIME',
      cutoff: 'DATETIME',
      revision: 'STRING',
      schema: 'STRING',
      server: 'STRING',
      writers: 'STRING',
    },
  };
}
