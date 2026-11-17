import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { AppError } from '../../domain/errors.js';
import { operationHash } from '../checkout/crypto.js';
import type { ImportFinancialScope } from './financial-contracts.js';
import { importDigest } from './sealed-groups.js';
import { financialImportPlanSchema } from './financial-adapter-contracts.js';
import type { LegacyOrderImportPlan } from './plans.js';
export const importFinancialError = (code: string, status = 409) =>
  new AppError(
    status,
    code,
    'The original import needs review. Keep its operation reference; no new order or payment should be dispatched.',
  );
export function financialImportKey(
  secret: string,
  purpose: 'encryption' | 'proof' | 'source-proof' | 'source-auth',
) {
  if (!/^[!-~]{32,4096}$/.test(secret))
    throw importFinancialError('ORDER_IMPORT_KEY_UNAVAILABLE', 503);
  return createHmac('sha256', secret)
    .update('legacy-order-imports:financial:' + purpose + ':v1')
    .digest();
}
export function financialImportHash(secret: string, kind: string, value: unknown) {
  return operationHash(
    'legacy-order-imports.financial.' + kind + '.v1',
    value,
    financialImportKey(secret, 'proof').toString('hex'),
  );
}
export function financialSourceHash(
  sourceKey: string,
  kind: 'order' | 'rejection' | 'publication' | 'capability' | 'plan' | 'confirmation',
  value: unknown,
) {
  return operationHash('legacy-order-imports.source.' + kind + '.v1', value, sourceKey);
}
export function equalImportHash(left: string, right: string) {
  return (
    /^[a-f0-9]{64}$/.test(left) &&
    /^[a-f0-9]{64}$/.test(right) &&
    timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
  );
}
export function expectedFinancialPlanHash(
  secret: string,
  scope: ImportFinancialScope,
  plan: LegacyOrderImportPlan,
) {
  return importDigest(
    secret,
    'group',
    JSON.stringify(['pos-import-plan-v1', scope.actorId, scope.storeId, scope.counterId, plan]),
  );
}
export function sealFinancialPlan(
  secret: string,
  scope: ImportFinancialScope,
  planHash: string,
  plan: LegacyOrderImportPlan,
) {
  const bytes = Buffer.from(JSON.stringify(financialImportPlanSchema.parse(plan)));
  if (bytes.length > 256000) throw importFinancialError('ORDER_IMPORT_ORDER_TOO_LARGE', 422);
  const nonce = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', financialImportKey(secret, 'encryption'), nonce);
  cipher.setAAD(Buffer.from(financialImportHash(secret, 'plan-aad', { scope, planHash })));
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url');
}
export function openFinancialPlan(
  secret: string,
  scope: ImportFinancialScope,
  planHash: string,
  ciphertext: string,
) {
  try {
    if (ciphertext.length > 342000 || !/^[A-Za-z0-9_-]+$/.test(ciphertext)) throw new Error();
    const bytes = Buffer.from(ciphertext, 'base64url');
    if (bytes.length < 29 || bytes.toString('base64url') !== ciphertext) throw new Error();
    const cipher = createDecipheriv(
      'aes-256-gcm',
      financialImportKey(secret, 'encryption'),
      bytes.subarray(0, 12),
    );
    cipher.setAAD(Buffer.from(financialImportHash(secret, 'plan-aad', { scope, planHash })));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return financialImportPlanSchema.parse(
      JSON.parse(
        Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'),
      ) as unknown,
    );
  } catch {
    throw importFinancialError('ORDER_IMPORT_FINANCIAL_PAYLOAD_INVALID');
  }
}
