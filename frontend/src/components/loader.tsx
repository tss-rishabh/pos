import type { CSSProperties } from 'react';
import { LoaderCircle } from 'lucide-react';

/**
 * The one loading vocabulary of the app (W27): an inline spinner, a block loader that reserves
 * the space of the content it stands for, and skeletons for grids, tables and text. Every loader
 * is a polite live region, so screen readers hear one "Loading …" announcement.
 */
export function Spinner({ size = 16, className = '' }: { size?: number; className?: string }) {
  return <LoaderCircle aria-hidden="true" className={`spin ${className}`.trim()} size={size} />;
}

export function Loader({
  label = 'Loading…',
  inline = false,
}: {
  label?: string;
  /** A one-line loader for panels and form sections instead of a block. */
  inline?: boolean;
}) {
  return (
    <div role="status" aria-live="polite" className={inline ? 'loader inline' : 'loader'}>
      <Spinner size={inline ? 14 : 22} />
      <span>{label}</span>
    </div>
  );
}

export function Skeleton({
  width,
  height = 12,
  radius,
}: {
  width?: CSSProperties['width'];
  height?: CSSProperties['height'];
  radius?: CSSProperties['borderRadius'];
}) {
  return (
    <span aria-hidden="true" className="skeleton" style={{ width, height, borderRadius: radius }} />
  );
}

/** Text lines, for detail panels and quote breakdowns. */
export function SkeletonText({
  lines = 3,
  label = 'Loading…',
}: {
  lines?: number;
  label?: string;
}) {
  return (
    <div role="status" aria-live="polite" className="skeleton-text">
      <span className="sr-only">{label}</span>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} width={index === lines - 1 ? '60%' : '100%'} />
      ))}
    </div>
  );
}

/** Product-card placeholders in the same grid as the catalogue, so nothing jumps on load. */
export function SkeletonCards({
  count = 6,
  label = 'Loading products…',
}: {
  count?: number;
  label?: string;
}) {
  return (
    <div role="status" aria-live="polite" className="product-grid skeleton-cards">
      <span className="sr-only">{label}</span>
      {Array.from({ length: count }, (_, index) => (
        <div aria-hidden="true" key={index} className="skeleton-card">
          <Skeleton height={155} radius={0} width="100%" />
          <div>
            <Skeleton width="45%" height={8} />
            <Skeleton width="85%" />
            <Skeleton width="35%" height={14} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Table placeholder rows with the table's own column count. */
export function SkeletonTable({
  rows = 5,
  columns = 5,
  label = 'Loading…',
}: {
  rows?: number;
  columns?: number;
  label?: string;
}) {
  return (
    <div role="status" aria-live="polite" className="skeleton-table">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, row) => (
        <div
          aria-hidden="true"
          key={row}
          style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}
        >
          {Array.from({ length: columns }, (_, column) => (
            <Skeleton key={column} width={column === 0 ? '70%' : '85%'} />
          ))}
        </div>
      ))}
    </div>
  );
}
