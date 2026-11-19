import { useCallback, useState, type ReactNode } from 'react';
import { AlertCircle, ArrowUpRight, LoaderCircle, PackageOpen } from 'lucide-react';
import { ApiError, errorRequestId } from '../api/client';

export function Loading() {
  return (
    <div className="empty">
      <LoaderCircle className="spin" size={28} />
      <p>Loading your workspace…</p>
    </div>
  );
}
export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div role="alert" className="empty error">
      <AlertCircle size={28} />
      <p>{error instanceof Error ? error.message : 'Something went wrong.'}</p>
      <RequestReference error={error} />
      {retry && (
        <button className="button secondary" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}
/**
 * Problem-message state that remembers the failure behind it, so the message can be shown with
 * `<RequestReference error={cause} />`. `setMessage` sets a plain message (and forgets the cause);
 * `report(error, fallback)` shows the error's message, or the fallback for non-Error values (or
 * for non-API errors when `apiOnly`), and keeps the error for its request reference.
 */
export function useProblem(initial = '') {
  const [state, setState] = useState<{ message: string; cause: unknown }>({
    message: initial,
    cause: null,
  });
  const setMessage = useCallback((message: string) => setState({ message, cause: null }), []);
  const report = useCallback(
    (error: unknown, fallback: string, options: { apiOnly?: boolean } = {}) =>
      setState({
        message:
          error instanceof Error && (!options.apiOnly || error instanceof ApiError)
            ? error.message
            : fallback,
        cause: error,
      }),
    [],
  );
  return [state.message, setMessage, state.cause, report] as const;
}
/** The server request ID of a failed call, for support to look up the request's logs. */
export function RequestReference({ error }: { error: unknown }) {
  const requestId = errorRequestId(error);
  if (!requestId) return null;
  return (
    <p className="request-reference">
      Reference <code>{requestId}</code>
    </p>
  );
}
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <PackageOpen size={32} />
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
export function PageTitle({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-title">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>
          {title}
          <span className="title-dot">.</span>
        </h1>
      </div>
      {children}
    </div>
  );
}
export function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="metric">
      <div>
        {label}
        <ArrowUpRight size={15} />
      </div>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}
