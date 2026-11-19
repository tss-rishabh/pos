import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { z } from 'zod';
import { request } from '../../api/client';
import type { Product } from '../../api/types';
import { currency } from '../../lib/format';

/** Legacy picker columns (`create_order.html:784-802`, `store_products_datatable.py:269-312`). */
export const barcodeMissingMarker = 'Barcode Missing \n (Please ask administrator to set barcode)';
const stockLocationSchema = z.object({
  productId: z.string().regex(/^\d{1,20}$/),
  heldStock: z.number().int(),
  storageStock: z.string(),
});
const stockLocationPage = z.object({ data: z.array(stockLocationSchema) });
export type StockLocation = z.infer<typeof stockLocationSchema>;

/** Legacy offers add-to-cart only when `stock > 0` and a GS1 barcode exists (`CO:1818-1824`). */
export function billable(product: Pick<Product, 'stock' | 'barcode'>): boolean {
  return product.stock > 0 && product.barcode !== null;
}

/** Held and storage stock for the loaded picker page; one read per 100 SKUs. */
export function useStockLocations(ownerId: string, storeId: string, productIds: string[]) {
  const ids = [...new Set(productIds)];
  return useQuery({
    queryKey: [ownerId, 'product-stock-locations', storeId, ids.join(',')],
    enabled: Boolean(storeId) && ids.length > 0,
    staleTime: 0,
    queryFn: async ({ signal }) => {
      const chunks: string[][] = [];
      for (let index = 0; index < ids.length; index += 100)
        chunks.push(ids.slice(index, index + 100));
      const pages = await Promise.all(
        chunks.map((chunk) =>
          request(
            `/api/v1/stores/${storeId}/catalog/stock-locations?${new URLSearchParams({ productIds: chunk.join(',') }).toString()}`,
            { signal, cache: 'no-store' },
            stockLocationPage,
          ),
        ),
      );
      return new Map(pages.flatMap((page) => page.data.map((row) => [row.productId, row])));
    },
  });
}

/** Barcode, Spl. Price, Ex. Price, Holded Stock and Storages Stock for one picker product. */
export function ProductInventoryDetails({
  product,
  location,
}: {
  product: Product;
  /** `undefined` while loading; `null` when the stock read failed or the device is offline. */
  location: StockLocation | null | undefined;
}) {
  const pending = location === undefined ? '…' : 'Unavailable';
  return (
    <dl className="counter-product-inventory" aria-label={`Inventory for ${product.name}`}>
      <div className={product.barcode === null ? 'barcode-missing' : undefined}>
        <dt>Barcode</dt>
        <dd>{product.barcode ?? <small>{barcodeMissingMarker}</small>}</dd>
      </div>
      <div>
        <dt>Spl. Price</dt>
        <dd>{currency(product.specialPrice)}</dd>
      </div>
      <div>
        <dt>Ex. Price</dt>
        <dd>{currency(product.exclusivePrice ?? '0')}</dd>
      </div>
      <div className={location && location.heldStock > 0 ? 'held-stock' : undefined}>
        <dt>Holded Stock</dt>
        <dd>{location ? location.heldStock : pending}</dd>
      </div>
      <div className="storage-stock">
        <dt>Storages Stock</dt>
        <dd>{location ? location.storageStock : pending}</dd>
      </div>
    </dl>
  );
}

/** The legacy "Inventory" button reloads the picker (`#co-table-reload`, `CO:1861-1865`). */
export function InventoryReload({ busy, onReload }: { busy: boolean; onReload: () => void }) {
  return (
    <button
      type="button"
      className="button secondary counter-inventory-reload"
      onClick={onReload}
      disabled={busy}
      aria-busy={busy}
    >
      <RefreshCw size={15} /> Inventory
    </button>
  );
}
