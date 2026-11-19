import type { ReactNode } from 'react';
import { AlertCircle, ArrowUpRight, LoaderCircle, PackageOpen } from 'lucide-react';
import { errorRequestId } from '../api/client';

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
