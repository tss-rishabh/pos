import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { originDigest, originError, originHashSchema, sameOriginHash } from './contracts.js';
import { originCouponHistoryRequestSchema } from './coupon-contracts.js';
import type { originCouponHistory } from './coupon-history.js';
const envelope = z
  .object({ data: originCouponHistoryRequestSchema, proofHash: originHashSchema })
  .strict();
/** Private service bridge only; no public source capability or financial call. */
export async function registerOriginCouponHistoryBridge(
  app: FastifyInstance,
  key: string,
  history: ReturnType<typeof originCouponHistory>,
  clock = Date.now,
) {
  app.post(
    '/internal/screening-origins/coupon-history',
    {
      bodyLimit: 32000,
      config: {
        authentication: 'service',
        trace: { module: 'screening-origins', resource: 'coupon-history', action: 'read' },
      },
    },
    async (req, reply) => {
      const parsed = envelope.safeParse(req.body),
        now = clock();
      if (!parsed.success || !z.object({}).strict().safeParse(req.query).success)
        throw originError('SCREENING_ORIGIN_COUPON_HISTORY_UNAUTHORIZED');
      const { data, proofHash } = parsed.data;
      if (
        data.issuedAt > now ||
        data.expiresAt <= now ||
        data.expiresAt > Math.min(data.issuedAt + 30000, data.command.expiresAt) ||
        !sameOriginHash(originDigest(key, 'coupon-history-request', data), proofHash) ||
        !sameOriginHash(originDigest(key, 'command', data.command), data.commandProof)
      )
        throw originError('SCREENING_ORIGIN_COUPON_HISTORY_UNAUTHORIZED');
      req.auditUserId =
        data.command.origin === 'customer' ? data.command.customerId : data.command.actorId;
      const result = await history.read(data, AbortSignal.timeout(25000));
      reply.header('Cache-Control', 'no-store');
      return result;
    },
  );
}
