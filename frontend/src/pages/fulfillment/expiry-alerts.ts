import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { ApiError, request } from '../../api/client';

export const fulfillmentBannerCountsSchema = z.object({
  unaccepted: z.number().int().nonnegative(),
  unpacked: z.number().int().nonnegative(),
  packed: z.number().int().nonnegative(),
});
export const fulfillmentExpiryAlertsSchema = z.object({
  expiringSoon: z.array(z.object({
    orderId: z.string().min(1).max(64),
    type: z.enum(['pending', 'accepted']),
    expiresAt: z.string().max(64),
  })),
  bannerCounts: fulfillmentBannerCountsSchema,
  pollIntervalMs: z.number().int().min(1000).max(3600000).optional(),
  businessTimeZone: z.string().min(1).max(64).optional(),
});
export type FulfillmentExpiryAlerts = z.infer<typeof fulfillmentExpiryAlertsSchema>;
export type FulfillmentExpiryItem = FulfillmentExpiryAlerts['expiringSoon'][number];
export type FulfillmentBannerCounts = z.infer<typeof fulfillmentBannerCountsSchema>;
export const fulfillmentExpiryAuthorityDenied = (error: unknown) =>
  error instanceof ApiError && (error.status === 401 || error.status === 403);

/** One operator/store query shared by the global widget and fulfillment page. */
export function useFulfillmentExpiryAlerts(operatorId: string, storeId: string, enabled = true) {
  const client = useQueryClient();
  const identity = JSON.stringify([operatorId, storeId]);
  const [blockedIdentity, setBlockedIdentity] = useState<string | null>(null);
  const allowed = enabled && Boolean(operatorId && storeId) && blockedIdentity !== identity;
  const query = useQuery({
    queryKey: [operatorId, 'fulfillment-expiry-alerts', storeId],
    enabled: allowed,
    queryFn: ({ signal }) => request(
      `/api/v1/stores/${storeId}/fulfillment/expiry-alerts`,
      { operatorId, signal },
      fulfillmentExpiryAlertsSchema,
    ),
    retry: (count, error) => !fulfillmentExpiryAuthorityDenied(error) && count < 1,
    refetchInterval: (current) => current.state.data?.pollIntervalMs ?? 60000,
    staleTime: 10000,
  });
  const denied = fulfillmentExpiryAuthorityDenied(query.error);
  useEffect(() => {
    if (!denied) return;
    setBlockedIdentity(identity);
    client.removeQueries({ queryKey: [operatorId, 'fulfillment-expiry-alerts', storeId], exact: true });
  }, [client, denied, identity, operatorId, storeId]);
  return { ...query, data: allowed && !denied ? query.data : undefined, authorityDenied: denied || blockedIdentity === identity };
}

/** Legacy DATETIME is a business wall clock, never the desktop's local zone. */
export function fulfillmentExpiryInstant(value: string, timeZone = 'Asia/Kolkata'): number | null {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  const matched = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/.exec(value);
  if (!matched) return null;
  const wall = `${matched[1]}T${matched[2]}`;
  const calendar = Date.parse(wall + 'Z');
  if (!Number.isFinite(calendar) || new Date(calendar).toISOString().slice(0, 19) !== wall) return null;
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    const partsAt = (timestamp: number) => {
      const parts = new Map(formatter.formatToParts(timestamp).map((part) => [part.type, part.value]));
      return `${parts.get('year')}-${parts.get('month')}-${parts.get('day')}T${parts.get('hour')}:${parts.get('minute')}:${parts.get('second')}`;
    };
    let instant = calendar;
    for (let attempt = 0; attempt < 3; attempt++)
      instant += calendar - Date.parse(partsAt(instant) + 'Z');
    if (partsAt(instant) !== wall) return null;
    return instant + Number((matched[3] || '').padEnd(3, '0').slice(0, 3));
  } catch { return null; }
}
