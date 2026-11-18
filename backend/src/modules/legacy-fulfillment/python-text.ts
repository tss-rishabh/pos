/**
 * Text renderings legacy Django stores verbatim. They are durable column values
 * (`pos_transaction_logs.pay_dict`, `hyperlocal_order_log.error_msg`,
 * `hyperlocal_to_online_order_logs.location_ids`), so the exact Python formatting matters.
 */
export type PythonValue =
  | string
  | number
  | boolean
  | null
  | readonly PythonValue[]
  | { readonly [key: string]: PythonValue };

/** Python 3 `repr(str)`. */
export function pythonStringRepr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = quote;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (character === '\\') out += '\\\\';
    else if (character === quote) out += '\\' + quote;
    else if (character === '\n') out += '\\n';
    else if (character === '\r') out += '\\r';
    else if (character === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f) out += '\\x' + code.toString(16).padStart(2, '0');
    else if (code >= 0x80 && code < 0xa0) out += '\\x' + code.toString(16).padStart(2, '0');
    else out += character;
  }
  return out + quote;
}
/** Python `repr(float)` for finite values (`0.0`, `12.5`). */
export function pythonFloatRepr(value: number): string {
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : value < 0 ? '-inf' : 'nan';
  return Number.isInteger(value) && Math.abs(value) < 1e16 ? value.toFixed(1) : String(value);
}
/** Python `str()` of dicts/lists/scalars decoded from JSON. Integers stay integers. */
export function pythonRepr(value: PythonValue, floats = false): string {
  if (value === null) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number')
    return floats || !Number.isInteger(value) ? pythonFloatRepr(value) : String(value);
  if (typeof value === 'string') return pythonStringRepr(value);
  if (Array.isArray(value))
    return (
      '[' +
      (value as readonly PythonValue[]).map((item) => pythonRepr(item, floats)).join(', ') +
      ']'
    );
  return (
    '{' +
    Object.entries(value as { readonly [key: string]: PythonValue })
      .map(([key, item]) => pythonStringRepr(key) + ': ' + pythonRepr(item, floats))
      .join(', ') +
    '}'
  );
}
/** `str(dict)` of a legacy `pay_dict` whose values are Python floats. */
export function pythonFloatDict(value: Readonly<Record<string, number>>): string {
  return pythonRepr(value, true);
}
/** Python `json.dumps(value)` (ensure_ascii, `', '` and `': '` separators). */
export function pythonJsonDumps(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NaN';
  if (typeof value === 'string')
    return JSON.stringify(value).replace(
      /[\u007f-￿]/g,
      (character) => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'),
    );
  if (Array.isArray(value)) return '[' + value.map(pythonJsonDumps).join(', ') + ']';
  if (typeof value === 'object')
    return (
      '{' +
      Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => pythonJsonDumps(key) + ': ' + pythonJsonDumps(item))
        .join(', ') +
      '}'
    );
  return 'null';
}
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
