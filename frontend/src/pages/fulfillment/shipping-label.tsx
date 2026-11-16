import { useEffect, useRef, useState } from 'react';
import { liveQuery } from 'dexie';
import { useQuery } from '@tanstack/react-query';
import { Printer, Tag, X } from 'lucide-react';
import { captureOperatorScope, requestWithResponse } from '../../api/client';
import type { Principal } from '../../api/types';
import { ErrorState, Loading } from '../../components/common';
import { db } from '../../offline/database';

const fingerprint = (user: Principal) =>
  JSON.stringify([user.id, user.role, user.userType, [...new Set(user.storeIds)].sort()]);
function allowed(user: Principal, storeId: string) {
  return (
    /^[1-9]\d{0,19}$/.test(storeId) &&
    ((user.role === 1 && user.userType === 1) || user.storeIds.includes(storeId))
  );
}
async function currentSession(user: Principal, storeId: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const cached = await db.sessions.get('current');
  signal.throwIfAborted();
  if (
    !cached ||
    cached.expiresAt <= Date.now() ||
    fingerprint(cached.user) !== fingerprint(user) ||
    !allowed(cached.user, storeId) ||
    localStorage.getItem('pos-pending-logout')
  )
    throw new Error('Sign in with a current operator session for this store.');
  return cached;
}
export async function readShippingDocument(response: Response, storeId: string, orderId: string) {
  if (!/^[1-9]\d{0,19}$/.test(storeId) || !/^[1-9]\d{0,19}$/.test(orderId))
    throw new Error('A permitted shipping label scope is required.');
  if (!response.headers.get('content-type')?.startsWith('text/html'))
    throw new Error('The shipping service returned an unsupported document.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The shipping document is unavailable.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > 524288) {
        await reader.cancel();
        throw new Error('The shipping document exceeds its supported size.');
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const html = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (
    !html.includes(`<meta name="pos-shipping-label" content="${storeId}:${orderId}">`) ||
    !html.includes('Content-Security-Policy') ||
    /<script\b/i.test(html)
  )
    throw new Error('The shipping document evidence could not be confirmed.');
  return html;
}
export function ShippingLabelAction({
  user,
  storeId,
  orderId,
  online,
}: {
  user: Principal;
  storeId: string;
  orderId: string;
  online: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!allowed(user, storeId)) return null;
  return (
    <>
      <button className="button secondary" disabled={!online} onClick={() => setOpen(true)}>
        <Tag size={16} />
        Shipping label
      </button>
      {open && (
        <ShippingLabelDialog
          key={fingerprint(user) + ':' + storeId + ':' + orderId}
          user={user}
          storeId={storeId}
          orderId={orderId}
          online={online}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
export function ShippingLabelDialog({
  user,
  storeId,
  orderId,
  online,
  onClose,
}: {
  user: Principal;
  storeId: string;
  orderId: string;
  online: boolean;
  onClose: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null),
    pendingPrint = useRef<AbortSignal | null>(null),
    [scope, setScope] = useState<AbortSignal | null>(null),
    [authorized, setAuthorized] = useState(false),
    [ready, setReady] = useState(false),
    [error, setError] = useState<Error | null>(null),
    [printing, setPrinting] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined, owner: AbortSignal;
    const revoke = () => {
      controller.abort();
      setAuthorized(false);
      setReady(false);
      pendingPrint.current = null;
      setError(new Error('Sign in with a current operator session for this store.'));
    };
    try {
      owner = captureOperatorScope(user.id);
    } catch {
      revoke();
      return () => controller.abort();
    }
    const signal = AbortSignal.any([owner, controller.signal]);
    setScope(signal);
    owner.addEventListener('abort', revoke, { once: true });
    const subscription = liveQuery(() => currentSession(user, storeId, signal)).subscribe({
      next: (cached) => {
        if (signal.aborted) return;
        setAuthorized(true);
        if (timer) clearTimeout(timer);
        timer = setTimeout(
          revoke,
          Math.max(0, Math.min(2147483647, cached.expiresAt - Date.now())),
        );
      },
      error: revoke,
    });
    const storage = (event: StorageEvent) => {
      if (event.key === 'pos-pending-logout' && event.newValue) revoke();
    };
    window.addEventListener('storage', storage);
    return () => {
      subscription.unsubscribe();
      owner.removeEventListener('abort', revoke);
      window.removeEventListener('storage', storage);
      if (timer) clearTimeout(timer);
      controller.abort();
    };
  }, [user, storeId]);
  const preview = useQuery({
    queryKey: [user.id, 'shipping-label', fingerprint(user), storeId, orderId],
    enabled: authorized && online && !!scope && !scope.aborted,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async ({ signal }) => {
      if (!allowed(user, storeId) || !/^[1-9]\d{0,19}$/.test(orderId))
        throw new Error('A permitted shipping label scope is required.');
      const captured = AbortSignal.any([
        captureOperatorScope(user.id),
        signal,
        ...(scope ? [scope] : []),
      ]);
      await currentSession(user, storeId, captured);
      const html = await requestWithResponse(
        `/api/v1/stores/${encodeURIComponent(storeId)}/fulfillment/orders/${encodeURIComponent(orderId)}/shipping-label/preview`,
        {
          operatorId: user.id,
          signal: captured,
          cache: 'no-store',
          headers: { Accept: 'text/html' },
        },
        (response) => readShippingDocument(response, storeId, orderId),
      );
      await currentSession(user, storeId, captured);
      return { html, revision: crypto.randomUUID() };
    },
  });
  async function loaded() {
    try {
      if (!scope) throw new Error('The current operator session is unavailable.');
      await currentSession(user, storeId, scope);
      const meta = frame.current?.contentDocument?.querySelector('meta[name="pos-shipping-label"]');
      if (meta?.getAttribute('content') !== `${storeId}:${orderId}`)
        throw new Error('The shipping preview could not be confirmed.');
      setReady(true);
      const print = pendingPrint.current;
      pendingPrint.current = null;
      if (print) {
        print.throwIfAborted();
        await currentSession(user, storeId, print);
        frame.current?.contentWindow?.focus();
        frame.current?.contentWindow?.print();
        setPrinting(false);
      }
    } catch (value) {
      pendingPrint.current = null;
      setPrinting(false);
      setReady(false);
      if (scope && !scope.aborted)
        setError(value instanceof Error ? value : new Error('Shipping preview unavailable.'));
    }
  }
  async function print() {
    try {
      const signal = AbortSignal.any([captureOperatorScope(user.id), ...(scope ? [scope] : [])]);
      await currentSession(user, storeId, signal);
      setError(null);
      setReady(false);
      setPrinting(true);
      pendingPrint.current = signal;
      const result = await preview.refetch({ throwOnError: true });
      signal.throwIfAborted();
      if (!result.data) throw new Error('The shipping document is unavailable.');
    } catch (value) {
      pendingPrint.current = null;
      setPrinting(false);
      if (scope && !scope.aborted)
        setError(value instanceof Error ? value : new Error('Shipping preview unavailable.'));
    }
  }
  return (
    <div className="modal-backdrop">
      <section
        className="modal"
        style={{
          width: 'min(96vw,46rem)',
          maxWidth: '46rem',
          maxHeight: '94dvh',
          overflow: 'auto',
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shipping-label-title"
      >
        <button
          className="icon-button modal-close"
          aria-label="Close shipping label"
          onClick={onClose}
        >
          <X size={20} />
        </button>
        <div className="eyebrow">EXPRESS FULFILLMENT</div>
        <h2 id="shipping-label-title">Order shipping label</h2>
        <p>
          Order {orderId} · Store {storeId}
        </p>
        {!online && <p role="status">Reconnect to read or print the current shipping label.</p>}
        {error && <ErrorState error={error} />}{' '}
        {preview.isError && (
          <ErrorState error={preview.error} retry={() => void preview.refetch()} />
        )}
        {authorized &&
          !preview.isError &&
          online &&
          (preview.isPending ? (
            <Loading />
          ) : (
            preview.data && (
              <iframe
                key={preview.data.revision}
                ref={frame}
                title={`Shipping label for order ${orderId}`}
                sandbox="allow-same-origin allow-modals"
                referrerPolicy="no-referrer"
                srcDoc={preview.data.html}
                style={{
                  width: '100%',
                  height: 'min(62vh,650px)',
                  border: '1px solid var(--border)',
                }}
                onLoad={() => void loaded()}
              />
            )
          ))}
        <div className="cash-actions">
          <button
            className="button primary"
            disabled={!authorized || !online || !ready || printing || preview.isFetching}
            onClick={() => void print()}
          >
            <Printer size={16} />
            {printing ? 'Preparing current label…' : 'Print shipping label'}
          </button>
          <button className="button secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </section>
    </div>
  );
}
