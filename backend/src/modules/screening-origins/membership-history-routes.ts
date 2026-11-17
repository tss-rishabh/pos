import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { publicMembershipHeadSchema } from '../checkout/screening-writer/membership-history.js';
import {
  originCommandSchema,
  originDigest,
  originError,
  originHashSchema,
  sameOriginHash,
} from './contracts.js';
import {
  originMembershipScopeSchema,
  originMembershipPreviewScopeSchema,
  type originMembershipHistory,
} from './membership-history.js';
import { originPreviewSchema } from './preview-contracts.js';

export const originMembershipRequestSchema = z
  .object({
    command: originCommandSchema,
    commandProof: originHashSchema,
    scope: originMembershipScopeSchema,
    head: publicMembershipHeadSchema,
    issuedAt: z.number().int().safe().positive(),
    expiresAt: z.number().int().safe().positive(),
  })
  .strict();
const envelope = z
  .object({ data: originMembershipRequestSchema, proofHash: originHashSchema })
  .strict();
const previewEnvelope = z
  .object({
    data: z
      .object({
        preview: originPreviewSchema,
        previewProof: originHashSchema,
        scope: originMembershipPreviewScopeSchema,
        head: publicMembershipHeadSchema,
        issuedAt: z.number().int().safe().positive(),
        expiresAt: z.number().int().safe().positive(),
      })
      .strict(),
    proofHash: originHashSchema,
  })
  .strict();

/** Private source request; neither browser tokens nor a cart preview can create
 * a command or initiate a financial action through this route. */
export async function registerOriginMembershipHistoryBridge(
  app: FastifyInstance,
  key: string,
  history: ReturnType<typeof originMembershipHistory>,
  clock = Date.now,
) {
  app.post(
    '/internal/screening-origins/membership-history',
    {
      bodyLimit: 32000,
      config: {
        authentication: 'service',
        trace: { module: 'screening-origins', resource: 'membership-history', action: 'read' },
      },
    },
    async (req, reply) => {
      const parsed = envelope.safeParse(req.body),
        now = clock();
      if (!parsed.success || !z.object({}).strict().safeParse(req.query).success)
        throw originError('SCREENING_ORIGIN_MEMBERSHIP_UNAUTHORIZED');
      const { data, proofHash } = parsed.data;
      if (
        data.issuedAt > now ||
        data.expiresAt <= now ||
        data.expiresAt > Math.min(data.issuedAt + 30000, data.command.expiresAt) ||
        !sameOriginHash(originDigest(key, 'membership-history-request', data), proofHash)
      )
        throw originError('SCREENING_ORIGIN_MEMBERSHIP_UNAUTHORIZED');
      const result = await history.read(data, AbortSignal.timeout(25000));
      req.auditUserId = data.command.actorId;
      reply.header('Cache-Control', 'no-store');
      return result;
    },
  );
  app.post(
    '/internal/screening-origins/membership-preview',
    {
      bodyLimit: 32000,
      config: {
        authentication: 'service',
        trace: { module: 'screening-origins', resource: 'membership-history', action: 'preview' },
      },
    },
    async (req, reply) => {
      const parsed = previewEnvelope.safeParse(req.body),
        now = clock();
      if (!parsed.success || !z.object({}).strict().safeParse(req.query).success)
        throw originError('SCREENING_ORIGIN_MEMBERSHIP_UNAUTHORIZED');
      const { data, proofHash } = parsed.data;
      if (
        data.issuedAt > now ||
        data.issuedAt < data.preview.issuedAt ||
        data.expiresAt <= now ||
        data.expiresAt > Math.min(data.issuedAt + 30000, data.preview.expiresAt) ||
        !sameOriginHash(originDigest(key, 'membership-preview-request', data), proofHash)
      )
        throw originError('SCREENING_ORIGIN_MEMBERSHIP_UNAUTHORIZED');
      const result = await history.readPreview(data, AbortSignal.timeout(25000));
      req.auditUserId = data.preview.actorId;
      reply.header('Cache-Control', 'no-store');
      return result;
    },
  );
}
