import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  originCommandSchema,
  originDigest,
  originError,
  originHashSchema,
  sameOriginHash,
} from './contracts.js';
import { originHistoryWitnessSchema, type originCustomerHistory } from './history.js';

const request = z
  .object({
    data: z
      .object({
        command: originCommandSchema,
        commandProof: originHashSchema,
        witness: originHistoryWitnessSchema,
        issuedAt: z.number().int().safe().positive(),
        expiresAt: z.number().int().safe().positive(),
      })
      .strict(),
    proofHash: originHashSchema,
  })
  .strict();
/** Opt-in private source bridge. No cookie principal, source key in URL, writer
 * transaction or financial dispatcher is exposed by this read-only endpoint. */
export async function registerOriginHistoryBridge(
  app: FastifyInstance,
  key: string,
  history: ReturnType<typeof originCustomerHistory>,
  clock = Date.now,
) {
  app.post(
    '/internal/screening-origins/history',
    {
      bodyLimit: 32000,
      config: {
        authentication: 'service',
        trace: { module: 'screening-origins', resource: 'customer-history', action: 'read' },
      },
    },
    async (req, reply) => {
      if (!z.object({}).strict().safeParse(req.query).success)
        throw originError('SCREENING_ORIGIN_HISTORY_UNAUTHORIZED');
      const parsed = request.safeParse(req.body),
        now = clock();
      if (!parsed.success) throw originError('SCREENING_ORIGIN_HISTORY_UNAUTHORIZED');
      const { data, proofHash } = parsed.data;
      if (
        data.issuedAt > now ||
        data.expiresAt <= now ||
        data.expiresAt > data.issuedAt + 30000 ||
        data.expiresAt > data.command.expiresAt ||
        !sameOriginHash(originDigest(key, 'history-request', data), proofHash)
      )
        throw originError('SCREENING_ORIGIN_HISTORY_UNAUTHORIZED');
      const signal = AbortSignal.timeout(25000);
      const value = await history.read(data, signal);
      req.auditUserId = data.command.actorId;
      reply.header('Cache-Control', 'no-store');
      return value;
    },
  );
}
