import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import type { Principal } from '../../api/types';
import { request } from '../../api/client';
import { Empty, ErrorState, PageTitle } from '../../components/common';
import { MultiSelect } from '../../components/multi-select';
import { SkeletonTable } from '../../components/loader';
import { useOnline } from '../../hooks/use-pos';
import { tableResult } from './contracts';
import { CatalogPagination, CatalogTable, type CatalogColumn } from './table';
import { StockEditor } from './product';
import './style.css';
const numericMap = z.union([z.record(z.string(), z.number()), z.tuple([])]),
  booleanMap = z.union([z.record(z.string(), z.boolean()), z.tuple([])]);
const matrixRow = z.object({
  id: z.string(),
  DT_RowId: z.string(),
  product: z.string(),
  erp_product: z.string(),
  ParentProductId: z.string(),
  productType: z.string(),
  stores: z.array(z.string()),
  product_store_stock: numericMap,
  product_store_stock_is_avail: booleanMap,
  product_store_stock_is_del: booleanMap,
});
type MatrixRow = z.infer<typeof matrixRow>;
export const matrixStoresSchema = z
  .object({ data: z.array(z.object({ id: z.string(), name: z.string() }).strict()) })
  .strict();
const resultSchema = tableResult(matrixRow).extend({
  stores: z.array(z.object({ id: z.string(), name: z.string() })),
});
export function StockMatrixPage({ user, storeId }: { user: Principal; storeId: string }) {
  const online = useOnline(),
    client = useQueryClient(),
    permitted = user.userType === 1,
    canEdit = permitted && [1, 2, 3].includes(user.role),
    [editing, setEditing] = useState(false),
    [filters, setFilters] = useState({
      storeIds: storeId ? [storeId] : [],
      search: '',
      sort: 'id',
      direction: 'asc',
    }),
    [submitted, setSubmitted] = useState(filters),
    [start, setStart] = useState(0),
    [length, setLength] = useState(10);
  const stores = useQuery({
      // The stores the matrix search authorises for this operator (legacy ProductsStockView:
      // every active store for role 1, the assigned active stores otherwise).
      queryKey: [user.id, 'catalog-inventory-stores'],
      enabled: permitted,
      queryFn: ({ signal }) =>
        request('/api/v1/catalog/inventory/stores', { signal }, matrixStoresSchema),
    }),
    data = useQuery({
      queryKey: [user.id, 'catalog-stock-matrix', submitted, start, length],
      enabled: permitted,
      retry: false,
      queryFn: ({ signal }) =>
        request(
          '/api/v1/catalog/inventory/search',
          { method: 'POST', signal, body: JSON.stringify({ ...submitted, start, length }) },
          resultSchema,
        ),
    }),
    capabilities = useQuery({
      queryKey: [user.id, 'catalog-inventory-capabilities'],
      enabled: canEdit,
      retry: false,
      staleTime: 30000,
      queryFn: () =>
        request(
          '/api/v1/admin/inventory-imports/capabilities',
          {},
          z.object({ visibilityEnabled: z.boolean(), stockEnabled: z.boolean() }),
        ),
    });
  if (!permitted)
    return (
      <ErrorState error={new Error('Stock administration is restricted for this user type.')} />
    );
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: [user.id, 'catalog-stock-matrix'] });
  };
  const columns: CatalogColumn<MatrixRow>[] = [
    {
      key: 'id',
      label: 'SKU ID',
      render: (row) => <Link to={`/catalog/products/${row.id}`}>{row.id}</Link>,
    },
    { key: 'product', label: 'Product' },
    { key: 'erp_product', label: 'ERP product' },
    {
      key: 'stores',
      label: 'Stock',
      render: (row) => (
        <div className="catalog-matrix-stores">
          {data.data?.stores.map((store) => {
            const value = Array.isArray(row.product_store_stock)
                ? undefined
                : row.product_store_stock[store.id],
              available = Array.isArray(row.product_store_stock_is_avail)
                ? false
                : row.product_store_stock_is_avail[store.id] || false,
              deleted = Array.isArray(row.product_store_stock_is_del)
                ? false
                : row.product_store_stock_is_del[store.id] || false,
              current = row.stores.includes(store.id)
                ? {
                    productId: row.id,
                    storeId: store.id,
                    stock: value || 0,
                    available,
                    listed: !deleted,
                  }
                : undefined;
            return (
              <div className="catalog-matrix-store" key={store.id}>
                <strong>{store.name}</strong>
                {editing && canEdit ? (
                  <StockEditor
                    key={`${row.id}:${store.id}:${value}:${available}:${deleted}`}
                    user={user}
                    storeId={store.id}
                    productId={row.id}
                    current={current}
                    parentProductId={row.ParentProductId === '0' ? null : row.ParentProductId}
                    enabled={online && !!capabilities.data?.visibilityEnabled}
                    stockEnabled={
                      online && !!capabilities.data?.stockEnabled && row.productType !== '3'
                    }
                    onRefresh={refresh}
                  />
                ) : (
                  <span>
                    {current
                      ? `${current.stock} · ${current.available ? 'Available' : 'Out of stock'} · ${current.listed ? 'Listed' : 'Disabled'}`
                      : 'No stock association'}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      ),
    },
  ];
  return (
    <>
      <PageTitle title="Inventory matrix">
        <Link className="button secondary" to="/catalog">
          Product catalog
        </Link>
        <Link className="button secondary" to="/inventory">
          Stock overview
        </Link>
      </PageTitle>
      <form
        className="surface catalog-filters"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(filters);
          setStart(0);
        }}
      >
        <MultiSelect
          label="Stores"
          emptyLabel="All accessible stores"
          hint="Clear the selection for all accessible stores."
          options={(stores.data?.data ?? []).map((store) => ({
            value: store.id,
            label: store.name,
          }))}
          value={filters.storeIds}
          onChange={(storeIds) => setFilters({ ...filters, storeIds })}
        />
        <label>
          Search SKU or product
          <input
            maxLength={150}
            value={filters.search}
            onChange={(event) => setFilters({ ...filters, search: event.target.value })}
          />
        </label>
        <label>
          Sort by
          <select
            value={filters.sort}
            onChange={(event) => setFilters({ ...filters, sort: event.target.value })}
          >
            <option value="id">SKU ID</option>
            <option value="product">Product</option>
            <option value="erp_product">Product ERP field</option>
          </select>
        </label>
        <label>
          Direction
          <select
            value={filters.direction}
            onChange={(event) => setFilters({ ...filters, direction: event.target.value })}
          >
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
        </label>
        <button className="button primary" disabled={!online || data.isFetching}>
          View inventory
        </button>
        {canEdit && (
          <label>
            <input
              type="checkbox"
              checked={editing}
              disabled={!online}
              onChange={(event) => setEditing(event.target.checked)}
            />
            Edit stock and visibility
          </label>
        )}
      </form>
      {editing && !capabilities.data?.stockEnabled && (
        <p role="status">
          Stock changes require a verified stock procedure and product synchronization. Visibility
          requires product synchronization.
        </p>
      )}
      {!online && (
        <p role="status">Offline. Showing the last matrix page available in this session.</p>
      )}
      {stores.isError && <ErrorState error={stores.error} />}{' '}
      {capabilities.isError && editing && <ErrorState error={capabilities.error} />}{' '}
      {data.isPending ? (
        <SkeletonTable />
      ) : data.isError ? (
        <ErrorState error={data.error} retry={() => void data.refetch()} />
      ) : (
        <>
          {!data.data.data.length ? (
            <Empty title="No stock products found">Change the store or search.</Empty>
          ) : (
            <CatalogTable
              key={user.id}
              ownerId={user.id}
              columns={columns}
              rows={data.data.data}
              name="inventory-matrix"
              csv={false}
              description={`${data.data.recordsFiltered.toLocaleString()} matching SKUs · Includes products without stock associations`}
            />
          )}
          <CatalogPagination
            start={data.data.start}
            total={data.data.recordsFiltered}
            length={length}
            lengthOptions={[5, 10, 50, 100, 500]}
            busy={data.isFetching}
            onStart={setStart}
            onLength={(value) => {
              setLength(value);
              setStart(0);
            }}
          />
        </>
      )}
    </>
  );
}
