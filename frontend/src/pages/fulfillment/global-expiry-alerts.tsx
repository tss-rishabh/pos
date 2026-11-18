import { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { request } from '../../api/client';
import { checkInSchema } from '../administration/api';
import { useCheckInAuthorityGeneration } from '../../hooks/use-check-in-authority';
import {
  fulfillmentBannerCountsSchema,
  fulfillmentExpiryAuthorityDenied,
  fulfillmentExpiryInstant,
  useFulfillmentExpiryAlerts,
  type FulfillmentBannerCounts,
  type FulfillmentExpiryItem,
} from './expiry-alerts';
import './global-expiry-alerts.css';

const seenSchema = z.record(z.string().max(80), z.literal(true));
const cachedCountsSchema = z.object({
  counts: fulfillmentBannerCountsSchema,
  receivedAt: z.number().finite(),
  authorityKey: z.string().max(256),
});
type Seen = z.infer<typeof seenSchema>;
type Batch = { threshold: 5 | 30; items: FulfillmentExpiryItem[] };
function readSeen(key: string): Seen {
  try {
    return seenSchema.parse(JSON.parse(localStorage.getItem(key) || '{}') as unknown);
  } catch {
    return {};
  }
}
function saveSeen(key: string, seen: Seen) {
  try {
    localStorage.setItem(key, JSON.stringify(seen));
  } catch {
    /* Warnings still work without storage. */
  }
}
function otherDialog(current: HTMLDialogElement | null) {
  return Array.from(
    document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"]'),
  ).some(
    (element) =>
      element !== current &&
      !current?.contains(element) &&
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== 'hidden',
  );
}

/** Mounted once per authenticated workspace; operational selection alone grants nothing. */
export function GlobalFulfillmentExpiryAlerts({
  operatorId,
  storeId,
  enabled,
}: {
  operatorId: string;
  storeId: string;
  enabled: boolean;
}) {
  const [now, setNow] = useState(Date.now);
  const authorityGeneration = useCheckInAuthorityGeneration(operatorId);
  const checkedIn = useQuery({
    queryKey: [operatorId, 'administration', 'my-check-in'],
    enabled,
    queryFn: ({ signal }) =>
      request(
        '/api/v1/operators/me/check-in',
        { operatorId, signal },
        z.object({ data: checkInSchema.nullable() }),
      ),
    staleTime: 10000,
    retry: (count, error) => !fulfillmentExpiryAuthorityDenied(error) && count < 1,
  });
  const checkIn = checkedIn.data?.data;
  const expiresAt = checkIn ? Date.parse(checkIn.expiresAt) : NaN;
  useEffect(() => {
    if (!Number.isFinite(expiresAt)) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, Math.min(2147483647, expiresAt - Date.now() + 1)),
    );
    return () => clearTimeout(timer);
  }, [expiresAt]);
  const allowed =
    enabled &&
    checkedIn.isSuccess &&
    !checkedIn.isError &&
    checkIn?.storeId === storeId &&
    expiresAt > Math.max(now, Date.now());
  if (!allowed || !checkIn) return null;
  const authorityKey = JSON.stringify([checkIn.storeId, checkIn.counterId, checkIn.expiresAt]);
  return (
    <ScopedExpiryAlerts
      key={JSON.stringify([operatorId, storeId, authorityKey])}
      operatorId={operatorId}
      storeId={storeId}
      authorityKey={authorityKey}
      authorityGeneration={authorityGeneration}
    />
  );
}

