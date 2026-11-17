import { createHmac } from 'node:crypto';
import { importFinancialError } from '../financial-adapter-crypto.js';

/** Cross-language canonical JSON uses code-point ordering, independent of host
 * ICU locale. In particular refundInputHash/refundable sort differently under
 * JavaScript localeCompare versus Python sort_keys. Never sign platform order.
 */
export function benefitDigest(purpose: string, input: unknown, key: string) {
  const invalid = () => importFinancialError('ORDER_IMPORT_BENEFIT_PROOF_INVALID');
  if (!/^[a-z][a-z-]{0,40}$/.test(purpose) || !/^[!-~]{32,4096}$/.test(key)) throw invalid();
  let nodes = 0;
  const normalize = (value: unknown, depth: number): unknown => {
    if (++nodes > 60000 || depth > 32) throw invalid();
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
    if (Array.isArray(value)) return value.map((child) => normalize(child, depth + 1));
    if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
      throw invalid();
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, child]) => [name, normalize(child, depth + 1)]),
    );
  };
  const body = JSON.stringify({
    kind: 'legacy-order-imports.source.benefit.' + purpose + '.v1',
    input: normalize(input, 0),
  });
  if (Buffer.byteLength(body) > 1000000) throw invalid();
  return createHmac('sha256', key).update(body).digest('hex');
}
