import { AppError } from '../../domain/errors.js';

export function sourcePosUserFullName(first: string | null, last: string | null) {
  return `${first || ''} ${last || ''}`.replace(
    /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g,
    '',
  );
}

/** Django Paginator resets an invalid fractional/out-of-range page to the first page. */
export function sourcePageStart(start: number, length: number, count: number) {
  return start % length !== 0 || start >= count ? 0 : start;
}
function reconciliation(): never {
  throw new AppError(
    422,
    'INVENTORY_AUDIT_RECONCILIATION_REQUIRED',
    'Inventory history contains an invalid stock value. Reconcile the source record before continuing.',
  );
}
function difference(before: string, after: string): number | string {
  if (/^-?\d+$/.test(before) && /^-?\d+$/.test(after)) {
    const value = BigInt(after) - BigInt(before);
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : String(value);
  }
  const value =
    Number(after === 'true' ? 1 : after === 'false' ? 0 : after) -
    Number(before === 'true' ? 1 : before === 'false' ? 0 : before);
  return Number.isFinite(value) ? value : reconciliation();
}
/** Preserve Python's first dictionary-value subtraction, including insertion order of numeric keys. */
export function sourceStockDelta(before: string, after: string): number | string | null {
  const literals = new WeakMap<object, Map<string, string>>();
  function revive(this: unknown, key: string, value: unknown, context?: { source?: string }) {
    if (this !== null && typeof this === 'object' && context?.source) {
      const values = literals.get(this) || new Map<string, string>();
      values.set(key, context.source);
      literals.set(this, values);
    }
    return value;
  }
  let first: unknown, second: unknown;
  try {
    first = JSON.parse(before, revive) as unknown;
    second = JSON.parse(after, revive) as unknown;
  } catch {
    return reconciliation();
  }
  const integer = /^\s*-?(?:0|[1-9]\d*)\s*$/;
  if (integer.test(before) && integer.test(after)) return difference(before.trim(), after.trim());
  const dictionary = (value: unknown) =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  if (dictionary(first) && dictionary(second)) {
    if (!Object.keys(first as object).length || !Object.keys(second as object).length) return null;
    const firstKey = /^\s*\{\s*("(?:[^"\\]|\\.)*")\s*:/;
    const firstLiteral = (raw: string, parsed: object) => {
      const keyToken = firstKey.exec(raw)?.[1];
      if (!keyToken) return undefined;
      const key: unknown = JSON.parse(keyToken);
      return typeof key === 'string' ? literals.get(parsed)?.get(key) : undefined;
    };
    const a = firstLiteral(before, first as object),
      b = firstLiteral(after, second as object);
    const numeric = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false)$/;
    return a !== undefined && b !== undefined && numeric.test(a) && numeric.test(b)
      ? difference(a, b)
      : reconciliation();
  }
  return 0;
}
const cdn = 'https://prod-img.thesouledstore.com/public/theSoul/uploads/catalog/product/';
export function sourceProductImages(value: string | null) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value || '{}') as unknown;
  } catch {
    parsed = {};
  }
  const record =
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const safe = (key: string) =>
    Array.isArray(record[key])
      ? (record[key] as unknown[])
          .filter(
            (entry): entry is string =>
              typeof entry === 'string' &&
              entry.length <= 1024 &&
              !/[\x00-\x1f\\?#]/.test(entry) &&
              !entry.split('/').includes('..'),
          )
          .map((entry) => cdn + entry.split('/').map(encodeURIComponent).join('/'))
      : [];
  return { male: safe('male'), female: safe('female') };
}
