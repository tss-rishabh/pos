import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gt, isNotNull, isNull, lt, or, type SQLWrapper } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import { pageQuery } from './contracts.js';

export const administrationCollectionPageQuery = pageQuery.extend({
  after: z
    .string()
    .regex(/^(?:0|[1-9]\d{0,19}|c1\.[A-Za-z0-9_-]{1,2048})$/)
    .default('0'),
  limit: z.coerce.number().int().min(1).max(500).default(30),
  sort: z
    .string()
    .regex(/^[a-zA-Z][a-zA-Z0-9]{0,31}$/)
    .optional(),
  direction: z.enum(['asc', 'desc']).optional(),
});
export interface CollectionPage {
  after: string;
  limit: number;
  search: string;
  active: 'true' | 'false' | 'all';
  sort?: string;
  direction?: 'asc' | 'desc';
}
type Value = string | number | bigint | boolean | null;
export interface CollectionSort {
  column: SQLWrapper;
  value: (row: Record<string, unknown>) => Value;
  type: 'text' | 'integer' | 'boolean';
}
const cursor = z
  .object({
    scope: z.string().regex(/^[a-f0-9]{64}$/),
    id: identifier,
    value: z.union([z.string().max(1200), z.null()]),
  })
  .strict();
/** SQL collation performs both comparison and ordering; no JavaScript/locale sorting. */
export function administrationCollectionPage(
  page: CollectionPage,
  scope: string,
  id: CollectionSort,
  fields: Readonly<Record<string, CollectionSort>>,
) {
  const key = page.sort ?? 'id',
    selected = key === 'id' ? id : fields[key];
  if (!selected)
    throw new AppError(400, 'ADMINISTRATION_SORT_INVALID', 'Choose a supported sort column.');
  const direction = page.direction ?? 'asc',
    forward = direction === 'asc';
  const binding = createHash('sha256')
    .update(JSON.stringify([scope, key, direction, page.search, page.active]))
    .digest('hex');
  const encode = (row: Record<string, unknown>) => {
    if (!page.sort && !page.direction) return String(id.value(row));
    const value = selected.value(row);
    return (
      'c1.' +
      Buffer.from(
        JSON.stringify({
          scope: binding,
          id: String(id.value(row)),
          value: value === null ? null : String(value),
        }),
      ).toString('base64url')
    );
  };
  let boundary;
  if (page.after !== '0') {
    if (!page.sort && !page.direction)
      boundary = gt(id.column, BigInt(identifier.parse(page.after)));
    else {
      try {
        if (!page.after.startsWith('c1.')) throw new Error('Invalid cursor');
        const saved = cursor.parse(
          JSON.parse(Buffer.from(page.after.slice(3), 'base64url').toString('utf8')) as unknown,
        );
        if (saved.scope !== binding) throw new Error('Changed cursor scope');
        const nextId = forward ? gt(id.column, BigInt(saved.id)) : lt(id.column, BigInt(saved.id));
        let value: string | bigint | boolean | null = saved.value;
        if (value !== null && selected.type === 'integer')
          value = BigInt(
            z
              .string()
              .regex(/^-?\d{1,20}$/)
              .parse(value),
          );
        if (value !== null && selected.type === 'boolean')
          value = z.enum(['true', 'false', '1', '0']).parse(value) === 'true' || value === '1';
        boundary =
          value === null
            ? forward
              ? or(isNotNull(selected.column), and(isNull(selected.column), nextId))
              : and(isNull(selected.column), nextId)
            : or(
                forward ? gt(selected.column, value) : lt(selected.column, value),
                forward ? undefined : isNull(selected.column),
                and(eq(selected.column, value), nextId),
              );
      } catch {
        throw new AppError(
          400,
          'ADMINISTRATION_CURSOR_INVALID',
          'Refresh this collection after changing its filters.',
        );
      }
    }
  }
  return {
    boundary,
    order: [
      forward ? asc(selected.column) : desc(selected.column),
      forward ? asc(id.column) : desc(id.column),
    ],
    finish: <T extends Record<string, unknown>>(rows: T[]) => ({
      data: rows.slice(0, page.limit),
      nextCursor: rows.length > page.limit ? encode(rows[page.limit - 1]!) : null,
    }),
  };
}
export const collectionField = (
  column: SQLWrapper,
  key: string,
  type: CollectionSort['type'] = 'text',
): CollectionSort => ({
  column,
  type,
  value: (row) => {
    const value = row[key];
    if (value === null || value === undefined) return null;
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'bigint' ||
      typeof value === 'boolean'
    )
      return value;
    throw new AppError(
      503,
      'ADMINISTRATION_SORT_UNAVAILABLE',
      'This collection sort value is unavailable.',
    );
  },
});
