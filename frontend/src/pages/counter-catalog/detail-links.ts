import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import { db } from '../../offline/database';
import type { Product } from '../../api/types';
export function productDetailPath(product: Pick<Product, 'id' | 'parentId'>): string {
  return `/catalog/products/${product.parentId !== '0' ? product.parentId : product.id}`;
}
/** One local indexed read for the cart, including scanned products absent from the fuzzy page. */
export function useCartProductLinks(ownerId: string, storeId: string, productIds: string[]) {
  const productIdList = productIds.join(',');
  const identity = JSON.stringify([ownerId, storeId, productIdList]);
  const [result, setResult] = useState<{ identity: string; paths: ReadonlyMap<string, string> }>();
  useEffect(() => {
    const subscription = liveQuery(() =>
      db.catalog.bulkGet(
        (productIdList ? productIdList.split(',') : []).map((id) => [ownerId, storeId, id]),
      ),
    ).subscribe({
      next: (products) =>
        setResult({
          identity,
          paths: new Map(
            products.flatMap((product) =>
              product ? [[product.id, productDetailPath(product)]] : [],
            ),
          ),
        }),
      error: () => setResult({ identity, paths: new Map() }),
    });
    return () => subscription.unsubscribe();
  }, [identity, ownerId, storeId, productIdList]);
  return result?.identity === identity ? result.paths : undefined;
}
