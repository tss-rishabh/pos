import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { Principal } from '../../api/types';
import { request } from '../../api/client';
import { Empty, ErrorState, Loading, PageTitle } from '../../components/common';
import { useOnline } from '../../hooks/use-pos';
import { catalogMetadata, catalogRow, tableResult, type CatalogRow } from './contracts';
import { CatalogPagination, CatalogTable, type CatalogColumn } from './table';
import './style.css';
const columns: readonly CatalogColumn<CatalogRow>[] = [
  {
    key: 'id',
    label: 'SKU ID',
    render: (row) => <Link to={`/catalog/products/${row.id}`}>{row.id}</Link>,
  },
  { key: 'product', label: 'Product' },
  { key: 'erp_product', label: 'ERP product' },
  { key: 'prod_type', label: 'Type' },
  { key: 'categories', label: 'Categories' },
  { key: 'price', label: 'Price' },
  { key: 'exclusive_price', label: 'Exclusive price' },
  { key: 'store_names', label: 'Stores' },
  {
    key: 'DT_RowId',
    label: 'Action',
    render: (row) => (
      <div className="catalog-row-actions">
        <Link to={`/catalog/products/${row.id}`}>View</Link>
        <Link to={`/catalog/products/${row.id}/audit`}>Inventory logs</Link>
      </div>
    ),
    exportValue: () => '',
  },
];
export function CatalogPage({ user, storeId }: { user: Principal; storeId: string }) {
  const online = useOnline(),
    [filters, setFilters] = useState({
      storeIds: storeId ? [storeId] : [],
      search: '',
      sort: 'id',
      direction: 'asc',
    }),
    [submitted, setSubmitted] = useState(filters),
    [start, setStart] = useState(0),
    [length, setLength] = useState(25);
  const stores = useQuery({
    queryKey: [user.id, 'catalog-details-stores'],
    queryFn: ({ signal }) => request('/api/v1/catalog/stores', { signal }, catalogMetadata),
  });
  useEffect(() => {
    if (!storeId && stores.data?.selectedStoreIds.length) {
      const next = stores.data.selectedStoreIds;
      setFilters((current) => ({ ...current, storeIds: next }));
      setSubmitted((current) => ({ ...current, storeIds: next }));
    }
  }, [storeId, stores.data]);
  const data = useQuery({
    queryKey: [user.id, 'catalog-datatable', submitted, start, length],
    queryFn: ({ signal }) =>
      request(
        '/api/v1/catalog/products/search',
        { method: 'POST', body: JSON.stringify({ ...submitted, start, length }), signal },
        tableResult(catalogRow),
      ),
    retry: false,
  });
  return (
    <>
      <PageTitle eyebrow="PRODUCTS AND INVENTORY" title="Product catalog">
        {user.role === 1 && user.userType === 1 && (
          <Link className="button secondary" to="/catalog/inventory-pulls">
            Inventory pull
          </Link>
        )}
        {user.userType === 1 && (
          <Link className="button secondary" to="/catalog/inventory">
            Inventory matrix
          </Link>
        )}
        <Link
          className="button secondary"
          to={storeId ? `/catalog/stores/${storeId}/snapshot` : '/inventory'}
        >
          {storeId ? 'Offline store catalog' : 'Stock overview'}
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
        <label>
          Stores
          <select
            multiple
            value={filters.storeIds}
            onChange={(event) =>
              setFilters({
                ...filters,
                storeIds: Array.from(event.target.selectedOptions, (option) => option.value),
              })
            }
          >
            {stores.data?.data.map((store) => (
              <option key={store.id} value={store.id}>
                {store.name}
              </option>
            ))}
          </select>
          <small>Choose one or more stores.</small>
        </label>
        <label>
          Search SKU, product, URL or type
          <input
            value={filters.search}
            maxLength={150}
            onChange={(event) => setFilters({ ...filters, search: event.target.value })}
          />
        </label>
        <label>
          Sort by
          <select
            value={filters.sort}
            onChange={(event) => setFilters({ ...filters, sort: event.target.value })}
          >
            {[
              ...columns.filter((column) => column.key !== 'DT_RowId'),
              { key: 'spl_price', label: 'Special price' },
            ].map((column) => (
              <option key={String(column.key)} value={String(column.key)}>
                {column.label}
              </option>
            ))}
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
          View catalog
        </button>
      </form>
      {!online && (
        <p role="status">Offline. Showing the last catalog page available in this session.</p>
      )}
      {stores.isError && <ErrorState error={stores.error} />}{' '}
      {data.isPending ? (
        <Loading />
      ) : data.isError ? (
        <ErrorState error={data.error} retry={() => void data.refetch()} />
      ) : (
        <>
          {!data.data.data.length ? (
            <Empty title="No products found">Select stores or change the search.</Empty>
          ) : (
            <CatalogTable
              key={user.id}
              ownerId={user.id}
              columns={columns}
              rows={data.data.data}
              name="product-catalog.csv"
              description={`${data.data.recordsFiltered.toLocaleString()} matching products · ${data.data.unfilteredCount.toLocaleString()} before search`}
            />
          )}
          <CatalogPagination
            start={data.data.start}
            total={data.data.recordsFiltered}
            length={length}
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
export { CatalogProductPage } from './product';
export { InventoryAuditPage } from './audit';
export { StoreCatalogPage, clearCatalogSnapshots } from './snapshot';
export { StockMatrixPage } from './matrix';
export { InventoryPullPage } from './maintenance';
