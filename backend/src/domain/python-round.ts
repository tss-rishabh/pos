/** CPython round(float, 2), including binary ties such as round(2.675, 2) == 2.67.
 * Reporting compatibility only. New payment arithmetic uses exact minor units.
 */
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