function ScopedExpiryAlerts({
  operatorId,
  storeId,
  authorityKey,
  authorityGeneration,
}: {
  operatorId: string;
  storeId: string;
  authorityKey: string;
  authorityGeneration: number;
}) {
  const query = useFulfillmentExpiryAlerts(operatorId, storeId, true, {
    poll: true,
    authorityKey,
    authorityGeneration,
  });
  const scope = JSON.stringify([operatorId, storeId]);
  const seenKey = `pos-fulfillment-expiry-seen:${scope}`;
  const countsKey = `pos-fulfillment-expiry-counts:${scope}`;
  const memorySeen = useRef<Seen>(readSeen(seenKey));
  const dialog = useRef<HTMLDialogElement>(null);
  const live = useRef(true);
  const latest = useRef(query.data);
  latest.current = query.data;
  const [batch, setBatch] = useState<Batch | null>(null);
  const [revision, setRevision] = useState(0);
  const [cachedCounts, setCachedCounts] = useState<FulfillmentBannerCounts | null>(() => {
    try {
      const stored = cachedCountsSchema.parse(
        JSON.parse(localStorage.getItem(countsKey) || 'null') as unknown,
      );
      const age = Date.now() - stored.receivedAt;
      return stored.authorityKey === authorityKey && age >= 0 && age < 120000
        ? stored.counts
        : null;
    } catch {
      return null;
    }
  });
  const times = useMemo(
    () =>
      (query.data?.expiringSoon || []).map((item) => ({
        item,
        expiresAt: fulfillmentExpiryInstant(item.expiresAt, query.data?.businessTimeZone),
      })),
    [query.data],
  );
  const close = () => {
    dialog.current?.close();
    setBatch(null);
    setRevision((value) => value + 1);
  };

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      dialog.current?.close();
      try {
        localStorage.removeItem(countsKey);
      } catch {
        /* Private cached counts are optional. */
      }
    };
  }, [countsKey]);
  useEffect(() => {
    if (query.authorityDenied) {
      dialog.current?.close();
      setBatch(null);
      setCachedCounts(null);
      try {
        localStorage.removeItem(countsKey);
      } catch {
        /* No stale authority fallback. */
      }
      return;
    }
    if (!query.data || !query.isSuccess) return;
    setCachedCounts(query.data.bannerCounts);
    try {
      localStorage.setItem(
        countsKey,
        JSON.stringify({ counts: query.data.bannerCounts, receivedAt: Date.now(), authorityKey }),
      );
    } catch {
      /* Counts remain reactive in memory. */
    }
  }, [query.data, query.isSuccess, query.authorityDenied, countsKey, authorityKey]);
  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    const storage = (event: StorageEvent) => {
      if (event.key === countsKey) {
        try {
          const stored = cachedCountsSchema.parse(JSON.parse(event.newValue || 'null') as unknown);
          const age = Date.now() - stored.receivedAt;
          setCachedCounts(
            stored.authorityKey === authorityKey && age >= 0 && age < 120000 ? stored.counts : null,
          );
        } catch {
          setCachedCounts(null);
        }
      }
      if (event.key === seenKey || event.key === countsKey || event.key === null) refresh();
    };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('storage', storage);
    let scheduled = false;
    let previous = otherDialog(dialog.current);
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (!live.current) return;
        const next = otherDialog(dialog.current);
        if (next !== previous) {
          previous = next;
          refresh();
        }
      });
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['open', 'role', 'aria-modal', 'hidden', 'style', 'class'],
    });
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('storage', storage);
    };
  }, [seenKey, countsKey, authorityKey]);
  useEffect(() => {
    const now = Date.now();
    const next = times
      .flatMap(({ expiresAt }) =>
        expiresAt === null ? [] : [expiresAt - 1800000, expiresAt - 300000, expiresAt],
      )
      .filter((time) => time > now);
    if (!next.length) return;
    const timer = setTimeout(() => setRevision((value) => value + 1), Math.min(...next) - now + 1);
    return () => clearTimeout(timer);
  }, [times, revision]);
  useEffect(() => {
    if (!query.data || query.authorityDenied) return;
    const activeIds = new Set(
      times
        .filter(({ expiresAt }) => expiresAt !== null && expiresAt > Date.now())
        .map(({ item }) => item.orderId),
    );
    const seen = { ...memorySeen.current, ...readSeen(seenKey) };
    for (const key of Object.keys(seen)) {
      const orderId = key.slice(0, key.lastIndexOf(':'));
      if (!activeIds.has(orderId)) delete seen[key];
    }
    saveSeen(seenKey, seen);
    memorySeen.current = seen;
    if (batch) {
      const remaining = batch.items.filter((item) => activeIds.has(item.orderId));
      const urgentWaiting =
        batch.threshold === 30 &&
        times.some(
          ({ item, expiresAt }) =>
            expiresAt !== null &&
            expiresAt > Date.now() &&
            expiresAt - Date.now() <= 300000 &&
            !seen[`${item.orderId}:5`],
        );
      if (!remaining.length || otherDialog(dialog.current) || urgentWaiting) {
        dialog.current?.close();
        setBatch(null);
      } else if (remaining.length !== batch.items.length) setBatch({ ...batch, items: remaining });
    }
    if (batch || dialog.current?.open || document.visibilityState !== 'visible') return;
    let stopped = false;
    const display = () => {
      const element = dialog.current;
      if (
        stopped ||
        !live.current ||
        !element ||
        element.open ||
        otherDialog(element) ||
        document.visibilityState !== 'visible' ||
        latest.current !== query.data
      )
        return;
      const currentSeen = { ...memorySeen.current, ...readSeen(seenKey) };
      const pending: Batch[] = [
        { threshold: 5, items: [] },
        { threshold: 30, items: [] },
      ];
      for (const { item, expiresAt } of times) {
        if (expiresAt === null) continue;
        const minutes = (expiresAt - Date.now()) / 60000;
        const threshold =
          minutes > 0 && minutes <= 5 ? 5 : minutes > 5 && minutes <= 30 ? 30 : null;
        if (threshold === null || currentSeen[`${item.orderId}:${threshold}`]) continue;
        const group = pending.find((entry) => entry.threshold === threshold)!;
        if (!group.items.some((entry) => entry.orderId === item.orderId)) group.items.push(item);
      }
      const chosen = pending.find((group) => group.items.length);
      if (!chosen) return;
      flushSync(() => setBatch(chosen));
      try {
        element.showModal();
      } catch {
        setBatch(null);
        return;
      }
      for (const item of chosen.items) currentSeen[`${item.orderId}:${chosen.threshold}`] = true;
      saveSeen(seenKey, currentSeen);
      memorySeen.current = currentSeen;
      element.querySelector<HTMLButtonElement>('button')?.focus();
    };
    const timer = setTimeout(() => {
      if (navigator.locks)
        void navigator.locks
          .request(`pos-fulfillment-expiry:${scope}`, display)
          .catch(() => undefined);
      else display();
    }, 0);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [query.data, query.authorityDenied, times, batch, revision, seenKey, scope]);

  if (query.authorityDenied) return null;
  const counts = cachedCounts;
  const pending = batch?.items.filter((item) => item.type === 'pending') || [];
  const accepted = batch?.items.filter((item) => item.type === 'accepted') || [];
  return (
    <>
      {counts && counts.unaccepted + counts.unpacked + counts.packed > 0 && (
        <aside className="fulfillment-global-banner" aria-label="Fulfillment status">
          <strong>Orders need attention</strong>
          {counts.unaccepted > 0 && (
            <Link to="/fulfillment?tab=in_queue">{counts.unaccepted} to accept</Link>
          )}
          {counts.unpacked > 0 && (
            <Link to="/fulfillment?tab=not_packed">{counts.unpacked} to pack</Link>
          )}
          {counts.packed > 0 && <Link to="/fulfillment?tab=packed">{counts.packed} packed</Link>}
        </aside>
      )}
      <dialog
        ref={dialog}
        className="fulfillment-expiry-dialog"
        aria-labelledby="fulfillment-expiry-title"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom
          )
            close();
        }}
        onClose={() => {
          if (!dialog.current?.open) setBatch(null);
        }}
      >
        <h2 id="fulfillment-expiry-title">
          {batch?.threshold === 5 ? 'Urgent: action required' : 'Orders expiring soon'}
        </h2>
        {pending.length > 0 && (
          <p>
            Accept {pending.length} order(s) within approximately {batch?.threshold} minutes to
            avoid automatic cancellation.
          </p>
        )}
        {accepted.length > 0 && (
          <p>
            {accepted.length} order(s) will be automatically marked as packed in approximately{' '}
            {batch?.threshold} minutes.
          </p>
        )}
        <ul>
          {batch?.items.map((item) => (
            <li key={item.orderId}>Order #{item.orderId}</li>
          ))}
        </ul>
        <div className="fulfillment-expiry-actions">
          <button className="button secondary" onClick={close}>
            Dismiss
          </button>
          {pending.length > 0 && (
            <Link className="button primary" to="/fulfillment?tab=in_queue" onClick={close}>
              Review orders to accept
            </Link>
          )}
          {accepted.length > 0 && (
            <Link className="button primary" to="/fulfillment?tab=not_packed" onClick={close}>
              Review orders to pack
            </Link>
          )}
        </div>
      </dialog>
    </>
  );
}
