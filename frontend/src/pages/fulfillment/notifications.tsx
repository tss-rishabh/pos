import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink } from 'react-router-dom';
import { Bell, Check, CloudOff, Truck, Volume2, VolumeX } from 'lucide-react';
import type { Principal } from '../../api/types';
import { request } from '../../api/client';
import { Empty, ErrorState, Loading } from '../../components/common';
import { useOnline } from '../../hooks/use-pos';
import { useStoreCheckIn } from '../../hooks/use-store-check-in';
import {
  notificationEventSchema,
  storeNoticesSchema,
  type IncomingNotificationAlert,
  type StoreNotice,
} from './notification-contracts';
import { IncomingNotificationAlerts } from './notification-alerts';
import { isNewOrderNotice, notificationDestination } from './notification-links';
import { useNotificationSound } from './notification-sound';
import { useFulfillmentExpiryAlerts } from './expiry-alerts';
import './style.css';

export function NotificationsPanel({ user, storeId }: { user: Principal; storeId: string }) {
  const client = useQueryClient(),
    [open, setOpen] = useState(false),
    [connected, setConnected] = useState(false),
    [accessChanged, setAccessChanged] = useState(false),
    [reconnectVersion, setReconnectVersion] = useState(0),
    [alerts, setAlerts] = useState<IncomingNotificationAlert[]>([]);
  const online = useOnline();
  // Legacy shows store notifications only to an operator checked into that store; the server
  // refuses the feed and stream otherwise (403 CHECK_IN_REQUIRED), so nothing is requested.
  const storeCheckIn = useStoreCheckIn(user.id, storeId, online && !!storeId);
  const checkedIn = storeCheckIn.checkedIn;
  const sound = useNotificationSound(user.id, storeId);
  const seen = useRef(new Set<string>());
  const knownNotices = useRef(new Set<string>());
  const pendingNotices = useRef(new Map<string, boolean>());
  const incomingKinds = useRef(new Map<string, boolean>());
  const initialized = useRef(false);
  const feed = useQuery({
    queryKey: [user.id, 'notifications', storeId],
    enabled: !!storeId && online && checkedIn && !accessChanged,
    queryFn: ({ signal }) =>
      request(
        `/api/v1/stores/${encodeURIComponent(storeId)}/notifications`,
        { operatorId: user.id, signal },
        storeNoticesSchema,
      ),
    staleTime: 30000,
  });
  const expiry = useFulfillmentExpiryAlerts(
    user.id,
    storeId,
    connected && online && checkedIn && !accessChanged,
  );
  const queueCount = expiry.data?.bannerCounts.unaccepted ?? 0;
  const scope = { operatorId: user.id, storeId };
  const dismiss = useCallback((id: string) => {
    setAlerts((current) => current.filter((alert) => alert.notice.id !== id));
  }, []);
  const markRead = useMutation({
    mutationFn: (id: string) =>
      request(
        `/api/v1/stores/${encodeURIComponent(storeId)}/notifications/${encodeURIComponent(id)}/read-receipt`,
        {
          method: 'PUT',
          operatorId: user.id,
        },
      ),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: [user.id, 'notifications', storeId] });
    },
  });
  const resetRead = markRead.reset;
  const visit = (notice: StoreNotice) => {
    if (!notice.isViewed && online && checkedIn && !accessChanged) markRead.mutate(notice.id);
    setOpen(false);
  };
  const live = online && checkedIn && !accessChanged;
  const unreadCount = live && !feed.isError ? (feed.data?.unreadCount ?? 0) : 0;
  useEffect(() => {
    if (!live || feed.isError) {
      setAlerts([]);
      return;
    }
    const data = feed.data;
    if (!connected || !data) return;
    const arrived: IncomingNotificationAlert[] = [];
    for (const notice of data.data) {
      const unseen = !knownNotices.current.has(notice.id);
      const incoming = pendingNotices.current.get(notice.id);
      if (!notice.isViewed && unseen && (initialized.current || incoming !== undefined))
        arrived.push({ notice, isNewOrder: isNewOrderNotice(notice, incoming) });
      knownNotices.current.add(notice.id);
      pendingNotices.current.delete(notice.id);
    }
    initialized.current = true;
    while (knownNotices.current.size > 1000) {
      const id = knownNotices.current.values().next().value!;
      knownNotices.current.delete(id);
      incomingKinds.current.delete(id);
    }
    // Notifications are pointers. Titles, actions and read state come only from
    // the authenticated native feed, including after reconnecting past a gap.
    if (arrived.length) {
      setAlerts((current) => {
        const merged = new Map<string, IncomingNotificationAlert>();
        for (const alert of [...arrived, ...current]) {
          if (!merged.has(alert.notice.id)) merged.set(alert.notice.id, alert);
          if (merged.size === 3) break;
        }
        return [...merged.values()];
      });
      sound.play();
    }
    setAlerts((current) =>
      current.filter(
        (alert) => !data.data.some((notice) => notice.id === alert.notice.id && notice.isViewed),
      ),
    );
    if (
      markRead.isError &&
      data.data.some((notice) => notice.id === markRead.variables && notice.isViewed)
    )
      resetRead();
  }, [
    live,
    connected,
    feed.data,
    feed.isError,
    sound.play,
    markRead.isError,
    markRead.variables,
    resetRead,
  ]);
  useEffect(() => {
    seen.current.clear();
    knownNotices.current.clear();
    pendingNotices.current.clear();
    incomingKinds.current.clear();
    initialized.current = false;
    setAlerts([]);
    setAccessChanged(false);
  }, [user.id, storeId, reconnectVersion]);
  useEffect(() => {
    let stopped = false,
      socket: WebSocket | undefined,
      timer: ReturnType<typeof setTimeout> | undefined,
      attempt = 0;
    // No stream without a network or a check-in at this store: the handshake could only fail.
    if (!storeId || !online || !checkedIn) {
      setConnected(false);
      return;
    }
    const refreshFulfillment = () =>
      client.invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] === user.id &&
          query.queryKey[2] === storeId &&
          ['fulfillment-summary', 'fulfillment-orders', 'fulfillment-expiry-alerts'].includes(
            String(query.queryKey[1]),
          ),
      });
    function connect() {
      if (stopped) return;
      const url = new URL(`/api/v1/stores/${storeId}/notifications/stream`, window.location.origin);
      url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(url);
      socket.onopen = () => {
        if (stopped) return;
        setConnected(true);
        attempt = 0;
        void client.invalidateQueries({ queryKey: [user.id, 'notifications', storeId] });
        void refreshFulfillment();
      };
      socket.onmessage = (event) => {
        if (stopped) return;
        let parsed;
        try {
          parsed = notificationEventSchema.safeParse(JSON.parse(String(event.data)) as unknown);
        } catch {
          return;
        }
        if (!parsed.success || parsed.data.storeId !== storeId) return;
        const key = parsed.data.event + ':' + parsed.data.notificationId;
        if (seen.current.has(key)) return;
        seen.current.add(key);
        if (seen.current.size > 500) seen.current.delete(seen.current.values().next().value!);
        if (parsed.data.event === 'notification.created') {
          pendingNotices.current.set(parsed.data.notificationId, parsed.data.isNewOrder);
          incomingKinds.current.set(parsed.data.notificationId, parsed.data.isNewOrder);
          if (pendingNotices.current.size > 100) {
            const oldest = pendingNotices.current.keys().next().value!;
            pendingNotices.current.delete(oldest);
            if (!knownNotices.current.has(oldest)) incomingKinds.current.delete(oldest);
          }
        }
        void client.invalidateQueries({ queryKey: [user.id, 'notifications', storeId] });
        if (parsed.data.isNewOrder) void refreshFulfillment();
      };
      socket.onclose = (event) => {
        if (stopped) return;
        setConnected(false);
        if (event.code === 1008) {
          setAccessChanged(true);
          void client.invalidateQueries({ queryKey: ['operator'] });
          void client.invalidateQueries({ queryKey: [user.id, 'administration', 'my-check-in'] });
          return;
        }
        timer = setTimeout(connect, Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5)));
      };
    }
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      socket?.close();
      setConnected(false);
    };
  }, [user.id, storeId, client, reconnectVersion, online, checkedIn]);
  return (
    <div className="notification-widget">
      <div className="notification-controls">
        {queueCount > 0 && (
          <NavLink
            className="notification-queue-indicator"
            to="/fulfillment?tab=in_queue"
            aria-label={`${queueCount} ${queueCount === 1 ? 'order' : 'orders'} awaiting acceptance. View order queue.`}
          >
            <Truck size={15} />
            <span>{queueCount} in queue</span>
          </NavLink>
        )}
        <button
          className="icon-button notification-trigger"
          aria-label="Notifications"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <Bell size={18} />
          {unreadCount > 0 && <span>{unreadCount}</span>}
        </button>
        <button
          className="notification-sound-control"
          type="button"
          disabled={sound.unavailable}
          aria-label={
            sound.unavailable
              ? 'Notification sound unavailable'
              : sound.enabled && sound.ready
                ? 'Mute notification sound'
                : 'Enable notification sound'
          }
          onClick={() => {
            if (sound.enabled && sound.ready) sound.mute();
            else void sound.enable();
          }}
          title={
            sound.unavailable
              ? 'Sound is unavailable in this window.'
              : sound.enabled && sound.ready
                ? 'Mute notification sound'
                : 'Enable notification sound'
          }
        >
          {sound.enabled && sound.ready ? <Volume2 size={15} /> : <VolumeX size={15} />}
          <span>
            {sound.unavailable
              ? 'Sound unavailable'
              : sound.enabled && sound.ready
                ? 'Sound on'
                : 'Enable sound'}
          </span>
        </button>
      </div>
      <IncomingNotificationAlerts
        alerts={live && !feed.isError ? alerts : []}
        scope={scope}
        dismiss={dismiss}
        visit={visit}
      />
      {open && (
        <section className="surface notification-panel" aria-label="Store notifications">
          <header>
            <h2>Notifications</h2>
            <span className="muted">
              {connected ? (
                'Live'
              ) : (
                <>
                  <CloudOff size={12} />
                  {accessChanged
                    ? 'Store access changed'
                    : online && !storeCheckIn.pending && !checkedIn
                      ? 'Not checked in'
                      : 'Reconnecting'}
                </>
              )}
            </span>
          </header>
          {accessChanged && (
            <button
              className="button secondary"
              onClick={() => setReconnectVersion((value) => value + 1)}
            >
              Reconnect after checking store access
            </button>
          )}
          {accessChanged ? (
            <p className="notification-access-note">
              Check the current store and check-in before reconnecting.
            </p>
          ) : !online ? (
            <p className="notification-access-note">Notifications refresh when you reconnect.</p>
          ) : storeCheckIn.pending ? (
            <Loading />
          ) : !checkedIn ? (
            <p className="notification-access-note">
              Check into this store to see its notifications.
            </p>
          ) : feed.isPending ? (
            <Loading />
          ) : feed.isError ? (
            <ErrorState error={feed.error} />
          ) : feed.data.data.length === 0 ? (
            <Empty title="All quiet for now" />
          ) : (
            feed.data.data.map((notice) => {
              const destination = notificationDestination(
                notice,
                scope,
                incomingKinds.current.get(notice.id),
              );
              return (
                <article key={notice.id} className={notice.isViewed ? 'viewed' : ''}>
                  <strong>{notice.title}</strong>
                  {notice.orderId && (
                    <span className="notification-order-reference">Order {notice.orderId}</span>
                  )}
                  <small>{notice.createdAt}</small>
                  <div>
                    {destination && (
                      <NavLink
                        to={destination.to}
                        state={destination.state}
                        onClick={() => visit(notice)}
                      >
                        View details
                      </NavLink>
                    )}
                    {!notice.isViewed && (
                      <button
                        className="text-button"
                        disabled={markRead.isPending || !live}
                        onClick={() => markRead.mutate(notice.id)}
                      >
                        <Check size={12} />
                        Mark read
                      </button>
                    )}
                  </div>
                </article>
              );
            })
          )}
          {markRead.isError && <ErrorState error={markRead.error} />}
        </section>
      )}
    </div>
  );
}
