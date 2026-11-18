import { useCallback, useEffect, useRef, useState } from 'react';
import { liveQuery } from 'dexie';
import { Download, FileText, Printer, X } from 'lucide-react';
import type { Principal } from '../../api/types';
import { currentInvoiceSession, invoiceActorSignal, invoiceIdentity } from './session';
import {
  readInvoiceDocument,
  invoicePreviewPath,
  type InvoiceKind,
  type InvoiceAccess,
} from './client';
import {
  claimAutomaticInvoicePrint,
  currentAutomaticInvoice,
  type AutomaticInvoiceRequest,
} from './automatic';
import '../checkout/InvoiceActions.css';
const invoiceLabel = (kind: InvoiceKind) =>
  kind === 'online'
    ? 'Online tax invoice'
    : kind === 'same-day'
      ? 'SDD tax invoice'
      : kind === 'express'
        ? 'Store shipment tax invoice'
        : 'Tax invoice';
export interface InvoiceDocumentProps {
  user: Principal;
  access?: InvoiceAccess;
  storeId: string;
  orderId: string;
  kind?: InvoiceKind;
  online: boolean;
  available?: boolean;
}
type Mode = 'preview' | 'manual' | 'automatic';
type Rendered = {
  path: string;
  scopeKey: string;
  number: string | null;
  revision: string;
  mode: Mode;
};
export function InvoiceDocumentDialog({
  user,
  storeId,
  orderId,
  kind = 'store',
  access,
  online,
  onClose,
  automatic,
}: { onClose: () => void; automatic?: AutomaticInvoiceRequest } & InvoiceDocumentProps) {
  const frame = useRef<HTMLIFrameElement>(null),
    generation = useRef(0),
    rendered = useRef<Rendered | null>(null),
    controller = useRef<AbortController | null>(null),
    previewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    automaticDone = useRef(false),
    [document, setDocument] = useState<Rendered | null>(null),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [problem, setProblem] = useState(''),
    [authorized, setAuthorized] = useState(false);
  const identity = invoiceIdentity(user);
  const scopeKey = [user.id, storeId, orderId, kind, ...(access ? [access] : [])].join(':'),
    currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
  const load = useCallback(
    async (mode: Mode = 'preview') => {
      const version = ++generation.current;
      setBusy(true);
      setReady(false);
      setProblem('');
      if (previewTimer.current) clearTimeout(previewTimer.current);
      try {
        if (!online || !controller.current)
          throw new Error('Connect to load a current tax invoice.');
        const signal = invoiceActorSignal(user, controller.current.signal);
        await currentInvoiceSession(user, storeId, signal);
        signal.throwIfAborted();
        if (version !== generation.current || currentScope.current !== scopeKey) return;
        const next = {
          path: invoicePreviewPath(user.id, storeId, orderId, kind, access),
          scopeKey,
          number: null,
          revision: crypto.randomUUID(),
          mode,
        };
        rendered.current = next;
        setDocument(next);
        previewTimer.current = setTimeout(() => {
          if (generation.current !== version || rendered.current?.revision !== next.revision)
            return;
          rendered.current = null;
          setDocument(null);
          setBusy(false);
          setReady(false);
          setProblem('The invoice service did not respond. Refresh its current details.');
        }, 35000);
      } catch (error) {
        if (version === generation.current && !controller.current?.signal.aborted) {
          rendered.current = null;
          setDocument(null);
          setProblem(error instanceof Error ? error.message : 'The invoice could not be loaded.');
          setBusy(false);
        }
      }
    },
    [identity, storeId, orderId, kind, access, online, scopeKey],
  );
  useEffect(() => {
    const current = new AbortController();
    controller.current = current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const revoke = () => {
      current.abort();
      generation.current++;
      rendered.current = null;
      setDocument(null);
      setReady(false);
      setAuthorized(false);
      setBusy(false);
      setProblem('Sign in with a current operator session for this store.');
    };
    let owner: AbortSignal;
    try {
      owner = invoiceActorSignal(user, current.signal);
    } catch {
      revoke();
      return;
    }
    owner.addEventListener('abort', revoke, { once: true });
    const subscription = liveQuery(() => currentInvoiceSession(user, storeId, owner)).subscribe({
      next: (session) => {
        if (owner.aborted) return;
        setAuthorized(true);
        if (timer) clearTimeout(timer);
        timer = setTimeout(
          revoke,
          Math.max(0, Math.min(2147483647, session.expiresAt - Date.now())),
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
      if (previewTimer.current) clearTimeout(previewTimer.current);
      current.abort();
      generation.current++;
      controller.current = null;
    };
  }, [identity, storeId]);
  useEffect(() => {
    if (authorized && online) void load(automatic ? 'automatic' : 'preview');
  }, [authorized, online, load, automatic]);
  async function loaded(value: Rendered) {
    try {
      if (
        rendered.current?.revision !== value.revision ||
        currentScope.current !== value.scopeKey ||
        !controller.current ||
        !online
      )
        return;
      const signal = invoiceActorSignal(user, controller.current.signal);
      await currentInvoiceSession(user, storeId, signal);
      const content = frame.current?.contentDocument;
      const marker = content?.querySelector('meta[name="pos-invoice"]');
      const actualUrl = frame.current?.contentWindow?.location;
      if (
        marker?.getAttribute('content') !== 'sanitized' ||
        content?.querySelector('meta[name="pos-invoice-scope"]')?.getAttribute('content') !==
          value.scopeKey ||
        actualUrl?.origin !== window.location.origin ||
        (actualUrl?.pathname ?? '') + (actualUrl?.search ?? '') !== value.path ||
        actualUrl?.hash !== '' ||
        rendered.current?.revision !== value.revision ||
        currentScope.current !== value.scopeKey
      ) {
        let message =
          'The invoice preview could not be confirmed. Refresh its current authorization.';
        if (content?.contentType === 'application/json')
          try {
            const text = content.body?.textContent ?? '';
            if (text.length <= 2000) {
              const parsed = JSON.parse(text) as unknown;
              if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
                const error = parsed.error;
                if (
                  typeof error === 'object' &&
                  error !== null &&
                  'message' in error &&
                  typeof error.message === 'string' &&
                  error.message.length <= 500
                )
                  message = error.message;
              }
            }
          } catch {
            /* Unsupported error documents never become invoice content. */
          }
        throw new Error(message);
      }
      if (previewTimer.current) clearTimeout(previewTimer.current);
      const number =
        content?.querySelector('meta[name="pos-invoice-number"]')?.getAttribute('content') || null;
      const current = { ...value, number };
      rendered.current = current;
      setDocument(current);
      setBusy(false);
      setReady(true);
      if (value.mode === 'preview') return;
      if (value.mode === 'automatic') {
        if (!automatic || automaticDone.current) return;
        automaticDone.current = true;
        if (!(await claimAutomaticInvoicePrint(automatic, user, signal))) return;
      }
      signal.throwIfAborted();
      if (
        rendered.current?.revision !== value.revision ||
        currentScope.current !== value.scopeKey ||
        !online
      )
        return;
      frame.current?.contentWindow?.focus();
      frame.current?.contentWindow?.print();
    } catch (error) {
      if (previewTimer.current) clearTimeout(previewTimer.current);
      rendered.current = null;
      setDocument(null);
      setBusy(false);
      if (!controller.current?.signal.aborted)
        setProblem(
          error instanceof Error ? error.message : 'The invoice preview could not be confirmed.',
        );
      setReady(false);
    }
  }
  async function download() {
    try {
      if (!online || !controller.current) throw new Error('Connect to download a current invoice.');
      const signal = invoiceActorSignal(user, controller.current.signal);
      await currentInvoiceSession(user, storeId, signal);
      const value = await readInvoiceDocument(user.id, storeId, orderId, kind, signal, access);
      await currentInvoiceSession(user, storeId, signal);
      signal.throwIfAborted();
      const url = URL.createObjectURL(new Blob([value.html], { type: 'text/html;charset=utf-8' })),
        anchor = window.document.createElement('a');
      anchor.href = url;
      anchor.download = value.filename;
      window.document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      if (!controller.current?.signal.aborted)
        setProblem(error instanceof Error ? error.message : 'The invoice could not be downloaded.');
    }
  }
  return (
    <div className="modal-backdrop">
      <section
        className="modal invoice-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="invoice-title"
      >
        <button className="icon-button modal-close" aria-label="Close invoice" onClick={onClose}>
          <X size={20} />
        </button>
        <h2 id="invoice-title">
          {invoiceLabel(kind)}{' '}
          {(document?.scopeKey === scopeKey && document.number) || `for order ${orderId}`}
        </h2>
        <div className="invoice-toolbar">
          <button
            className="button primary"
            disabled={!authorized || !online || !ready || busy || document?.scopeKey !== scopeKey}
            onClick={() => void load('manual')}
          >
            <Printer size={16} /> Print invoice
          </button>
          <button
            className="button secondary"
            disabled={!authorized || !online || busy}
            onClick={() => void download()}
          >
            <Download size={16} /> Download invoice
          </button>
          <button
            className="button secondary"
            disabled={!authorized || !online || busy}
            onClick={() => void load()}
          >
            Refresh invoice
          </button>
        </div>
        {busy && <p role="status">Loading invoice…</p>}
        {!online && <p className="muted">Connect to load or print a current tax invoice.</p>}
        {problem && (
          <p role="alert" className="inline-error">
            {problem}
          </p>
        )}
        {authorized && online && document && document.scopeKey === scopeKey && (
          <iframe
            key={document.revision}
            ref={frame}
            title={`Tax invoice for order ${orderId}`}
            sandbox="allow-same-origin allow-modals"
            referrerPolicy="no-referrer"
            src={document.path}
            onLoad={() => void loaded(document)}
            className="invoice-preview"
          />
        )}
        {problem && (
          <button
            className="button secondary"
            disabled={!authorized || !online || busy}
            onClick={() => void load()}
          >
            Retry invoice
          </button>
        )}
      </section>
    </div>
  );
}
export function InvoiceDocumentAction(props: InvoiceDocumentProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="button secondary"
        disabled={!props.online || props.available === false}
        title={props.available === false ? 'Invoice service is currently unavailable.' : undefined}
        onClick={() => setOpen(true)}
      >
        <FileText size={16} />
        {invoiceLabel(props.kind ?? 'store')}
      </button>
      {open && (
        <InvoiceDocumentDialog
          key={
            invoiceIdentity(props.user) +
            ':' +
            props.storeId +
            ':' +
            props.orderId +
            ':' +
            props.kind +
            ':' +
            (props.access || 'owned-store')
          }
          {...props}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
export function AutomaticInvoicePreview({
  user,
  request,
  online,
  onClose,
}: {
  user: Principal;
  request: AutomaticInvoiceRequest;
  online: boolean;
  onClose?: () => void;
}) {
  const [closed, setClosed] = useState(false);
  if (closed || !currentAutomaticInvoice(request, user)) return null;
  return (
    <InvoiceDocumentDialog
      key={request.id}
      user={user}
      storeId={request.storeId}
      orderId={request.receipt.orderId}
      online={online}
      automatic={request}
      onClose={() => {
        setClosed(true);
        onClose?.();
      }}
    />
  );
}
