import { lazy, Suspense, useEffect, useState } from 'react';
import type { Principal } from '../../../api/types';
import type { OrderImportJob, OrderImportResult } from './client';
const Review = lazy(() => import('./ImportApprovalActions'));
export function ImportApprovalAction({
  user,
  job,
  row,
  online,
  enabled,
  pending,
  onPendingChanged,
}: {
  user: Principal;
  job: OrderImportJob;
  row: OrderImportResult;
  online: boolean;
  enabled: boolean;
  pending: boolean;
  onPendingChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(pending),
    visible = expanded || pending;
  useEffect(() => {
    if (pending) setExpanded(true);
  }, [pending]);
  if (row.state !== 'PENDING' && !visible) return null;
  return (
    <>
      <button
        type="button"
        aria-expanded={visible}
        disabled={!online && !visible}
        onClick={() => setExpanded((value) => !value)}
      >
        Review financial approval for CSV row {row.firstRow}
      </button>
      {visible && (
        <Suspense fallback={<p role="status">Loading financial approval…</p>}>
          <Review
            user={user}
            scope={{
              jobId: job.id,
              operationId: row.operationId,
              expected: {
                kind: job.kind,
                storeId: row.storeId,
                counterId: row.counterId,
                businessDate: row.businessDate,
              },
            }}
            online={online}
            enabled={enabled && row.state === 'PENDING'}
            canCreate={row.state === 'PENDING'}
            onPendingChanged={onPendingChanged}
          />
        </Suspense>
      )}
    </>
  );
}
