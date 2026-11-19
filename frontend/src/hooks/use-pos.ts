import { useEffect, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, NetworkError, params, request } from '../api/client';
import type { Product, Page, Store, Counter, Order } from '../api/types';
import { db, type LocalDraft, type Operation } from '../offline/database';
import { replay } from '../offline/sync';
import { liveQuery } from 'dexie';
import {
  sessionStateSchema,
  storeListSchema,
  counterListSchema,
  productPageSchema,
  orderPageSchema,
  principalSchema,
} from '../api/schemas';
import { setRequestOperator } from '../api/client';
import { useWorkspace } from '../state/workspace';
import { clearLocalIdentity } from '../offline/clear-identity';

export function useOnline() {
  const [online, set] = useState(navigator.onLine);
  useEffect(() => {
    const update = () => set(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}
/** Set by the operator probe: this browser holds an unexpired password-step challenge. */
export const loginChallengePendingKey = ['login-challenge-pending'] as const;
export function useOperator() {
  const client = useQueryClient();
  useEffect(() => {
    const refresh = () => {
      void client.invalidateQueries({ queryKey: ['operator'] });
    };
    const revoked = (event: StorageEvent) => {
      if (event.key !== 'pos-pending-logout' || event.newValue !== '1') return;
      setRequestOperator(null);
      void client.cancelQueries();
      useWorkspace.getState().reset();
      client.setQueryData(['operator'], null);
      client.removeQueries({ predicate: (query) => query.queryKey[0] !== 'operator' });
    };
    window.addEventListener('pos-operator-changed', refresh);
    window.addEventListener('storage', revoked);
    return () => {
      window.removeEventListener('pos-operator-changed', refresh);
      window.removeEventListener('storage', revoked);
    };
  }, [client]);
  const result = useQuery({
    queryKey: ['operator'],
    queryFn: async ({ signal }) => {
      if (localStorage.getItem('pos-pending-logout'))
        throw new ApiError(401, 'SIGNED_OUT', 'You are signed out.');
      const signedOut = async () => {
        const previous = await db.sessions.get('current');
        if (previous) await clearLocalIdentity(client, previous.user.id, true);
        else {
          await db.sessions.clear();
          client.removeQueries({ predicate: (query) => query.queryKey[0] !== 'operator' });
        }
        return null;
      };
      try {
        // Public probe: signed out answers 200 `{ session: null }`, so no 401 is expected here.
        const { session, loginChallengePending } = await request(
          '/api/v1/auth/session-state',
          { signal },
          sessionStateSchema,
        );
        if (!session) {
          await signedOut();
          client.setQueryData(loginChallengePendingKey, loginChallengePending);
          return null;
        }
        const { user, sessionExpiresAt } = session;
        await db.sessions.put({ id: 'current', user, expiresAt: sessionExpiresAt });
        return user;
      } catch (error) {
        if (signal.aborted) throw error;
        if (error instanceof ApiError && error.status === 401) return await signedOut();
        if (!(error instanceof NetworkError)) throw error;
        const previous = await db.sessions.get('current');
        if (previous && previous.expiresAt > Date.now())
          return principalSchema.parse(previous.user);
        if (previous) await clearLocalIdentity(client, previous.user.id, true);
        else await db.sessions.clear();
        return null;
      }
    },
    retry: false,
    staleTime: 60000,
    refetchInterval: 60000,
    refetchIntervalInBackground: true,
    networkMode: 'always',
  });
  useEffect(() => {
    let active = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    if (result.data)
      void db.sessions.get('current').then((session) => {
        if (active && session)
          timer = setTimeout(
            () => {
              void clearLocalIdentity(client, result.data!.id).catch(() => {});
            },
            Math.max(0, session.expiresAt - Date.now()),
          );
      });
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [result.data, client]);
  return result;
}
export function useStores(ownerId: string) {
  return useQuery({
    queryKey: [ownerId, 'stores'],
    queryFn: async () => {
      try {
        // Owner-bound: after sign-out (operator cleared) this aborts locally instead of a 401.
        const result = await request<{ data: Store[] }>(
          '/api/v1/stores',
          { operatorId: ownerId },
          storeListSchema,
        );
        // Stores and counters share one lookup row and load concurrently: read-modify-write in
        // one transaction so neither write drops the other's half.
        await db.transaction('rw', db.lookups, async () => {
          const old = await db.lookups.get(ownerId);
          await db.lookups.put({ ownerId, stores: result.data, counters: old?.counters || [] });
        });
        return result.data;
      } catch (error) {
        if (!(error instanceof NetworkError)) throw error;
        return (await db.lookups.get(ownerId))?.stores || [];
      }
    },
    staleTime: 60000,
    networkMode: 'always',
  });
}
export function useCounters(ownerId: string, storeId: string) {
  return useQuery({
    queryKey: [ownerId, 'counters', storeId],
    enabled: !!storeId,
    queryFn: async () => {
      try {
        const result = await request<{ data: Counter[] }>(
          `/api/v1/stores/${storeId}/counters`,
          { operatorId: ownerId },
          counterListSchema,
        );
        await db.transaction('rw', db.lookups, async () => {
          const old = await db.lookups.get(ownerId);
          await db.lookups.put({
            ownerId,
            stores: old?.stores || [],
            counters: [
              ...(old?.counters || []).filter((c) => c.storeId !== storeId),
              ...result.data,
            ],
          });
        });
        return result.data;
      } catch (error) {
        if (!(error instanceof NetworkError)) throw error;
        return (await db.lookups.get(ownerId))?.counters.filter((c) => c.storeId === storeId) || [];
      }
    },
    staleTime: 60000,
    networkMode: 'always',
  });
}
export function useProducts(
  ownerId: string,
  storeId: string,
  search: string,
  includeOutOfStock = false,
  onRead?: (milliseconds: number) => void,
) {
  return useInfiniteQuery({
    queryKey: [ownerId, 'products', storeId, search, includeOutOfStock],
    enabled: !!storeId,
    initialPageParam: '0',
    queryFn: async ({ pageParam, signal }) => {
      const startedAt = performance.now(),
        completed = onRead;
      const measured = () => {
        if (signal.aborted) return;
        // Optional metadata cannot change an otherwise successful catalog read.
        try {
          completed?.(performance.now() - startedAt);
        } catch {
          /* Timing collection is independent of catalog availability. */
        }
      };
      try {
        const data = await request<Page<Product>>(
          `/api/v1/stores/${storeId}/catalog/products?${params({ search, after: pageParam, includeOutOfStock: String(includeOutOfStock) })}`,
          { signal },
          productPageSchema,
        );
        await db.catalog.bulkPut(
          data.data.map((p) => ({ ...p, ownerId, storeId, cachedAt: Date.now() })),
        );
        measured();
        return { ...data, cached: false };
      } catch (error) {
        if (!(error instanceof NetworkError) || signal.aborted) throw error;
        const all = await db.catalog
          .where('[ownerId+storeId]')
          .equals([ownerId, storeId])
          .toArray();
        const data = {
          data: all.filter(
            (p) =>
              (includeOutOfStock || p.stock > 0) &&
              `${p.name} ${p.barcode} ${p.id}`.toLowerCase().includes(search.toLowerCase()),
          ),
          nextCursor: null,
          cached: true,
        };
        measured();
        return data;
      }
    },
    getNextPageParam: (last) => last.nextCursor || undefined,
    staleTime: 30000,
    retry: 1,
    networkMode: 'always',
  });
}
export function useOrders(ownerId: string, storeId: string) {
  return useInfiniteQuery({
    queryKey: [ownerId, 'orders', storeId],
    initialPageParam: undefined as string | undefined,
    enabled: !!storeId,
    queryFn: ({ pageParam, signal }) =>
      request<Page<Order>>(
        `/api/v1/stores/${storeId}/orders?${params({ before: pageParam })}`,
        {
          signal,
        },
        orderPageSchema,
      ),
    getNextPageParam: (last) => last.nextCursor || undefined,
    staleTime: 15000,
    retry: 1,
  });
}
export function useLocalDrafts(ownerId: string, storeId: string) {
  const [drafts, setDrafts] = useState<LocalDraft[]>([]);
  useEffect(() => {
    const subscription = liveQuery(() =>
      db.drafts.where('[ownerId+storeId]').equals([ownerId, storeId]).toArray(),
    ).subscribe((rows) => setDrafts(rows.sort((a, b) => a.createdAt - b.createdAt)));
    return () => subscription.unsubscribe();
  }, [ownerId, storeId]);
  return drafts;
}
export function useSync(ownerId: string) {
  const online = useOnline();
  const [operations, setOperations] = useState<Operation[]>([]);
  useEffect(() => {
    const subscription = liveQuery(() =>
      db.operations.where('ownerId').equals(ownerId).toArray(),
    ).subscribe(setOperations);
    return () => subscription.unsubscribe();
  }, [ownerId]);
  useEffect(() => {
    if (!online) return;
    const candidates = operations.filter((o) => ['pending', 'retry'].includes(o.state));
    if (!candidates.length) return;
    const next = Math.min(...candidates.map((o) => o.nextAttemptAt));
    const timer = setTimeout(() => void replay(ownerId), Math.max(0, next - Date.now()));
    return () => clearTimeout(timer);
  }, [ownerId, online, operations]);
  return {
    operations,
    online,
    sync: async () => {
      await replay(ownerId);
      setOperations(await db.operations.where('ownerId').equals(ownerId).toArray());
    },
  };
}
