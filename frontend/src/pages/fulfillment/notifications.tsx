import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Check, CloudOff } from 'lucide-react';
import { z } from 'zod';
import type { Principal } from '../../api/types';
import { request } from '../../api/client';
import { Empty, ErrorState, Loading } from '../../components/common';
import './style.css';

const notices = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      url: z.string().nullable(),
      orderId: z.string().nullable(),
      isViewed: z.boolean(),
      createdAt: z.string(),
    }),
  ),
  unreadCount: z.number(),
  hasMore: z.boolean(),
});
const eventSchema = z.object({
  event: z.enum(['notification.created', 'notification.read']),
  notificationId: z.string(),
  storeId: z.string(),
  isNewOrder: z.boolean(),
});
export function NotificationsPanel({ user, storeId }: { user: Principal; storeId: string }) {
  const client = useQueryClient(),
    [open, setOpen] = useState(false),
    [connected, setConnected] = useState(false),
    [accessChanged, setAccessChanged] = useState(false),
    [reconnectVersion, setReconnectVersion] = useState(0);
  const seen = useRef(new Set<string>());
  const feed = useQuery({
    queryKey: [user.id, 'notifications', storeId],
    enabled: !!storeId,
    queryFn: () => request(`/api/v1/stores/${storeId}/notifications`, {}, notices),
    staleTime: 30000,
  });
  const markRead = useMutation({
    mutationFn: (id: string) =>
      request(`/api/v1/stores/${storeId}/notifications/${id}/read-receipt`, {
        method: 'PUT',
        operatorId: user.id,
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: [user.id, 'notifications', storeId] });
    },
  });
  useEffect(() => {
    if (!storeId) return;
    let stopped = false,
      socket: WebSocket | undefined,
      timer: ReturnType<typeof setTimeout> | undefined,
      attempt = 0;
    seen.current.clear();
    setAccessChanged(false);
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
        setConnected(true);
        attempt = 0;
        void client.invalidateQueries({ queryKey: [user.id, 'notifications', storeId] });
        void refreshFulfillment();
      };
      socket.onmessage = (event) => {
        let parsed;
        try {
          parsed = eventSchema.safeParse(JSON.parse(String(event.data)) as unknown);
        } catch {
          return;
        }
        if (!parsed.success || parsed.data.storeId !== storeId) return;
        const key = parsed.data.event + ':' + parsed.data.notificationId;
        if (seen.current.has(key)) return;
        seen.current.add(key);
        if (seen.current.size > 500) seen.current.delete(seen.current.values().next().value!);
        void client.invalidateQueries({ queryKey: [user.id, 'notifications', storeId] });
        if (parsed.data.isNewOrder) void refreshFulfillment();
      };
      socket.onclose = (event) => {
        setConnected(false);
        if (stopped) return;
        if (event.code === 1008) {
          setAccessChanged(true);
          void client.invalidateQueries({ queryKey: ['operator'] });
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
  }, [user.id, storeId, client, reconnectVersion]);
  return (
    <div className="notification-widget">
      <button
        className="icon-button notification-trigger"
        aria-label="Notifications"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Bell size={18} />
        {Boolean(feed.data?.unreadCount) && <span>{feed.data!.unreadCount}</span>}
      </button>
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
                  {accessChanged ? 'Store access changed' : 'Reconnecting'}
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
          {feed.isPending ? (
            <Loading />
          ) : feed.isError ? (
            <ErrorState error={feed.error} />
          ) : feed.data.data.length === 0 ? (
            <Empty title="All quiet for now" />
          ) : (
            feed.data.data.map((notice) => (
              <article key={notice.id} className={notice.isViewed ? 'viewed' : ''}>
                <strong>{notice.title}</strong>
                <small>{notice.createdAt}</small>
                <div>
                  {notice.url && <a href={notice.url}>View details</a>}
                  {!notice.isViewed && (
                    <button
                      className="text-button"
                      disabled={markRead.isPending}
                      onClick={() => markRead.mutate(notice.id)}
                    >
                      <Check size={12} />
                      Mark read
                    </button>
                  )}
                </div>
              </article>
            ))
          )}
        </section>
      )}
    </div>
  );
}
