import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { Principal } from '../../api/types';
import { captureOperatorScope, request } from '../../api/client';
import { ErrorState, PageTitle } from '../../components/common';
import { useOnline } from '../../hooks/use-pos';
import { downloadReportCsv } from '../finance/download';
import {
  inventoryPullResult,
  maintenanceCapabilities,
  troubleshootResult,
  type InventoryPullInput,
} from './maintenance-contracts';
import './style.css';

function useMaintenanceCapabilities(user: Principal) {
  return useQuery({
    queryKey: [user.id, 'catalog-maintenance-capabilities'],
    queryFn: ({ signal }) =>
      request(
        '/api/v1/catalog/maintenance/capabilities',
        { operatorId: user.id, signal },
        maintenanceCapabilities,
      ),
    retry: false,
    staleTime: 30000,
  });
}

/**
 * "Inventory Sync" (core/templates/products/stock/inventory-sync.html): up to 40 comma separated
 * SKU ids, or a CSV with a `sku` column, posted to the inventory service in the request.
 */
export function InventoryPullPage({ user }: { user: Principal }) {
  const online = useOnline(),
    [mode, setMode] = useState<'manual' | 'csv'>('manual'),
    [skus, setSkus] = useState(''),
    [file, setFile] = useState<File | null>(null),
    capabilities = useMaintenanceCapabilities(user);
  const submit = useMutation({
      mutationFn: async () => {
        const signal = captureOperatorScope(user.id);
        let input: InventoryPullInput;
        if (mode === 'manual') input = { mode, skus };
        else {
          if (!file) throw new Error('No file uploaded');
          if (!file.name.toLowerCase().endsWith('.csv'))
            throw new Error('Invalid file format Please import csv file only');
          if (file.size > 512000) throw new Error('Choose a CSV file no larger than 500 KB.');
          const csv = await file.text();
          signal.throwIfAborted();
          input = { mode, filename: file.name, csv };
        }
        return request(
          '/api/v1/catalog/inventory-pulls',
          {
            method: 'POST',
            operatorId: user.id,
            signal,
            body: JSON.stringify({ input }),
          },
          inventoryPullResult,
        );
      },
      onSuccess: () => {
        setSkus('');
        setFile(null);
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
  return (
    <>
      <PageTitle title="Inventory Sync">
        {user.userType === 1 && (
          <Link className="button secondary" to="/catalog/inventory">
            Inventory matrix
          </Link>
        )}
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
            Inventory Sync
          </button>
          <button
            type="button"
            className={`button ${mode === 'csv' ? 'primary' : 'secondary'}`}
            onClick={() => setMode('csv')}
          >
            Inventory Sync in Bulk
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
            Sku Ids
            <input
              value={skus}
              maxLength={4096}
              autoComplete="off"
              onChange={(event) => setSkus(event.target.value)}
              placeholder="Enter Comma seprated Sku id(s) max[40 sku(s)]"
            />
          </label>
        ) : (
          <label>
            File
            <input
              type="file"
              accept="text/csv"
              onChange={(event) => setFile(event.target.files?.[0] || null)}
            />
          </label>
        )}
        <div className="catalog-table-toolbar">
          <button
            className="button primary"
            disabled={!online || !capabilities.data?.inventoryPullEnabled || submit.isPending}
          >
            {submit.isPending ? 'Submitting…' : 'Submit'}
          </button>
          {capabilities.data && !capabilities.data.inventoryPullEnabled && (
            <p>Inventory pull is not configured on this server.</p>
          )}
        </div>
        {submit.data && <p role="status">{submit.data.message}</p>}
        {capabilities.isError && <ErrorState error={capabilities.error} />}
        {submit.isError && <ErrorState error={submit.error} />}
        {sample.isError && <ErrorState error={sample.error} />}
      </form>
    </>
  );
}

/**
 * Product troubleshooting (`ajax-troubleshoot-product/`): any signed-in operator; the server
 * repairs locally, runs the product sync and always answers with the legacy message.
 */
export function ProductTroubleshooting({
  user,
  productId,
}: {
  user: Principal;
  productId: string;
}) {
  const online = useOnline(),
    client = useQueryClient(),
    capabilities = useMaintenanceCapabilities(user),
    run = useMutation({
      mutationFn: () =>
        request(
          `/api/v1/catalog/products/${productId}/troubleshooting`,
          {
            method: 'POST',
            operatorId: user.id,
            signal: captureOperatorScope(user.id),
            body: '{}',
          },
          troubleshootResult,
        ),
      onSuccess: async () => {
        await client.invalidateQueries({
          queryKey: [user.id, 'catalog-product-detail', productId],
        });
        await client.invalidateQueries({ queryKey: [user.id, 'catalog-stock-matrix'] });
      },
    });
  return (
    <section id="product-troubleshooting" className="surface catalog-detail-block">
      <div className="catalog-table-toolbar">
        <h2>Product troubleshooting</h2>
        <button
          className="button secondary"
          disabled={!online || run.isPending || capabilities.data?.troubleshootingEnabled === false}
          onClick={() => run.mutate()}
        >
          {run.isPending ? 'Troubleshooting…' : 'Troubleshoot product'}
        </button>
      </div>
      <p>
        Restores the parent&apos;s store visibility, empty image metadata and duplicate barcodes,
        then re-syncs the product.
      </p>
      {run.data && <p role="status">{run.data.message}</p>}
      {run.isError && <ErrorState error={run.error} />}
    </section>
  );
}
