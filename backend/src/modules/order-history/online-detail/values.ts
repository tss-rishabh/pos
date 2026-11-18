import { Decimal } from 'decimal.js';
import { detailInvalid } from './errors.js';

export function detailDecimal(value: number | string | null): string {
  if (value === null) throw detailInvalid();
  try {
    const number = new Decimal(value);
    if (!number.isFinite()) throw detailInvalid();
    return number.toFixed();
  } catch {
    throw detailInvalid();
  }
}
export function detailWallet(value: number): string {
  const rounded = new Decimal(detailDecimal(value)).toFixed(2, Decimal.ROUND_HALF_UP);
  return new Decimal(rounded).isZero() ? '0.00' : rounded;
}
export function safeTrackingUrl(value: string | null): string | null {
  if (!value || value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
/** Flat legacy dict literals only; no eval, expressions, constructors or nested payloads. */
export function detailPaymentEntries(value: string | null) {
  if (!value?.trim()) return [];
  if (Buffer.byteLength(value) > 100000) throw detailInvalid();
  let index = 0;
  const skip = () => {
    while (/\s/.test(value[index] ?? '') && index < value.length) index++;
  };
  const string = () => {
    const quote = value[index++];
    if (quote !== "'" && quote !== '"') throw detailInvalid();
    let result = '';
    while (index < value.length) {
      const char = value[index++]!;
      if (char === quote) return result;
      if (char === '\\') {
        const escaped = value[index++];
        const escapes: Record<string, string> = {
          n: '\n',
          r: '\r',
          t: '\t',
          b: '\b',
          f: '\f',
          '\\': '\\',
          "'": "'",
          '"': '"',
          '/': '/',
        };
        if (escaped === 'u') {
          const digits = value.slice(index, index + 4);
          if (!/^[a-f0-9]{4}$/i.test(digits)) throw detailInvalid();
          result += String.fromCharCode(parseInt(digits, 16));
          index += 4;
        } else if (escaped && escaped in escapes) result += escapes[escaped];
        else throw detailInvalid();
      } else {
        if (char < ' ') throw detailInvalid();
        result += char;
      }
      if (result.length > 4096) throw detailInvalid();
    }
    throw detailInvalid();
  };
  skip();
  if (value[index++] !== '{') throw detailInvalid();
  const entries: { method: string; value: string | null }[] = [],
    seen = new Set<string>();
  skip();
  while (value[index] !== '}') {
    const method = string();
    skip();
    if (!method || method.length > 128 || seen.has(method) || value[index++] !== ':')
      throw detailInvalid();
    skip();
    let amount: string | null;
    if (value[index] === "'" || value[index] === '"') amount = string();
    else {
      const token =
        /^(?:None|null|True|False|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
          value.slice(index),
        )?.[0];
      if (!token) throw detailInvalid();
      index += token.length;
      amount =
        token === 'None' || token === 'null'
          ? null
          : token === 'True'
            ? 'true'
            : token === 'False'
              ? 'false'
              : token;
    }
    if (amount !== null && amount.length > 1024) throw detailInvalid();
    entries.push({ method, value: amount });
    seen.add(method);
    if (entries.length > 100) throw detailInvalid();
    skip();
    if (value[index] === ',') {
      index++;
      skip();
    } else if (value[index] !== '}') throw detailInvalid();
  }
  index++;
  skip();
  if (index !== value.length) throw detailInvalid();
  return entries;
}
