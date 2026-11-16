import { AppError } from '../../domain/errors.js';
const invalid = () =>
  new AppError(503, 'REPORT_DATA_INVALID', 'Some report values could not be processed.');
export function pythonRoundInteger(value: number): number {
  if (!Number.isFinite(value)) throw invalid();
  const absolute = Math.abs(value),
    floor = Math.floor(absolute),
    fraction = absolute - floor,
    result = fraction > 0.5 || (fraction === 0.5 && floor % 2) ? floor + 1 : floor;
  return result === 0 ? 0 : value < 0 ? -result : result;
}
/** Preserve the source float strings, including .0, negative zero and exponent padding. */
export function pythonFloatString(value: number): string {
  if (!Number.isFinite(value)) throw invalid();
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
