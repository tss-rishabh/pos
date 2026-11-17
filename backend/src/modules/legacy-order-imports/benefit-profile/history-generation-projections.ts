import { createHash } from 'node:crypto';
import { z } from 'zod';
import { generationPositiveId, generationSignedId } from './history-generation-control.js';
import { generationError, type GenerationProjection } from './history-generation-contracts.js';
export const generationRowSchema = z
  .object({
    id: generationPositiveId,
    userId: generationSignedId.nullable(),
    couponId: generationSignedId.nullable(),
    status: z.number().int().safe().nullable(),
    createdAt: z.string().max(40).nullable(),
  })
  .strict();
export type GenerationRow = z.infer<typeof generationRowSchema>;
const rowPrefix = (kind: 'order' | 'log') => 'pos-coupon-generation-' + kind + '-row-v1|';
export const generationChunkPrefix = 'pos-coupon-generation-chunk-v1\n';
export const generationSetPrefix = 'pos-coupon-generation-set-v1\n';
/** Exact ordered chunked SHA256 commitment to the fields used by all five
 * predicates. Calendar day is sufficient: source does not filter time-of-day. */
export function generationAccumulator(kind: 'order' | 'log') {
  const outer = createHash('sha256').update(generationSetPrefix);
  let chunk = createHash('sha256').update(generationChunkPrefix),
    inChunk = 0,
    rows = 0,
    last = 0n;
  function flush() {
    if (inChunk) {
      outer.update(chunk.digest('hex') + '\n');
      chunk = createHash('sha256').update(generationChunkPrefix);
      inChunk = 0;
    }
  }
  return {
    add(input: GenerationRow) {
      const v = generationRowSchema.parse(input),
        id = BigInt(v.id);
      if (id <= last) throw generationError('PROJECTION');
      last = id;
      const canonical =
        rowPrefix(kind) +
        [
          v.id,
          v.userId ?? '~',
          v.couponId ?? '~',
          v.status === null ? '~' : String(v.status),
          v.createdAt?.slice(0, 10) ?? '~',
        ].join('|');
      chunk.update(createHash('sha256').update(canonical).digest('hex') + '\n');
      inChunk++;
      rows++;
      if (inChunk === 1000) flush();
    },
    finish(): GenerationProjection {
      flush();
      return { rows: String(rows), uniqueRows: String(rows), hash: outer.digest('hex') };
    },
  };
}
export function generationHashCtes(kind: 'order' | 'log', table: string) {
  const id = kind === 'order' ? 'order_id' : 'log_id',
    tick = String.fromCharCode(96);
  const canonical =
    "CONCAT('" +
    rowPrefix(kind) +
    "'," +
    [
      id,
      "COALESCE(user_id,'~')",
      'COALESCE(' + (kind === 'order' ? 'coupon_used' : 'coupon_id') + ",'~')",
      'COALESCE(CAST(' + (kind === 'order' ? 'order_status' : 'status') + " AS STRING),'~')",
      "COALESCE(FORMAT_DATETIME('%Y-%m-%d',created_at),'~')",
    ].join(",'|',") +
    ')';
  return (
    kind +
    '_hash_rows AS (SELECT ' +
    id +
    ' AS id,LOWER(TO_HEX(SHA256(' +
    canonical +
    '))) AS row_hash,ROW_NUMBER() OVER(ORDER BY SAFE_CAST(' +
    id +
    ' AS INT64)) AS rn FROM ' +
    table +
    '),\n' +
    kind +
    "_hash_chunks AS (SELECT DIV(rn-1,1000) AS chunk_index,LOWER(TO_HEX(SHA256(CONCAT('pos-coupon-generation-chunk-v1\\n',STRING_AGG(CONCAT(row_hash,'\\n'),'' ORDER BY rn))))) AS chunk_hash FROM " +
    kind +
    '_hash_rows GROUP BY chunk_index),\n' +
    kind +
    '_projection AS (SELECT CAST((SELECT COUNT(*) FROM ' +
    kind +
    '_hash_rows) AS STRING) AS ' +
    tick +
    'rows' +
    tick +
    ',CAST((SELECT COUNT(DISTINCT id) FROM ' +
    kind +
    "_hash_rows) AS STRING) AS uniqueRows,LOWER(TO_HEX(SHA256(CONCAT('pos-coupon-generation-set-v1\\n',COALESCE(STRING_AGG(CONCAT(chunk_hash,'\\n'),'' ORDER BY chunk_index),''))))) AS " +
    tick +
    'hash' +
    tick +
    ' FROM ' +
    kind +
    '_hash_chunks)'
  );
}
