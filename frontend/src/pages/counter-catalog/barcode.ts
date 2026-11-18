import { z } from 'zod';
import { NetworkError, request } from '../../api/client';
import { productSchema } from '../../api/schemas';
import type { Product } from '../../api/types';
import { db, type LocalDraft } from '../../offline/database';

/** GS1 is a signed BIGINT in the source; input-mask placeholders are not digits. */
export function canonicalBarcode(input: string): string {
  const value = input.trim().replaceAll('_', '');
  if (input.length > 100 || !/^\d+$/.test(value) || BigInt(value) > 9223372036854775807n)
    throw new Error('Enter a valid numeric barcode.');
  return BigInt(value).toString();
}
const barcodeResponse = z.object({ matchedBarcode: z.string(), product: productSchema });
export async function resolveBarcode(
  ownerId: string,
  storeId: string,
  input: string,
  signal: AbortSignal,
): Promise<Product> {
  const barcode = canonicalBarcode(input);
  signal.throwIfAborted();
  try {
    const result = await request(
      `/api/v1/stores/${storeId}/catalog/products/by-barcode/${barcode}`,
      { operatorId: ownerId, signal, cache: 'no-store' },
      barcodeResponse,
    );
    if (result.matchedBarcode !== barcode)
      throw new Error('The barcode response did not match this scan. Scan again.');
    if (result.product.stock <= 0) throw new Error('This product is out of stock.');
    return result.product;
  } catch (error) {
    if (!(error instanceof NetworkError) || signal.aborted) throw error;
    if (barcode === '0') throw new Error('This barcode was not found.');
    const cached = await db.catalog.where('[ownerId+storeId]').equals([ownerId, storeId]).toArray();
    signal.throwIfAborted();
    const primaryMatches = cached.filter((product) => {
      if (product.barcode === null) return false;
      try {
        return canonicalBarcode(product.barcode) === barcode;
      } catch {
        return false;
      }
    });
    const aliases = await db.catalogBarcodes
      .where('[ownerId+storeId+barcode]')
      .equals([ownerId, storeId, barcode])
      .toArray();
    signal.throwIfAborted();
    const candidates = new Set([
      ...primaryMatches.map((product) => product.id),
      ...aliases.map((alias) => alias.productId),
    ]);
    const product =
      candidates.size === 1 ? cached.find((item) => candidates.has(item.id)) : undefined;
    // Alias metadata grants no stock authority; a contradictory primary barcode is ambiguous too.
    if (!product || product.stock <= 0)
      throw new Error('This barcode cannot be uniquely verified offline. Connect and scan again.');
    return product;
  }
}
export function addProduct(draft: LocalDraft, product: Product): LocalDraft {
  const found = draft.lines.some((line) => line.productId === product.id);
  return {
    ...draft,
    lines: found
      ? draft.lines.map((line) =>
          line.productId === product.id
            ? { ...line, quantity: Math.min(999, line.quantity + 1) }
            : line,
        )
      : [
          ...draft.lines,
          {
            productId: product.id,
            name: product.name,
            barcode: product.barcode,
            unitPrice: product.price,
            quantity: 1,
          },
        ],
  };
}
export interface ScanScope {
  ownerId: string;
  storeId: string;
  counterId: string;
  draftId: string;
}
export async function commitScannedProduct(
  scope: ScanScope,
  product: Product,
  signal: AbortSignal,
  isCurrent: () => boolean,
  matchedBarcode?: string,
): Promise<void> {
  const check = () => {
    signal.throwIfAborted();
    if (!isCurrent()) throw new DOMException('The active sale changed.', 'AbortError');
  };
  check();
  await db.transaction('rw', db.drafts, db.catalog, db.catalogBarcodes, async () => {
    const draft = await db.drafts.get([scope.ownerId, scope.draftId]);
    check();
    if (!draft || draft.storeId !== scope.storeId || draft.counterId !== scope.counterId)
      throw new DOMException('The active sale changed.', 'AbortError');
    await db.catalog.put({
      ...product,
      ownerId: scope.ownerId,
      storeId: scope.storeId,
      cachedAt: Date.now(),
    });
    check();
    if (matchedBarcode !== undefined) {
      const barcode = canonicalBarcode(matchedBarcode);
      if (barcode === '0') throw new Error('This barcode was not found.');
      await db.catalogBarcodes
        .where('[ownerId+storeId+barcode]')
        .equals([scope.ownerId, scope.storeId, barcode])
        .delete();
      await db.catalogBarcodes.put({
        ownerId: scope.ownerId,
        storeId: scope.storeId,
        barcode,
        productId: product.id,
        observedAt: Date.now(),
      });
      check();
    }
    await db.drafts.put({ ...addProduct(draft, product), updatedAt: Date.now() });
    check(); // Throwing here rolls back the write if the user changed sale during IndexedDB work.
  });
}
