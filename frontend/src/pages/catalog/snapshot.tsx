import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { Principal } from '../../api/types';
import { ApiError, NetworkError, request } from '../../api/client';
import { Empty, ErrorState, Loading, PageTitle } from '../../components/common';
import { useOnline } from '../../hooks/use-pos';
import { catalogSnapshot } from './contracts';
import {
  CatalogPagination,
  CatalogTable,
  downloadCatalogCsv,
  downloadCatalogFile,
  type CatalogColumn,
} from './table';
import { clearCatalogSnapshots, loadCatalogSnapshot, saveCatalogSnapshot } from './snapshot-cache';
import { catalogWorkbook } from './workbook';
import { filterCatalogSnapshot } from './snapshot-filter';
import './style.css';
export { clearCatalogSnapshots } from './snapshot-cache';
interface SnapshotDisplayRow {
  id: string;
  product: string;
  barcode: string;
  price: string | null;
  special: string | null;
  exclusive: number;
  stock: number;
}
const columns: readonly CatalogColumn<SnapshotDisplayRow>[] = [
  {
    key: 'id',
    label: 'Product ID',
    render: (row) => <Link to={`/catalog/products/${row.id}`}>{row.id}</Link>,
  },
  { key: 'product', label: 'Product' },
  { key: 'barcode', label: 'Barcode' },
  { key: 'price', label: 'Price' },
  { key: 'special', label: 'Special price' },
  { key: 'exclusive', label: 'Exclusive price' },
  { key: 'stock', label: 'Stock' },
];
export function StoreCatalogPage({ user, storeId }: { user: Principal; storeId: string }) {
  const online = useOnline(),
    [search, setSearch] = useState(''),
    [start, setStart] = useState(0),
    [length, setLength] = useState(25);
  const data = useQuery({
    queryKey: [user.id, 'store-catalog-snapshot', storeId, user.role, user.userType, user.storeIds],
    enabled: !!storeId,
    networkMode: 'always',
    refetchInterval: 600000,
    retry: false,
    queryFn: async ({ signal }) => {
      try {
        const result = await request(
          `/api/v1/catalog/stores/${storeId}/snapshot`,
          { signal },
          catalogSnapshot,
        );
        const cache = await saveCatalogSnapshot(user, storeId, result);
        return {
          ...result,
          cached: false,
          offlineReady: cache.saved,
          cacheExpiresAt: cache.expiresAt,
        };
      } catch (error) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403))
          await clearCatalogSnapshots(user.id);
        if (!(error instanceof NetworkError) || signal.aborted) throw error;
        const previous = await loadCatalogSnapshot(user, storeId);
        if (!previous) throw error;
        return { ...previous, cached: true, offlineReady: true };
      }
    },
  });
  if (!storeId)
    return <Empty title="Choose a store">Select a store to open its offline catalog.</Empty>;
  if (data.isPending) return <Loading />;
  if (data.isError) return <ErrorState error={data.error} retry={() => void data.refetch()} />;
  const filtered: SnapshotDisplayRow[] = filterCatalogSnapshot(data.data.data, search).map(
      (row) => ({
        id: row[0],
        product: row[1],
        barcode: row[2],
        price: row[3],
        special: row[4],
        exclusive: row[5],
        stock: row[6],
      }),
    ),
    offset = start >= filtered.length ? 0 : start;
  return (
    <>
      <PageTitle title={`${data.data.store.name} catalog`}>
        <button
          className="button secondary"
          disabled={!online || data.isFetching}
          onClick={() => void data.refetch()}
        >
          Refresh catalog
        </button>
        <Link className="button secondary" to="/catalog">
          All products
        </Link>
      </PageTitle>
      <div className="surface catalog-filters">
        <label>
          Search SKU, product or barcode
          <input
            maxLength={150}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setStart(0);
            }}
          />
        </label>
        <p role="status">
          {online ? 'Online' : 'Offline'} · Last synced{' '}
          {new Date(data.data.syncedAt).toLocaleString()}
          {data.data.cached ? ' · Saved snapshot' : ''} · Auto sync every 10 minutes
          {data.data.offlineReady && data.data.cacheExpiresAt
            ? ` · Offline until ${new Date(data.data.cacheExpiresAt).toLocaleString()}`
            : ' · Offline copy unavailable'}
        </p>
        {!online && <p>Saved stock is informational. Refresh before adjusting inventory.</p>}
      </div>
      <CatalogTable
        key={user.id + ':' + storeId}
        ownerId={user.id}
        columns={columns}
        rows={filtered.slice(offset, offset + length)}
        name={`store-${storeId}-catalog-page.csv`}
        description={`${filtered.length.toLocaleString()} matching products`}
        extra={(visible) => (
          <>
            <button
              className="button secondary"
              disabled={!filtered.length}
              onClick={() => downloadCatalogCsv(`store-${storeId}-catalog.csv`, visible, filtered)}
            >
              Export all matches CSV
            </button>
            <button
              className="button secondary"
              disabled={!filtered.length}
              onClick={() =>
                downloadCatalogFile(
                  `store-${storeId}-catalog.xlsx`,
                  catalogWorkbook(
                    visible.map((column) => column.label),
                    filtered.map((row) => visible.map((column) => row[column.key])),
                  ),
                )
              }
            >
              Export all matches Excel
            </button>
          </>
        )}
      />
      <CatalogPagination
        start={offset}
        total={filtered.length}
        length={length}
        busy={data.isFetching}
        onStart={setStart}
        onLength={(value) => {
          setLength(value);
          setStart(0);
        }}
      />
    </>
  );
}
