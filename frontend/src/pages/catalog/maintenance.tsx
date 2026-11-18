import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { Principal } from '../../api/types';
import { captureOperatorScope, request } from '../../api/client';
import { Empty, ErrorState, PageTitle } from '../../components/common';
import { useOnline } from '../../hooks/use-pos';
import { downloadReportCsv } from '../finance/download';
import {
  maintenanceActive,
  maintenanceCapabilities,
  repairPlan,
  type MaintenanceKind,
} from './maintenance-contracts';
import {
  pendingMaintenanceCommand,
  submitMaintenanceCommand,
  type InventoryPullInput,
} from './maintenance-commands';
import { MaintenanceReceiptView } from './maintenance-receipt';
import './style.css';
function pending(ownerId: string, kind: MaintenanceKind) {
  try {
    return pendingMaintenanceCommand(ownerId, kind)?.id || null;
  } catch {
    return null;
  }
}
export function InventoryPullPage({ user }: { user: Principal }) {
  const online = useOnline(),
    client = useQueryClient(),
    allowed = user.role === 1 && user.userType === 1,
    [mode, setMode] = useState<'manual' | 'csv'>('manual'),
    [skus, setSkus] = useState(''),
    [file, setFile] = useState<File | null>(null),
    [selected, setSelected] = useState<string | null>(() => pending(user.id, 'inventory-pull'));
  const capabilities = useQuery({
      queryKey: [user.id, 'catalog-maintenance-capabilities'],
      enabled: allowed,
      queryFn: ({ signal }) =>
        request(
          '/api/v1/catalog/maintenance/capabilities',
          { operatorId: user.id, signal },
          maintenanceCapabilities,
        ),
      retry: false,
      staleTime: 30000,
    }),
    active = useQuery({
      queryKey: [user.id, 'catalog-maintenance-active'],
      enabled: allowed,
      queryFn: ({ signal }) =>
        request(
          '/api/v1/catalog/maintenance-commands',
          { operatorId: user.id, signal },
          maintenanceActive,
        ),
      retry: false,
      refetchInterval: 10000,
    });
  const submit = useMutation({
      mutationFn: async () => {
        const signal = captureOperatorScope(user.id);
        let input: InventoryPullInput;
        if (mode === 'manual') input = { mode, skus };
        else {
          if (!file) throw new Error('Choose a CSV file.');
          if (file.size > 512000 || !file.name.toLowerCase().endsWith('.csv'))
            throw new Error('Choose a CSV file no larger than 500 KB.');
          const csv = await file.text();
          signal.throwIfAborted();
          input = { mode, filename: file.name, csv };
        }
        signal.throwIfAborted();
        return submitMaintenanceCommand(user.id, { kind: 'inventory-pull', input });
      },
      onSuccess: async (result) => {
        setSelected(result.id);
        await client.invalidateQueries({ queryKey: [user.id, 'catalog-maintenance-active'] });
      },
    }),
    sample = useMutation({
      mutationFn: () =>
        downloadReportCsv(
          '/api/v1/catalog/inventory-pulls/sample',
          'inventory-pull-sample.csv',
          user.id,
        ),
    });
  if (!allowed)
    return <ErrorState error={new Error('Inventory pull requires an internal administrator.')} />;
  return (
    <>
      <PageTitle eyebrow="INVENTORY MAINTENANCE" title="Inventory pull">
        <Link className="button secondary" to="/catalog/inventory">
          Inventory matrix
        </Link>
      </PageTitle>
      <form
        className="surface catalog-detail-block"
        onSubmit={(event) => {
          event.preventDefault();
          submit.mutate();
        }}
      >
        <div className="catalog-table-toolbar">
          <button
            type="button"
            className={`button ${mode === 'manual' ? 'primary' : 'secondary'}`}
            onClick={() => setMode('manual')}
          >
            Enter SKUs
          </button>
          <button
            type="button"
            className={`button ${mode === 'csv' ? 'primary' : 'secondary'}`}
            onClick={() => setMode('csv')}
          >
            Upload SKU CSV
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={!online || sample.isPending}
            onClick={() => sample.mutate()}
          >
            Download sku sample
          </button>
        </div>
        {mode === 'manual' ? (
          <label>
            SKU IDs
            <textarea
              required
              rows={4}
              maxLength={4096}
              value={skus}
              onChange={(event) => setSkus(event.target.value)}
              placeholder="11, 20, 30"
            />
            <small>
              Enter up to 40 IDs separated by commas. Only simple-product SKUs are registered.
            </small>
          </label>
        ) : (
          <label>
            CSV file
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(event) => setFile(event.target.files?.[0] || null)}
            />
            <small>Use one sku header, up to 10,000 rows and a maximum file size of 500 KB.</small>
          </label>
        )}
        <div className="catalog-table-toolbar">
          <button
            className="button primary"
            disabled={!online || !capabilities.data?.inventoryPullEnabled || submit.isPending}
          >
            {submit.isPending ? 'Registering…' : 'Request inventory pull'}
          </button>
          {!capabilities.data?.inventoryPullEnabled && !capabilities.isPending && (
            <p>Inventory pull is currently unavailable.</p>
          )}
        </div>
        {capabilities.isError && <ErrorState error={capabilities.error} />}{' '}
        {submit.isError && <ErrorState error={submit.error} />}{' '}
        {sample.isError && <ErrorState error={sample.error} />}
      </form>
      {selected && <MaintenanceReceiptView key={selected} user={user} id={selected} />}
      <section className="surface catalog-detail-block">
        <div className="catalog-table-toolbar">
          <h2>Active maintenance commands</h2>
          <button
            className="button secondary"
            disabled={!online || active.isFetching}
            onClick={() => void active.refetch()}
          >
            Refresh commands
          </button>
        </div>
        {active.isError ? (
          <ErrorState error={active.error} />
        ) : active.data?.data.length ? (
          <div className="catalog-scroll">
            <table>
              <thead>
                <tr>
                  <th>Request</th>
                  <th>Operation</th>
                  <th>Status</th>
                  <th>SKUs</th>
                  <th>Operator ID</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {active.data.data.map((row) => (
                  <tr key={row.id}>
                    <td>{row.id}</td>
                    <td>
                      {row.kind === 'inventory-pull' ? 'Inventory pull' : 'Product troubleshooting'}
                    </td>
                    <td>{row.state.toLowerCase()}</td>
                    <td>{row.metadata.matchedCount}</td>
                    <td>{row.ownerId}</td>
                    <td>
                      <button className="button secondary" onClick={() => setSelected(row.id)}>
                        View request
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No active maintenance commands">
            Queued deliveries and outcomes needing confirmation appear here.
          </Empty>
        )}
      </section>
    </>
  );
}
export function ProductTroubleshooting({
  user,
  productId,
}: {
  user: Principal;
  productId: string;
}) {
  const online = useOnline(),
    client = useQueryClient(),
    allowed = user.role === 1 && user.userType === 1,
    [selected, setSelected] = useState<string | null>(() =>
      pending(user.id, 'product-troubleshoot'),
    );
  const capabilities = useQuery({
      queryKey: [user.id, 'catalog-maintenance-capabilities'],
      enabled: allowed,
      queryFn: ({ signal }) =>
        request(
          '/api/v1/catalog/maintenance/capabilities',
          { operatorId: user.id, signal },
          maintenanceCapabilities,
        ),
      retry: false,
      staleTime: 30000,
    }),
    inspect = useMutation({
      mutationFn: () =>
        request(
          `/api/v1/catalog/products/${productId}/troubleshooting/preview`,
          { method: 'POST', operatorId: user.id, body: '{}' },
          repairPlan,
        ),
    }),
    apply = useMutation({
      mutationFn: () => {
        if (!inspect.data) throw new Error('Inspect the product before applying repairs.');
        return submitMaintenanceCommand(user.id, {
          kind: 'product-troubleshoot',
          productId,
          expectedPlanHash: inspect.data.planHash,
        });
      },
      onSuccess: async (result) => {
        setSelected(result.id);
        inspect.reset();
        await client.invalidateQueries({
          queryKey: [user.id, 'catalog-product-detail', productId],
        });
        await client.invalidateQueries({ queryKey: [user.id, 'catalog-stock-matrix'] });
      },
    });
  if (!allowed) return null;
  return (
    <>
      <section id="product-troubleshooting" className="surface catalog-detail-block">
        <div className="catalog-table-toolbar">
          <h2>Product troubleshooting</h2>
          <button
            className="button secondary"
            disabled={!online || inspect.isPending || apply.isPending}
            onClick={() => inspect.mutate()}
          >
            Inspect product
          </button>
          <Link className="button secondary" to="/catalog/inventory-pulls">
            Inventory pull and active commands
          </Link>
        </div>
        <p>
          Inspect parent visibility, empty image metadata and duplicate barcodes before applying a
          repair.
        </p>
        {inspect.isError && <ErrorState error={inspect.error} />}{' '}
        {apply.isError && <ErrorState error={apply.error} />}{' '}
        {inspect.data && (
          <div className="catalog-repair-plan">
            <p>
              Product {inspect.data.productId} · {inspect.data.name}
            </p>
            <p>
              {inspect.data.parentVisibility.length} parent stock visibility row(s) will become
              available and listed. Stock quantities are preserved.
            </p>
            {inspect.data.imageReset && (
              <p>
                Empty image metadata on product {inspect.data.imageProductId} will be initialized.
              </p>
            )}
            {!!inspect.data.barcodeChanges.length && (
              <div className="catalog-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Other SKU</th>
                      <th>Barcode row</th>
                      <th>Current barcode</th>
                      <th>Temporary barcode</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inspect.data.barcodeChanges.map((row) => (
                      <tr key={row.id}>
                        <td>{row.productId}</td>
                        <td>{row.id}</td>
                        <td>{row.from}</td>
                        <td>{row.to}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p>Product synchronization will run for {inspect.data.syncProductIds.join(', ')}.</p>
            <button
              className="button primary"
              disabled={!online || !capabilities.data?.troubleshootingEnabled || apply.isPending}
              onClick={() => apply.mutate()}
            >
              {apply.isPending ? 'Applying…' : 'Apply reviewed repair'}
            </button>
            {!capabilities.data?.troubleshootingEnabled && (
              <p>Product synchronization is currently unavailable.</p>
            )}
          </div>
        )}
      </section>
      {selected && <MaintenanceReceiptView key={selected} user={user} id={selected} />}
    </>
  );
}
