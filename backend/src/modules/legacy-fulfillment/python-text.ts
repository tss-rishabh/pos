/**
 * Python values decoded from JSON as the hyperlocal views hold them, and the
 * `hyperlocal_to_online_order_logs.location_ids` text. The CPython `repr`/`json.dumps`
 * renderings live in `domain/python-compat.ts`.
 */
import { pythonRepr } from '../../domain/python-compat.js';

export type PythonValue =
  | string
  | number
  | boolean
  | null
  | readonly PythonValue[]
  | { readonly [key: string]: PythonValue };

/** JSON value → PythonValue (drops anything that JSON cannot carry). */
export function asPythonValue(value: unknown): PythonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map(asPythonValue);
  if (typeof value === 'object' && value)
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        asPythonValue(item),
      ]),
    );
  return null;
}
/**
 * `str(next_ids)` where legacy holds either the raw `orders.next_location_ids` text (a str,
 * possibly None) or the `json.loads` of it (a list). `parsed` selects which.
 */
export function legacyLocationIdsText(raw: string | null, parsed: boolean): string {
  if (!parsed) return raw === null ? 'None' : raw;
  const values = parseLocationIds(raw);
  return pythonRepr(values);
}
/** `json.loads(next_ids)` with legacy's `except: next_ids = []`. Non-lists stay as decoded. */
export function parseLocationIds(raw: string | null): PythonValue[] {
  if (raw === null) return [];
  try {
    const value = asPythonValue(JSON.parse(raw.trim()) as unknown);
    return Array.isArray(value) ? (value as PythonValue[]) : [];
  } catch {
    return [];
  }
}
/** Store IDs out of a decoded `next_location_ids` list (legacy accepts ints or digit strings). */
export function locationStoreIds(values: readonly PythonValue[]): string[] {
  return values.flatMap((value) =>
    (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) ||
    (typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value))
      ? [String(value)]
      : [],
  );
}
