/**
 * CPython 3.10 text and number semantics that legacy Django (backend-pos-web@78d5b63) wrote to
 * durable columns, request bodies and reports. One implementation of each, shared by every
 * module. Reporting/storage compatibility only: new payment arithmetic uses exact minor units.
 */

/** CPython round(float, 2), including binary ties such as round(2.675, 2) == 2.67. */
export function pythonRound2(value: number): number {
  if (!Number.isFinite(value) || value === 0) return value;
  // Every double of magnitude >= 2**52 is an integer, so CPython returns it unchanged; scaling
  // by 100 would overflow Number near Number.MAX_VALUE.
  if (Math.abs(value) >= 2 ** 52) return value;
  const bytes = new DataView(new ArrayBuffer(8));
  bytes.setFloat64(0, value);
  const raw = bytes.getBigUint64(0),
    negative = raw >> 63n !== 0n;
  const exponent = Number((raw >> 52n) & 0x7ffn);
  const fraction = raw & ((1n << 52n) - 1n);
  let numerator = (exponent ? (1n << 52n) | fraction : fraction) * 100n;
  const power = (exponent ? exponent - 1023 : -1022) - 52;
  let denominator = 1n;
  if (power >= 0) numerator <<= BigInt(power);
  else denominator <<= BigInt(-power);
  let rounded = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder * 2n > denominator || (remainder * 2n === denominator && rounded % 2n !== 0n))
    rounded++;
  const result = Number(rounded) / 100;
  return negative ? -result : result;
}

/**
 * CPython `repr(float)` / `str(float)`: shortest round-trip digits, `.0` on integral values,
 * `-0.0`, and scientific notation below 1e-4 or from 1e16 with a two-digit exponent (`1e-07`).
 */
export function pythonFloatRepr(value: number): string {
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : value < 0 ? '-inf' : 'nan';
  if (value === 0) return Object.is(value, -0) ? '-0.0' : '0.0';
  const absolute = Math.abs(value);
  if (absolute < 1e-4 || absolute >= 1e16) {
    const [mantissa, exponent] = value.toExponential().split('e'),
      power = Number(exponent);
    return `${mantissa}e${power < 0 ? '-' : '+'}${String(Math.abs(power)).padStart(2, '0')}`;
  }
  const text = String(value);
  return text.includes('.') ? text : text + '.0';
}

/** CPython 3 `repr(str)`. */
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

/**
 * CPython `str()` of a value decoded from JSON, as Django stores a dict in a TextField.
 * Integral numbers print as ints unless `floats` says the source held Python floats.
 */
export function pythonRepr(value: unknown, floats = false): string {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'number')
    return floats || !Number.isInteger(value) ? pythonFloatRepr(value) : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return pythonStringRepr(value);
  if (Array.isArray(value))
    return '[' + value.map((item) => pythonRepr(item, floats)).join(', ') + ']';
  if (typeof value === 'object')
    return (
      '{' +
      Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => pythonStringRepr(key) + ': ' + pythonRepr(item, floats))
        .join(', ') +
      '}'
    );
  return pythonStringRepr(String(value));
}

/** `str(dict)` of a legacy `pay_dict` whose values are Python floats. */
export function pythonFloatDict(value: Readonly<Record<string, number>>): string {
  return pythonRepr(value, true);
}

/**
 * The literal CPython `int(str)` accepts in base 10 for ASCII input (surrounding whitespace,
 * a sign, `_` between digits), normalised to `[-+]?digits`; `null` where `int()` raises.
 */
export function pythonIntLiteral(value: string): string | null {
  const text = value.trim();
  return /^[+-]?\d+(?:_\d+)*$/.test(text) ? text.replace(/_/g, '') : null;
}

/**
 * CPython `json.dumps(value)` with its defaults: `ensure_ascii=True`, `", "` and `": "`
 * separators, insertion-ordered dicts, and `NaN`/`Infinity` for non-finite floats.
 */
export function pythonJsonDumps(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    let out = '"';
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index),
        character = value[index]!;
      if (character === '"') out += '\\"';
      else if (character === '\\') out += '\\\\';
      else if (character === '\n') out += '\\n';
      else if (character === '\r') out += '\\r';
      else if (character === '\t') out += '\\t';
      else if (character === '\b') out += '\\b';
      else if (character === '\f') out += '\\f';
      else if (code < 0x20 || code > 0x7e) out += '\\u' + code.toString(16).padStart(4, '0');
      else out += character;
    }
    return out + '"';
  }
  if (Array.isArray(value)) return '[' + value.map(pythonJsonDumps).join(', ') + ']';
  if (typeof value === 'object')
    return (
      '{' +
      Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => `${pythonJsonDumps(key)}: ${pythonJsonDumps(item)}`)
        .join(', ') +
      '}'
    );
  return 'null';
}
