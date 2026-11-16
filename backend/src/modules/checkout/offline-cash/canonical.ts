/** The same bounded integer/string JSON representation is used by WebCrypto. */
export function canonicalCashJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value))
    return '[' + value.map((entry: unknown) => canonicalCashJson(entry)).join(',') + ']';
  if (
    typeof value === 'object' &&
    value &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  ) {
    const record = value as Record<string, unknown>;
    return (
      '{' +
      Object.keys(record)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonicalCashJson(record[key]))
        .join(',') +
      '}'
    );
  }
  throw new Error('Offline cash evidence contains an unsupported value.');
}
