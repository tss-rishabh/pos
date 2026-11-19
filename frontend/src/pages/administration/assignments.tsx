import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { request } from '../../api/client';
import { commonStoreSchema } from './api';
import { Loading, ErrorState, RequestReference, useProblem } from '../../components/common';

export function AssignmentEditor({
  ownerId,
  title,
  initialIds,
  initialActiveStoreId,
  onSave,
  onClose,
}: {
  ownerId: string;
  title: string;
  initialIds: string[];
  initialActiveStoreId?: string | null;
  onSave: (ids: string[], activeStoreId: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    [selected, setSelected] = useState(new Set(initialIds)),
    [active, setActive] = useState(initialActiveStoreId || ''),
    [busy, setBusy] = useState(false),
    [error, setError, errorCause, reportError] = useProblem();
  const stores = useQuery({
    queryKey: [ownerId, 'administration', 'assignable-stores'],
    queryFn: () => request('/api/v1/stores', {}, z.object({ data: z.array(commonStoreSchema) })),
  });
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="administration-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="eyebrow">STORE ACCESS</div>
      <h2>{title}</h2>
      <p className="administration-notice">
        Only stores you can manage are shown. Existing assignments outside your scope remain
        unchanged.
      </p>
      {stores.isPending ? (
        <Loading />
      ) : stores.isError ? (
        <ErrorState error={stores.error} />
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError('');
            const ids = (stores.data?.data || [])
              .filter((store) => selected.has(store.id))
              .map((store) => store.id);
            void onSave(ids, active && ids.includes(active) ? active : null)
              .then(onClose)
              .catch((failure: unknown) => reportError(failure, 'Store access could not be saved.'))
              .finally(() => setBusy(false));
          }}
        >
          <div className="administration-assignment-list">
            {stores.data.data.map((store) => (
              <label key={store.id}>
                <input
                  type="checkbox"
                  checked={selected.has(store.id)}
                  onChange={(event) => {
                    const next = new Set(selected);
                    if (event.target.checked) next.add(store.id);
                    else next.delete(store.id);
                    setSelected(next);
                    if (active === store.id && !event.target.checked) setActive('');
                  }}
                />
                {store.name} · {store.locationCode}
              </label>
            ))}
          </div>
          {initialActiveStoreId !== undefined && (
            <label className="administration-notice">
              Active store{' '}
              <select
                aria-label="Active salesperson store"
                value={active}
                onChange={(event) => setActive(event.target.value)}
              >
                <option value="">No active store</option>
                {stores.data.data
                  .filter((store) => selected.has(store.id))
                  .map((store) => (
                    <option key={store.id} value={store.id}>
                      {store.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
          {error && (
            <div className="inline-error" role="alert">
              {error}
              <RequestReference error={errorCause} />
            </div>
          )}
          <div className="administration-dialog-actions">
            <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button className="button primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save store access'}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
