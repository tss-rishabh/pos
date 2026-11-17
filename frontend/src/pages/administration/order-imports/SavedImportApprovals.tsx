import { lazy, Suspense, useState } from 'react';
import type { Principal } from '../../../api/types';
import type { ImportApprovalIntent } from './approval-journal';
const Review = lazy(() => import('./ImportApprovalActions'));
export function SavedImportApprovals({
  user,
  intents,
  online,
  enabled,
  onPendingChanged,
}: {
  user: Principal;
  intents: ImportApprovalIntent[];
  online: boolean;
  enabled: boolean;
  onPendingChanged: () => void;
}) {
  const [selected, setSelected] = useState<ImportApprovalIntent | null>(null),
    [limit, setLimit] = useState(20);
  if (!intents.length && !selected) return null;
  return (
    <section aria-label="Saved financial approval requests">
      <h2>Saved financial approvals</h2>
      {!!intents.length && (
        <>
          <p>
            {intents.length} original approval request{intents.length === 1 ? '' : 's'} need receipt
            recovery. They remain available when you prepare another file.
          </p>
          <ul>
            {intents.slice(0, limit).map((value) => (
              <li key={value.commandId}>
                <button type="button" onClick={() => setSelected(value)}>
                  Recover approval {value.commandId}
                </button>
                <span> · Import {value.jobId}</span>
              </li>
            ))}
          </ul>
          {limit < intents.length && (
            <button type="button" onClick={() => setLimit((value) => value + 20)}>
              Show more saved approvals
            </button>
          )}
        </>
      )}
      {selected && (
        <Suspense fallback={<p role="status">Loading financial approval…</p>}>
          <Review
            key={selected.commandId}
            user={user}
            scope={{ jobId: selected.jobId, operationId: selected.operationId }}
            online={online}
            enabled={enabled}
            canCreate={false}
            onPendingChanged={onPendingChanged}
          />
        </Suspense>
      )}
    </section>
  );
}
