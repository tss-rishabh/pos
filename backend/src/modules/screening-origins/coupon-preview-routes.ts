import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { originDigest, originError, originHashSchema, sameOriginHash } from './contracts.js';
import { originCouponPreviewRequestSchema } from './coupon-preview-contracts.js';
import type { originCouponPreviewHistory } from './coupon-preview.js';
const point = z.number().int().positive().safe();
const request = originCouponPreviewRequestSchema.extend({ issuedAt: point, expiresAt: point });
const envelope = z.object({ data: request, proofHash: originHashSchema }).strict();
export async function registerOriginCouponPreviewBridge(
  app: FastifyInstance,
  key: string,
  history: ReturnType<typeof originCouponPreviewHistory>,
  clock = Date.now,
) {
  app.post(
    '/internal/screening-origins/coupon-preview',
    {
      bodyLimit: 32000,
      config: {
        authentication: 'service',
        trace: { module: 'screening-origins', resource: 'coupon-preview', action: 'read' },
      },
    },
    async (req, reply) => {
      const parsed = envelope.safeParse(req.body),
        now = clock();
      if (!parsed.success || !z.object({}).strict().safeParse(req.query).success)
        throw originError('SCREENING_ORIGIN_COUPON_PREVIEW_UNAUTHORIZED');
      const { data, proofHash } = parsed.data;
      if (
        data.issuedAt > now ||
        data.expiresAt <= now ||
        data.expiresAt > Math.min(data.issuedAt + 30000, data.preview.expiresAt) ||
        !sameOriginHash(originDigest(key, 'coupon-preview-request', data), proofHash)
      )
        throw originError('SCREENING_ORIGIN_COUPON_PREVIEW_UNAUTHORIZED');
      const { issuedAt: _issuedAt, expiresAt: _expiresAt, ...input } = data;
      const result = await history.read(input, AbortSignal.timeout(25000));
      req.auditUserId = data.preview.actorId;
      reply.header('Cache-Control', 'no-store');
      return result;
    },
  );
}
