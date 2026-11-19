import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import type { Principal } from '../../api/types';
import { request } from '../../api/client';
import { Empty, ErrorState, PageTitle } from '../../components/common';
import { MultiSelect } from '../../components/multi-select';
import { SkeletonTable } from '../../components/loader';
import { useOnline } from '../../hooks/use-pos';
import { auditRow, catalogMetadata, tableResult, type AuditRow } from './contracts';
import { CatalogPagination, CatalogTable, type CatalogColumn } from './table';
import './style.css';
export function InventoryAuditPage({
  user,
  storeId,
  productId,
}: {
  user: Principal;
  storeId: string;
  productId: string;
}) {
  const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date()),
    online = useOnline();
  const [searchParams] = useSearchParams(),
    requestedKind = searchParams.get('kind'),
    initialKind =
      requestedKind === 'held' || requestedKind === 'storage' ? requestedKind : 'product';
  const [filters, setFilters] = useState({
      storeIds: storeId ? [storeId] : [],
      from: today + 'T00:00:00',
      to: today + 'T23:59:59',
      kind: initialKind,
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
    }),
    data = useQuery({
      queryKey: [user.id, 'catalog-inventory-audit', productId, submitted, start, length],
      queryFn: ({ signal }) => {
        const { kind, ...body } = submitted;
        return request(
          `/api/v1/catalog/products/${productId}/audits/${kind}/search`,
          { method: 'POST', body: JSON.stringify({ ...body, start, length }), signal },
          tableResult(auditRow),
        );
      },
      retry: false,
    });
  const columns: CatalogColumn<AuditRow>[] = [
    { key: 'id', label: 'SI.' },
    { key: 'store_name', label: 'Store' },
    ...(submitted.kind === 'storage' ? [{ key: 'storage_name' as const, label: 'Storage' }] : []),
    { key: 'product_id', label: 'SKU ID' },
    { key: 'product', label: 'Product' },
    ...(submitted.kind === 'product'
      ? [{ key: 'erp_product' as const, label: 'ERP product' }]
      : []),
    { key: 'stock_before', label: 'Before' },
    { key: 'stock_after', label: 'After' },
    {
      key: 'added_reduced',
      label: 'Added / reduced',
      render: (row) => (
        <span className={Number(row.added_reduced) < 0 ? 'catalog-reduced' : 'catalog-added'}>
          {row.added_reduced ?? '—'}
        </span>
      ),
    },
    { key: 'user', label: 'User' },
    { key: 'comment', label: 'Comment' },
    { key: 'created_at', label: 'Date' },
  ];
  useEffect(() => {
    if (!storeId && stores.data) {
      const ids = stores.data.data.map((store) => store.id);
      setFilters((current) => ({ ...current, storeIds: ids }));
      setSubmitted((current) => ({ ...current, storeIds: ids }));
    }
  }, [storeId, stores.data]);
  useEffect(() => {
    setFilters((current) => ({ ...current, kind: initialKind, sort: 'id' }));
    setSubmitted((current) => ({ ...current, kind: initialKind, sort: 'id' }));
    setStart(0);
  }, [initialKind]);
  return (
    <>
      <PageTitle title={`Product ${productId} inventory logs`}>
        <Link className="button secondary" to={`/catalog/products/${productId}`}>
          Product details
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
          Inventory
          <select
            value={filters.kind}
            onChange={(event) => {
              const kind = event.target.value,
                allowed = new Set(
                  stores.data?.data
                    .filter(
                      (store) =>
                        kind !== 'storage' ||
                        (store.type === 'STORE' &&
                          (user.role === 1 || user.storeIds.includes(store.id))),
                    )
                    .map((store) => store.id),
                );
              setFilters({
                ...filters,
                kind,
                sort: 'id',
                storeIds: filters.storeIds.filter((id) => allowed.has(id)),
              });
            }}
          >
            <option value="product">Product stock</option>
            <option value="held">Held stock</option>
            <option value="storage">Storage stock</option>
          </select>
        </label>
        <MultiSelect
          label="Stores"
          emptyLabel="Select stores"
          options={(stores.data?.data ?? [])
            .filter(
              (store) =>
                filters.kind !== 'storage' ||
                (store.type === 'STORE' && (user.role === 1 || user.storeIds.includes(store.id))),
            )
            .map((store) => ({ value: store.id, label: store.name }))}
          value={filters.storeIds}
          onChange={(storeIds) => setFilters({ ...filters, storeIds })}
        />
        <label>
          From
          <input
            type="datetime-local"
            step="1"
            required
            value={filters.from}
            onChange={(event) => setFilters({ ...filters, from: event.target.value })}
          />
        </label>
        <label>
          To
          <input
            type="datetime-local"
            step="1"
            min={filters.from}
            required
            value={filters.to}
            onChange={(event) => setFilters({ ...filters, to: event.target.value })}
          />
        </label>
        <label>
          Search
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
            {columns
              .filter((column) =>
                [
                  'id',
                  'store_name',
                  'storage_name',
                  'product_id',
                  'product',
                  'erp_product',
                  'created_at',
                ].includes(column.key),
              )
              .map((column) => (
                <option key={column.key} value={column.key}>
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
          View inventory logs
        </button>
      </form>
      {!online && (
        <p role="status">Offline. Showing the last inventory page available in this session.</p>
      )}
      {stores.isError && <ErrorState error={stores.error} />}{' '}
      {data.isPending ? (
        <SkeletonTable />
      ) : data.isError ? (
        <ErrorState error={data.error} retry={() => void data.refetch()} />
      ) : (
        <>
          {!data.data.data.length ? (
            <Empty title="No inventory records found">
              Change the store, inventory type or date range.
            </Empty>
          ) : (
            <CatalogTable
              key={user.id + ':' + submitted.kind}
              ownerId={user.id}
              columns={columns}
              rows={data.data.data}
              name={`inventory-${submitted.kind}-${productId}.csv`}
              description={`${data.data.recordsFiltered.toLocaleString()} matching entries · ${data.data.reader === 'bigquery' ? 'Historical warehouse' : 'Current-day data reader'}`}
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
