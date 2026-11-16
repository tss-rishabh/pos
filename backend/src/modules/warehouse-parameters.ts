import { BigQuery, BigQueryTimestamp } from '@google-cloud/bigquery';
import { AppError } from '../domain/errors.js';

export type WarehouseParameterTypes = Readonly<Record<string, string | readonly string[]>>;

function timestamp(value: string | Date | BigQueryTimestamp): BigQueryTimestamp {
  const original = value instanceof BigQueryTimestamp ? value : BigQuery.timestamp(value);
  // This SDK pads string timestamps to nanoseconds, while the deployed query
  // API accepts at most microseconds. Remove only padding; never round a bound.
  const fraction = /^(.*\.\d{6})(\d+)Z$/.exec(original.value);
  if (!fraction) return original;
  if (/[1-9]/.test(fraction[2]!))
    throw new AppError(
      500,
      'WAREHOUSE_TIMESTAMP_PRECISION',
      'Use an explicitly rounded microsecond query bound.',
    );
  const wrapped = BigQuery.timestamp(original.value);
  wrapped.value = fraction[1] + 'Z';
  return wrapped;
}

/** Explicit temporal types require SDK value wrappers: a plain string otherwise
 * serializes as an empty parameterValue and is interpreted as SQL NULL. */
export function normalizeWarehouseParameters(
  params: Readonly<Record<string, unknown>>,
  types: WarehouseParameterTypes,
): Record<string, unknown> {
  function normalize(value: unknown, type: string | readonly string[] | undefined): unknown {
    if (value === null || value === undefined || type === undefined) return value;
    if (typeof type !== 'string')
      return type.length === 1 && Array.isArray(value)
        ? value.map((item: unknown) => normalize(item, type[0]))
        : value;
    if (typeof value !== 'string') {
      if (
        type.toUpperCase() === 'TIMESTAMP' &&
        (value instanceof Date || value instanceof BigQueryTimestamp)
      )
        return timestamp(value);
      return value; // Existing SDK wrappers retain their exact value and precision.
    }
    switch (type.toUpperCase()) {
      case 'DATE':
        return BigQuery.date(value);
      case 'DATETIME':
        return BigQuery.datetime(value);
      case 'TIME':
        return BigQuery.time(value);
      case 'TIMESTAMP':
        return timestamp(value);
      case 'GEOGRAPHY':
        return BigQuery.geography(value);
      default:
        return value;
    }
  }
  return Object.fromEntries(
    Object.entries(params).map(([name, value]) => [name, normalize(value, types[name])]),
  );
}
