import { identifier } from '../domain/validation.js';
import { AppError } from '../domain/errors.js';

/** Read the first generated ID; never infer a sequence or loop over an unsafe JS number. */
export function generatedId(result: unknown): bigint {
  const header: unknown = Array.isArray(result) ? result[0] : result;
  const raw =
    typeof header === 'object' && header !== null && 'insertId' in header
      ? header.insertId
      : undefined;
  const text =
    typeof raw === 'string'
      ? raw
      : typeof raw === 'bigint'
        ? raw.toString()
        : typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0
          ? String(raw)
          : undefined;
  const parsed = identifier.safeParse(text);
  if (!parsed.success)
    throw new AppError(
      500,
      'GENERATED_IDENTIFIER_UNAVAILABLE',
      'The saved record identifier could not be confirmed.',
    );
  return BigInt(parsed.data);
}
