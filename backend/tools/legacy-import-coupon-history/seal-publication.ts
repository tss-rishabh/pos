/** Read-only candidate verifier; stdout is a review artifact, never a cloud write. */
import { verifyCouponSourceCapture } from '../../src/modules/legacy-order-imports/benefit-profile/history-publication.js';
import {
  readCouponBigQueryOptions,
  couponWarehouseSourceDocumentBytes,
} from '../../src/modules/legacy-order-imports/benefit-profile/history-warehouse-contracts.js';
import {
  couponWarehouseCapture,
  sealCouponWarehousePublication,
} from '../../src/modules/legacy-order-imports/benefit-profile/history-warehouse-publication.js';
async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--seal-candidate')
    throw Error('EXPLICIT_CANDIDATE_REVIEW_REQUIRED');
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    length += bytes.length;
    if (length > couponWarehouseSourceDocumentBytes) throw Error('SOURCE_DOCUMENT_TOO_LARGE');
    chunks.push(bytes);
  }
  const options = readCouponBigQueryOptions(),
    authority = {
      sourceKey: process.env.CSV_COUPON_SOURCE_PROOF_KEY ?? '',
      publicationKey: process.env.CSV_COUPON_PUBLICATION_KEY ?? '',
      historyKey: process.env.CSV_COUPON_HISTORY_KEY ?? '',
    };
  const capture = verifyCouponSourceCapture(
    JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
    authority.sourceKey,
  );
  const publication = await sealCouponWarehousePublication(
    capture,
    couponWarehouseCapture(options, { sourceKey: authority.sourceKey }),
    authority,
    { signal: AbortSignal.timeout(options.CSV_COUPON_QUERY_TIMEOUT_MS) },
  );
  process.stdout.write(JSON.stringify(publication) + '\n');
}
void main().catch(() => {
  process.stderr.write(
    JSON.stringify({ resource: 'csv-coupon-publication', code: 'PUBLICATION_REVIEW_FAILED' }) +
      '\n',
  );
  process.exitCode = 1;
});
