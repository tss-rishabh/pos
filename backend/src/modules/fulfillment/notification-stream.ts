import type { Duplex } from 'node:stream';
import { AppError } from '../../domain/errors.js';
import type { NotificationBus } from './notification-bus.js';

type Notice = Parameters<Parameters<NotificationBus['subscribe']>[3]>[0];
interface NotificationSocket {
  readonly OPEN: number;
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code: number, reason: string): void;
  ping(): void;
  once(event: 'close', listener: () => void): unknown;
}
const unavailable = () =>
  new AppError(503, 'NOTIFICATIONS_UNAVAILABLE', 'Live notifications are temporarily unavailable.');

/** Own one subscription from HTTP upgrade admission through transport closure. */
export function notificationStream(options: {
  transport: Duplex;
  subscribe: (receive: (notice: Notice) => void) => ReturnType<NotificationBus['subscribe']>;
  authorize: () => Promise<void>;
  valid: () => Promise<boolean>;
  expiresAt: number;
  onClosed: () => void;
}) {
  let socket: NotificationSocket | undefined;
  let closed = false,
    delivering = false,
    inFlight = false,
    queuedBytes = 0;
  let unsubscribe: (() => Promise<void>) | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let keepalive: ReturnType<typeof setInterval> | undefined;
  const pending: { data: string; bytes: number }[] = [];
  let cancel: () => void = () => {};
  const cancelled = new Promise<void>((resolve) => {
    cancel = resolve;
  });
  const unsubscribeOnce = () => {
    const stop = unsubscribe;
    unsubscribe = undefined;
    if (stop) void stop().catch(() => {});
  };
  function stop() {
    if (closed) return;
    closed = true;
    pending.length = 0;
    queuedBytes = 0;
    clearTimeout(expiry);
    clearInterval(keepalive);
    cancel();
    unsubscribeOnce();
    options.onClosed();
  }
  function transportClosed() {
    stop();
    options.transport.removeListener('error', transportEnded);
    options.transport.removeListener('end', transportEnded);
    options.transport.removeListener('finish', transportEnded);
  }
  function transportEnded() {
    // A half-closed upgrade transport can no longer carry a usable session.
    // End it fully rather than retaining broker resources until WS close timeout.
    stop();
    options.transport.destroy();
  }
  function end(code: number, reason: string) {
    if (closed) return;
    stop();
    socket?.close(code, reason);
  }
  async function drain() {
    if (delivering || !socket || closed) return;
    delivering = true;
    try {
      while (!closed && pending.length) {
        const item = pending.shift()!;
        inFlight = true;
        if (!(await options.valid())) {
          end(1008, 'Session expired');
          break;
        }
        if (!closed && socket.readyState === socket.OPEN) socket.send(item.data);
        queuedBytes = Math.max(0, queuedBytes - item.bytes);
        inFlight = false;
      }
    } catch {
      end(1013, 'Notifications unavailable');
    } finally {
      inFlight = false;
      delivering = false;
    }
  }
  function receive(notice: Notice) {
    if (closed) return;
    const data = JSON.stringify(notice),
      bytes = Buffer.byteLength(data);
    if (
      pending.length + Number(inFlight) >= 100 ||
      (socket?.bufferedAmount ?? 0) > 65536 ||
      queuedBytes + bytes > 65536
    ) {
      end(1013, 'Reconnect to refresh notifications');
      return;
    }
    pending.push({ data, bytes });
    queuedBytes += bytes;
    void drain();
  }
  // Retain transport cleanup through a server-initiated WS close handshake.
  options.transport.once('close', transportClosed);
  options.transport.once('error', transportEnded);
  options.transport.once('end', transportEnded);
  options.transport.once('finish', transportEnded);
  return {
    stop,
    async prepare() {
      if (options.transport.destroyed) stop();
      if (closed) throw unavailable();
      try {
        const subscribed = options.subscribe(receive).then((release) => {
          // A disconnect/overflow can precede the broker's ready response.
          if (closed) void release().catch(() => {});
          else unsubscribe = release;
        });
        await Promise.race([subscribed, cancelled]);
        if (closed) throw unavailable();
        await options.authorize();
        if (closed || options.transport.destroyed) throw unavailable();
      } catch (error) {
        stop();
        throw error instanceof AppError ? error : unavailable();
      }
    },
    attach(connected: NotificationSocket) {
      socket = connected;
      if (closed || options.transport.destroyed) {
        connected.close(1013, 'Notifications unavailable');
        return;
      }
      connected.once('close', stop);
      expiry = setTimeout(
        () => end(1008, 'Session expired'),
        Math.max(1, options.expiresAt - Date.now()),
      );
      keepalive = setInterval(() => {
        void options
          .valid()
          .then((valid) => {
            if (closed) return;
            if (!valid) end(1008, 'Session expired');
            else connected.ping();
          })
          .catch(() => end(1013, 'Notifications unavailable'));
      }, 30000);
      void drain();
    },
  };
}
