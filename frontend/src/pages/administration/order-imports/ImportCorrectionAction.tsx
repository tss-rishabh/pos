import { lazy, Suspense, useState } from 'react';
import type { Principal } from '../../../api/types';
import type { OrderImportJob, OrderImportResult } from './client';
import type { CorrectionReceipt, CorrectionFence } from './correction-client';
const Panel = lazy(() => import('./ImportCorrectionPanel'));
export function ImportCorrectionAction({
  user,
  job,
  row,
  online,
  enabled,
  canCreate,
  onRecorded,
  knownReceipt,
  onFenced,
  knownFence,
}: {
  user: Principal;
  job: OrderImportJob;
  row: OrderImportResult;
  online: boolean;
  enabled: boolean;
  canCreate: boolean;
  onRecorded: (receipt: CorrectionReceipt) => void;
  onFenced: (value: CorrectionFence) => void;
  knownReceipt?: CorrectionReceipt | null;
  knownFence?: CorrectionFence | null;
}) {
  const [expanded, setExpanded] = useState(false);
  if (row.state !== 'FAILED' && !expanded) return null;
  return (
    <>
      <button
        type="button"
        aria-expanded={expanded}
        disabled={!online && !expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        Review correction for CSV row {row.firstRow}
      </button>
      {expanded && (
        <Suspense fallback={<p role="status">Loading manager correction…</p>}>
          <Panel
            user={user}
            scope={{ jobId: job.id, operationId: row.operationId }}
            online={online}
            enabled={enabled}
            canCreate={canCreate}
            onRecorded={onRecorded}
            onFenced={onFenced}
            knownReceipt={knownReceipt}
            knownFence={knownFence}
            showReceipt={false}
          />
        </Suspense>
      )}
    </>
  );
}
