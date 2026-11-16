import { createHmac, timingSafeEqual } from 'node:crypto';

export const feedbackProofContract = 'pos-feedback-proof-v1';
export interface FeedbackVerificationKey {
  id: string;
  key: string;
}
export interface FeedbackVerifierConfiguration {
  keys: readonly FeedbackVerificationKey[];
  maxTtlSeconds: number;
  /** Every customer/session signing key configured in the consuming service. */
  forbiddenKeys: readonly string[];
}
export interface FeedbackProof {
  orderId: string;
  keyId: string;
  issuedAt: number;
  expiresAt: number;
  id: string;
}
export class FeedbackProofError extends Error {
  readonly code = 'FEEDBACK_PROOF_INVALID';
  constructor() {
    super('The feedback proof is invalid or expired.');
  }
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, names: readonly string[]) =>
  Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name));
const second = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const identifier = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[1-9]\d{0,18}$/.test(value) &&
  BigInt(value) <= 9223372036854775807n;
const keyIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,39}$/.test(value);

function decode(value: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new FeedbackProofError();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length > 1024 || bytes.toString('base64url') !== value) throw new FeedbackProofError();
  return JSON.parse(bytes.toString('utf8')) as unknown;
}
/** Purpose-only verifier shared with the reviewable post-order compatibility patch. */
export function feedbackVerifier(configuration: FeedbackVerifierConfiguration) {
  if (
    !Number.isSafeInteger(configuration.maxTtlSeconds) ||
    configuration.maxTtlSeconds < 60 ||
    configuration.maxTtlSeconds > 2678400 ||
    configuration.keys.length < 1 ||
    configuration.keys.length > 8 ||
    configuration.forbiddenKeys.length < 1 ||
    configuration.forbiddenKeys.some((key) => typeof key !== 'string' || !key) ||
    new Set(configuration.keys.map((key) => key.id)).size !== configuration.keys.length
  )
    throw new Error('Feedback verification configuration is invalid.');
  const keys = new Map<string, Buffer>();
  for (const item of configuration.keys) {
    const bytes = Buffer.from(item.key, 'utf8');
    if (
      !keyIdentifier(item.id) ||
      bytes.length < 32 ||
      bytes.length > 4096 ||
      configuration.forbiddenKeys.some((key) => {
        const forbidden = Buffer.from(key, 'utf8');
        return forbidden.length === bytes.length && timingSafeEqual(forbidden, bytes);
      }) ||
      [...keys.values()].some(
        (previous) => previous.length === bytes.length && timingSafeEqual(previous, bytes),
      )
    )
      throw new Error('Feedback verification configuration is invalid.');
    keys.set(item.id, bytes);
  }
  return (token: string, now = Date.now(), expectedOrderId?: string): FeedbackProof => {
    try {
      if (typeof token !== 'string' || token.length > 4096 || !Number.isSafeInteger(now) || now < 0)
        throw new FeedbackProofError();
      const parts = token.split('.');
      if (parts.length !== 3) throw new FeedbackProofError();
      const [encodedHeader, encodedPayload, encodedSignature] = parts;
      if (!encodedHeader || !encodedPayload || !encodedSignature) throw new FeedbackProofError();
      const header = decode(encodedHeader),
        payload = decode(encodedPayload);
      if (
        !isRecord(header) ||
        !exactKeys(header, ['alg', 'typ', 'kid']) ||
        header.alg !== 'HS256' ||
        header.typ !== 'JWT' ||
        !keyIdentifier(header.kid)
      )
        throw new FeedbackProofError();
      const key = keys.get(header.kid);
      if (!key || !/^[A-Za-z0-9_-]{43}$/.test(encodedSignature)) throw new FeedbackProofError();
      const signature = Buffer.from(encodedSignature, 'base64url'),
        expected = createHmac('sha256', key).update(`${encodedHeader}.${encodedPayload}`).digest();
      if (
        signature.toString('base64url') !== encodedSignature ||
        signature.length !== expected.length ||
        !timingSafeEqual(signature, expected)
      )
        throw new FeedbackProofError();
      if (
        !isRecord(payload) ||
        !exactKeys(payload, [
          'v',
          'iss',
          'aud',
          'purpose',
          'type',
          'order_id',
          'iat',
          'exp',
          'jti',
        ]) ||
        payload.v !== 1 ||
        payload.iss !== 'pos-invoice' ||
        payload.aud !== 'tss-pos-feedback' ||
        payload.purpose !== 'nps' ||
        payload.type !== 'nps' ||
        !identifier(payload.order_id) ||
        !second(payload.iat) ||
        !second(payload.exp) ||
        payload.exp <= payload.iat ||
        payload.exp - payload.iat > configuration.maxTtlSeconds ||
        payload.iat > Math.floor(now / 1000) + 30 ||
        payload.exp <= Math.floor(now / 1000) ||
        typeof payload.jti !== 'string' ||
        !/^[a-f0-9]{32}$/.test(payload.jti) ||
        (expectedOrderId !== undefined &&
          (!identifier(expectedOrderId) || payload.order_id !== expectedOrderId))
      )
        throw new FeedbackProofError();
      return {
        orderId: payload.order_id,
        keyId: header.kid,
        issuedAt: payload.iat,
        expiresAt: payload.exp,
        id: payload.jti,
      };
    } catch {
      throw new FeedbackProofError();
    }
  };
}
