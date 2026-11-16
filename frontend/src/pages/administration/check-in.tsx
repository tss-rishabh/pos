import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LogIn, LogOut } from 'lucide-react';
import { z } from 'zod';
import type { Principal } from '../../api/types';
import { request } from '../../api/client';
import { ErrorState, Loading } from '../../components/common';
import { checkInSchema, commonStoreSchema } from './api';

/** Server check-in is the authority for financial actions; selection alone is insufficient. */
export function OperatorCheckIn({
  user,
  storeId,
  counterId = '',
}: {
  user: Principal;
  storeId: string;
  counterId?: string;
}) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const current = useQuery({
    queryKey: [user.id, 'administration', 'my-check-in'],
    queryFn: ({ signal }) =>
      request(
        '/api/v1/operators/me/check-in',
        { operatorId: user.id, signal },
        z.object({ data: checkInSchema.nullable() }),
      ),
    staleTime: 10000,
  });
  const stores = useQuery({
    queryKey: [user.id, 'administration', 'assignable-stores'],
    queryFn: ({ signal }) =>
      request(
        '/api/v1/stores',
        { operatorId: user.id, signal },
        z.object({ data: z.array(commonStoreSchema) }),
      ),
  });
  async function change(checkIn: boolean) {
    setBusy(true);
    setError(null);
    try {
      if (checkIn)
        await request(
          '/api/v1/operators/me/check-in',
          {
            operatorId: user.id,
            method: 'PUT',
            body: JSON.stringify({ storeId, counterId: counterId || null }),
          },
          checkInSchema,
        );
      else
        await request('/api/v1/operators/me/check-in', { operatorId: user.id, method: 'DELETE' });
      await client.invalidateQueries({ queryKey: [user.id] });
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  const checkedIn = current.data?.data;
  const matches = checkedIn?.storeId === storeId && checkedIn?.counterId === (counterId || null);
  const name =
    stores.data?.data.find((store) => store.id === checkedIn?.storeId)?.name || checkedIn?.storeId;
  return (
    <>
      <section className="surface administration-checkin">
        <div>
          <div className="eyebrow">OPERATOR SESSION</div>
          <h2>Store check-in</h2>
          {current.isPending ? (
            <Loading />
          ) : current.isError ? (
            <ErrorState error={current.error} />
          ) : checkedIn ? (
            <p>
              Checked in at <strong>{name}</strong>
              {checkedIn.counterId ? ` · Counter ${checkedIn.counterId}` : ''}
              <br />
              Expires {new Date(checkedIn.expiresAt).toLocaleString()}
            </p>
          ) : (
            <p>Choose your store and counter, then check in to start your shift.</p>
          )}
        </div>
        <div className="administration-actions">
          <button
            className="button primary"
            disabled={!storeId || busy || !!matches}
            onClick={() => void change(true)}
          >
            <LogIn size={16} />
            {matches ? 'Checked in' : 'Check in here'}
          </button>
          {checkedIn && (
            <button className="button secondary" disabled={busy} onClick={() => void change(false)}>
              <LogOut size={16} />
              Check out
            </button>
          )}
        </div>
      </section>
      {error !== null && <ErrorState error={error} />}
    </>
  );
}
