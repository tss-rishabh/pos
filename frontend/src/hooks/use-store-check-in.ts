import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { request } from '../api/client';
import { checkInSchema } from '../pages/administration/api';

const responseSchema = z.object({ data: checkInSchema.nullable() });

/**
 * The operator's current server check-in (shared `my-check-in` query) and whether it is an
 * unexpired check-in at `storeId`. Store-scoped live features (notifications, expiry reminders)
 * exist only for the checked-in store, as in legacy, so callers gate their requests on it.
 */
export function useStoreCheckIn(operatorId: string, storeId: string, enabled: boolean) {
  const [now, setNow] = useState(Date.now);
  const current = useQuery({
    queryKey: [operatorId, 'administration', 'my-check-in'],
    enabled,
    queryFn: ({ signal }) =>
      request('/api/v1/operators/me/check-in', { operatorId, signal }, responseSchema),
    staleTime: 10000,
    retry: false,
  });
  const checkIn = current.data?.data ?? null;
  const expiresAt = checkIn ? Date.parse(checkIn.expiresAt) : NaN;
  useEffect(() => {
    if (!Number.isFinite(expiresAt)) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, Math.min(2147483647, expiresAt - Date.now() + 1)),
    );
    return () => clearTimeout(timer);
  }, [expiresAt]);
  return {
    checkIn,
    pending: enabled && current.isPending,
    checkedIn:
      enabled &&
      current.isSuccess &&
      !!storeId &&
      checkIn?.storeId === storeId &&
      expiresAt > Math.max(now, Date.now()),
  };
}
