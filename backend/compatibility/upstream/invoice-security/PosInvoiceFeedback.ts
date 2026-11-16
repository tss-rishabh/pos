import type { FastifyReply, FastifyRequest } from 'fastify';
import { feedbackProofContract, feedbackVerifier } from './PosInvoiceFeedbackProof.ts';

export interface InvoiceFeedbackConfiguration {
  verifier: ReturnType<typeof feedbackVerifier>;
  origins: ReadonlySet<string>;
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
/** No legacy/customer-token fallback. This factory refuses missing key separation. */
export function invoiceFeedbackConfiguration(
  forbiddenKeys: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): InvoiceFeedbackConfiguration {
  try {
    const parsed: unknown = JSON.parse(env.POS_INVOICE_FEEDBACK_KEYS_JSON ?? ''),
      ttl = env.POS_INVOICE_FEEDBACK_MAX_TTL_SECONDS ?? '',
      originValues: unknown = JSON.parse(env.POS_FEEDBACK_WEB_ORIGINS ?? '');
    if (
      !Array.isArray(parsed) ||
      parsed.length < 1 ||
      parsed.length > 8 ||
      !/^[0-9]{2,8}$/.test(ttl) ||
      !Array.isArray(originValues) ||
      originValues.length < 1 ||
      originValues.length > 8 ||
      forbiddenKeys.length < 3 ||
      forbiddenKeys.some((key) => typeof key !== 'string' || !key)
    )
      throw new Error();
    const keys = parsed.map((item: unknown) => {
      if (
        !record(item) ||
        Object.keys(item).length !== 2 ||
        typeof item.id !== 'string' ||
        typeof item.key !== 'string'
      )
        throw new Error();
      return { id: item.id, key: item.key };
    });
    const origins = new Set<string>();
    for (const value of originValues) {
      if (typeof value !== 'string' || value.length > 1024) throw new Error();
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password)
        throw new Error();
      origins.add(value);
    }
    if (origins.size !== originValues.length) throw new Error();
    return {
      verifier: feedbackVerifier({ keys, maxTtlSeconds: Number(ttl), forbiddenKeys }),
      origins,
    };
  } catch {
    throw new Error('Private feedback verification is not configured.');
  }
}
export function verifyInvoiceFeedback(
  request: FastifyRequest,
  response: FastifyReply,
  configuration: InvoiceFeedbackConfiguration,
) {
  const token = request.headers.authorization;
  if (
    request.headers['x-pos-feedback-contract'] !== feedbackProofContract ||
    typeof token !== 'string' ||
    token.length > 4096
  )
    return false;
  try {
    const proof = configuration.verifier(token);
    (request as FastifyRequest & { payload: { order_id: string } }).payload = {
      // Never pass this exact identifier through Number/parseInt.
      order_id: proof.orderId,
    };
    response.header('X-POS-Feedback-Contract', feedbackProofContract);
    return true;
  } catch {
    return false;
  }
}
