import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../domain/errors.js';
import {
  receiptSignature,
  wholeOrderStatusContract,
  statusCapabilitySignature,
  statusCapabilitySchema,
} from './domain.js';
import {
  authenticateStatusReceiver,
  type StatusReceiverProof,
  type WholeOrderStatusReceiver,
} from './receiver.js';
import type { WholeOrderStatusOptions } from './options.js';
/** Private service-only compatibility routes; ordinary browser cookies grant no authority. */
export async function registerWholeOrderStatusReceiver(
  app: FastifyInstance,
  options: WholeOrderStatusOptions,
  receiver: Pick<WholeOrderStatusReceiver, 'accept' | 'read' | 'ready'>,
) {
  const proofs = new WeakMap<FastifyRequest, StatusReceiverProof>(),
    empty = z.object({}).strict();
  const preValidation = async (request: FastifyRequest) => {
    proofs.set(request, authenticateStatusReceiver(request.headers, options));
  };
  const settings = (action: string) => ({
    config: {
      authentication: 'service' as const,
      trace: { module: 'whole-order-status', resource: 'whole-order-status-receiver', action },
    },
    preValidation,
  });
  app.get('/store-order/status/capabilities', settings('qualify'), async (request, reply) => {
    empty.parse(request.query);
    receiver.ready();
    const proof = proofs.get(request)!,
      value = statusCapabilitySchema.parse({
        contract: wholeOrderStatusContract,
        profile: 'pinned-store-chain-v1',
        sourcePin: '70b80159016db39a73572f80bfa87c47201c0a9f',
        operationId: proof.operationId,
        scopeHash: proof.scopeHash,
        requestHash: proof.requestHash,
        challenge: z.uuid().parse(request.headers['x-pos-status-challenge']),
      });
    return reply
      .header('Cache-Control', 'no-store')
      .header(
        'x-pos-status-capability',
        statusCapabilitySignature(options.WHOLE_ORDER_STATUS_RECEIPT_KEY!, value),
      )
      .send(value);
  });
  app.post('/store-order/status', settings('create'), async (request, reply) => {
    empty.parse(request.query);
    const receipt = await receiver.accept(proofs.get(request)!, request.body);
    return reply
      .code(202)
      .header('Cache-Control', 'no-store')
      .header(
        'x-pos-status-receipt',
        receiptSignature(options.WHOLE_ORDER_STATUS_RECEIPT_KEY!, receipt),
      )
      .send(receipt);
  });
  app.get('/store-order/status/commands/:operationId', settings('read'), async (request, reply) => {
    const { operationId } = z.object({ operationId: z.uuid() }).strict().parse(request.params);
    empty.parse(request.query);
    const proof = proofs.get(request)!;
    if (proof.operationId !== operationId)
      throw new AppError(
        403,
        'WHOLE_ORDER_STATUS_SERVICE_SCOPE',
        'The requested status receipt is outside this service proof.',
      );
    const receipt = await receiver.read(proof);
    if (!receipt)
      throw new AppError(
        404,
        'WHOLE_ORDER_STATUS_RECEIPT_NOT_FOUND',
        'The status receiver has not recorded this operation.',
      );
    return reply
      .header('Cache-Control', 'no-store')
      .header(
        'x-pos-status-receipt',
        receiptSignature(options.WHOLE_ORDER_STATUS_RECEIPT_KEY!, receipt),
      )
      .send(receipt);
  });
}
