import { AppError } from '../../domain/errors.js';
import { pythonFloatRepr } from '../../domain/python-compat.js';
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
/** CPython float `str()` for report cells; a non-finite value is a data error, not `inf`. */
export function pythonFloatString(value: number): string {
  if (!Number.isFinite(value)) throw invalid();
  return pythonFloatRepr(value);
}
