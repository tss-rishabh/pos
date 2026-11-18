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
  expiringSoon: z.array(
    z.object({
      orderId: z.string().min(1).max(64),
      type: z.enum(['pending', 'accepted']),
      expiresAt: z.string().max(64),
    }),
  ),
  bannerCounts: fulfillmentBannerCountsSchema,
  pollIntervalMs: z.number().int().min(5000).max(300000).optional(),
  businessTimeZone: z.string().min(1).max(64).optional(),
});
export type FulfillmentExpiryAlerts = z.infer<typeof fulfillmentExpiryAlertsSchema>;
export type FulfillmentExpiryItem = FulfillmentExpiryAlerts['expiringSoon'][number];
export type FulfillmentBannerCounts = z.infer<typeof fulfillmentBannerCountsSchema>;
export const fulfillmentExpiryAuthorityDenied = (error: unknown) =>
  error instanceof ApiError && (error.status === 401 || error.status === 403);
const businessFormatters = new Map<string, Intl.DateTimeFormat>();

/** One operator/store query shared by the global widget and fulfillment page. */
export function useFulfillmentExpiryAlerts(
  operatorId: string,
  storeId: string,
  enabled = true,
  options: { poll?: boolean; authorityKey?: string } = {},
) {
  const client = useQueryClient();
  const identity = JSON.stringify([operatorId, storeId]);
  const [blocked, setBlocked] = useState<{
    identity: string;
    authorityKey?: string;
    dataAt: number;
  } | null>(null);
  const blockedHere =
    blocked?.identity === identity && blocked.authorityKey === options.authorityKey;
  const allowed = enabled && Boolean(operatorId && storeId) && !blockedHere;
  const query = useQuery({
    queryKey: [operatorId, 'fulfillment-expiry-alerts', storeId],
    enabled: allowed,
    queryFn: ({ signal }) =>
      request(
        `/api/v1/stores/${storeId}/fulfillment/expiry-alerts`,
        { operatorId, signal },
        fulfillmentExpiryAlertsSchema,
      ),
    retry: (count, error) => !fulfillmentExpiryAuthorityDenied(error) && count < 1,
    // Workspace owns the timer. Standalone embeddings may explicitly opt in;
    // page/notification observers share its data and invalidations without timers.
    refetchInterval: options.poll
      ? (current) => current.state.data?.pollIntervalMs ?? 60000
      : false,
    refetchIntervalInBackground: Boolean(options.poll),
    staleTime: 10000,
  });
  const denied = fulfillmentExpiryAuthorityDenied(query.error);
  useEffect(() => {
    if (
      !enabled ||
      (query.isSuccess && blocked?.identity === identity && query.dataUpdatedAt > blocked.dataAt)
    ) {
      setBlocked(null);
      return;
    }
    if (!denied || query.fetchStatus === 'fetching') return;
    setBlocked((previous) =>
      previous?.identity === identity && previous.authorityKey === options.authorityKey
        ? previous
        : { identity, authorityKey: options.authorityKey, dataAt: query.dataUpdatedAt },
    );
    // Keep all observers attached while removing the stale private payload.
    client
      .getQueryCache()
      .find({ queryKey: [operatorId, 'fulfillment-expiry-alerts', storeId], exact: true })
      ?.setState({ data: undefined, dataUpdatedAt: 0 });
  }, [
    client,
    denied,
    identity,
    operatorId,
    storeId,
    enabled,
    options.authorityKey,
    query.fetchStatus,
    query.isSuccess,
    query.dataUpdatedAt,
    blocked,
  ]);
  return {
    ...query,
    data: allowed && !denied ? query.data : undefined,
    authorityDenied: denied || blockedHere,
  };
}

/** Legacy DATETIME is a business wall clock; invalid/ambiguous DST times fail closed. */
export function fulfillmentExpiryInstant(value: string, timeZone = 'Asia/Kolkata'): number | null {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const calendar = Date.parse(value.slice(0, 19) + 'Z');
    if (
      !Number.isFinite(calendar) ||
      new Date(calendar).toISOString().slice(0, 19) !== value.slice(0, 19)
    )
      return null;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  const matched = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/.exec(value);
  if (!matched) return null;
  const wall = `${matched[1]}T${matched[2]}`;
  const calendar = Date.parse(wall + 'Z');
  if (!Number.isFinite(calendar) || new Date(calendar).toISOString().slice(0, 19) !== wall)
    return null;
  try {
    let formatter = businessFormatters.get(timeZone);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      });
      if (businessFormatters.size >= 4) businessFormatters.clear();
      businessFormatters.set(timeZone, formatter);
    }
    const businessFormatter = formatter;
    const partsAt = (timestamp: number) => {
      const parts = new Map(
        businessFormatter.formatToParts(timestamp).map((part) => [part.type, part.value] as const),
      );
      return `${parts.get('year')}-${parts.get('month')}-${parts.get('day')}T${parts.get('hour')}:${parts.get('minute')}:${parts.get('second')}`;
    };
    const offsets = new Set(
      [-36, 0, 36].map((hours) => {
        const sample = calendar + hours * 3600000;
        return Date.parse(partsAt(sample) + 'Z') - sample;
      }),
    );
    const candidates = [...offsets]
      .map((offset) => calendar - offset)
      .filter((instant) => partsAt(instant) === wall);
    if (candidates.length !== 1) return null;
    return candidates[0]! + Number((matched[3] || '').padEnd(3, '0').slice(0, 3));
  } catch {
    return null;
  }
}
