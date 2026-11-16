import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, RefreshCw } from 'lucide-react';
import { z } from 'zod';
import { request } from '../../api/client';
import type { Principal } from '../../api/types';
import { ErrorState, PageTitle } from '../../components/common';
import { useOnline } from '../../hooks/use-pos';
import './style.css';
const batchSchema = z
  .object({
    storeId: z.string(),
    ensuredParentIds: z.array(z.string()),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  })
  .refine(
    (value) => !value.hasMore || value.nextCursor !== null,
    'The repair cursor is unavailable.',
  );
export function InventoryAssociationsPage({ user, storeId }: { user: Principal; storeId: string }) {
  const online = useOnline(),
    [selected, setSelected] = useState(storeId),
    [progress, setProgress] = useState(0);
  const stores = useQuery({
    queryKey: [user.id, 'finance-cash-ledger-stores'],
    queryFn: () =>
      request(
        '/api/v1/reports/store-cash-balances/stores',
        {},
        z.object({ data: z.array(z.object({ id: z.string(), name: z.string() })) }),
      ),
  });
  const repair = useMutation({
    mutationFn: async () => {
      let after = '0',
        total = 0;
      setProgress(0);
      for (;;) {
        const batch = await request(
          `/api/v1/stores/${selected}/inventory/parent-associations`,
          {
            method: 'POST',
            operatorId: user.id,
            body: JSON.stringify({ after, limit: 500 }),
          },
          batchSchema,
        );
        total += batch.ensuredParentIds.length;
        setProgress(total);
        if (!batch.hasMore) return total;
        if (!batch.nextCursor || BigInt(batch.nextCursor) <= BigInt(after))
          throw new Error('The repair could not advance. Refresh and try again.');
        after = batch.nextCursor;
      }
    },
  });
  return (
    <>
      <PageTitle eyebrow="KEEP THE CATALOG CONNECTED" title="Inventory associations" />
      <section className="surface inventory-association-panel">
        <h2>Make parent products available to this store</h2>
        <p>
          Repair missing links for product families whose variants already belong to the store.
          Existing quantities and availability are preserved.
        </p>
        <label>
          Store
          <select
            value={selected}
            disabled={repair.isPending}
            onChange={(event) => setSelected(event.target.value)}
          >
            <option value="">Choose a store</option>
            {stores.data?.data.map((store) => (
              <option key={store.id} value={store.id}>
                {store.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button primary"
          disabled={!online || !selected || user.role === 5 || repair.isPending}
          onClick={() => repair.mutate()}
        >
          <RefreshCw size={16} />
          {repair.isPending ? 'Repairing…' : 'Repair missing associations'}
        </button>
        {!online && <p role="status">Connect to the store service to repair associations.</p>}
        {user.role === 5 && <p>Ask a store manager or administrator to run this repair.</p>}
        {repair.isPending && <p role="status">{progress} parent association(s) ensured so far.</p>}
        {repair.isSuccess && (
          <p className="operational-report-success" role="status">
            <Check size={16} />
            Repair complete. {repair.data} parent association(s) ensured.
          </p>
        )}
        {repair.isError && <ErrorState error={repair.error} />}{' '}
        {stores.isError && <ErrorState error={stores.error} />}
      </section>
    </>
  );
}
