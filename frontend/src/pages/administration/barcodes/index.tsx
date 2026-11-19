import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Principal } from '../../../api/types';
import { ApiError, captureOperatorScope } from '../../../api/client';
import { ErrorState, PageTitle } from '../../../components/common';
import { useOnline } from '../../../hooks/use-pos';
import {
  assignmentInput,
  assignBarcode,
  readAssignment,
  type AssignmentInput,
  type AssignmentReceipt,
} from './api';
import {
  pendingAssignments,
  savePendingAssignment,
  removePendingAssignment,
  type PendingAssignment,
} from './pending';
function initialPending(ownerId: string) {
  try {
    return { rows: pendingAssignments(ownerId), error: null };
  } catch (error) {
    return { rows: [], error };
  }
}
function BarcodeForm({ user }: { user: Principal }) {
  const client = useQueryClient(),
    online = useOnline(),
    [initial] = useState(() => initialPending(user.id)),
    [pending, setPending] = useState<PendingAssignment[]>(initial.rows),
    [storageError, setStorageError] = useState<unknown>(initial.error),
    [error, setError] = useState<unknown>(null),
    [receipt, setReceipt] = useState<AssignmentReceipt | null>(null),
    [productId, setProductId] = useState(''),
    [barcode, setBarcode] = useState(''),
    [busy, setBusy] = useState(false),
    [retryId, setRetryId] = useState<string | null>(null),
    running = useRef(false),
    controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const local = new AbortController();
    controller.current = local;
    const reload = () => {
      try {
        setPending(pendingAssignments(user.id));
        setStorageError(null);
      } catch (problem) {
        setStorageError(problem);
      }
    };
    window.addEventListener('storage', reload);
    return () => {
      local.abort();
      window.removeEventListener('storage', reload);
    };
  }, [user.id]);
  function signal() {
    if (!controller.current) throw new DOMException('This editor is closed.', 'AbortError');
    return AbortSignal.any([controller.current.signal, captureOperatorScope(user.id)]);
  }
  function publish(result: AssignmentReceipt, input: AssignmentInput, scope: AbortSignal) {
    scope.throwIfAborted();
    setReceipt(result);
    setRetryId(null);
    setError(null);
    setBarcode('');
    if (result.status === 'success')
      void (async () => {
        await client.cancelQueries({ queryKey: [user.id, 'products'] });
        scope.throwIfAborted();
        await client.invalidateQueries({ queryKey: [user.id, 'products'], refetchType: 'none' });
      })().catch(() => {
        /* Cache refresh cannot change the committed assignment receipt. */
      });
    try {
      removePendingAssignment(user.id, input);
      setPending(pendingAssignments(user.id));
      setStorageError(null);
    } catch (problem) {
      setStorageError(problem);
    }
  }
  async function submit(saved?: AssignmentInput) {
    if (running.current) return;
    let scope: AbortSignal;
    try {
      scope = signal();
    } catch (problem) {
      setError(problem);
      return;
    }
    running.current = true;
    setBusy(true);
    setReceipt(null);
    setError(null);
    setRetryId(null);
    try {
      const parsed = assignmentInput.safeParse(
        saved || { operationId: crypto.randomUUID(), productId, barcode },
      );
      if (!parsed.success)
        throw new Error(
          'Enter a positive whole product ID and barcode within the supported range.',
        );
      const input = parsed.data;
      if (!saved && pendingAssignments(user.id).length)
        throw new Error('Check the original saved assignment before creating another action.');
      savePendingAssignment(user.id, input);
      scope.throwIfAborted();
      setPending(pendingAssignments(user.id));
      const result = await assignBarcode(user.id, input, scope);
      publish(result, input, scope);
    } catch (problem) {
      if (!scope.aborted) setError(problem);
    } finally {
      running.current = false;
      if (!scope.aborted) setBusy(false);
    }
  }
  async function recover(input: AssignmentInput) {
    if (running.current) return;
    let scope: AbortSignal;
    try {
      scope = signal();
    } catch (problem) {
      setError(problem);
      return;
    }
    running.current = true;
    setBusy(true);
    setReceipt(null);
    setError(null);
    setRetryId(null);
    try {
      publish(await readAssignment(user.id, input, scope), input, scope);
    } catch (problem) {
      if (!scope.aborted) {
        if (
          problem instanceof ApiError &&
          problem.status === 404 &&
          problem.code === 'BARCODE_ASSIGNMENT_NOT_FOUND'
        )
          setRetryId(input.operationId);
        else setError(problem);
      }
    } finally {
      running.current = false;
      if (!scope.aborted) setBusy(false);
    }
  }
  return (
    <>
      <PageTitle title="Add missing barcode" />
      <section className="surface" style={{ padding: 24 }}>
        <p>Assign an unused barcode to a product that has no barcode.</p>
        <form
          className="form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label>
            Product ID
            <input
              aria-label="Product ID"
              inputMode="numeric"
              autoComplete="off"
              required
              maxLength={64}
              value={productId}
              disabled={busy || pending.length > 0 || Boolean(storageError)}
              onChange={(event) => setProductId(event.target.value)}
            />
          </label>
          <label>
            Scan or enter barcode
            <input
              aria-label="Scan or enter barcode"
              inputMode="numeric"
              autoComplete="off"
              required
              maxLength={64}
              value={barcode}
              disabled={busy || pending.length > 0 || Boolean(storageError)}
              onChange={(event) => setBarcode(event.target.value)}
            />
          </label>
          <button
            className="button primary"
            type="submit"
            disabled={!online || busy || pending.length > 0 || Boolean(storageError)}
          >
            Assign barcode
          </button>
        </form>
        {!online && <p role="status">Reconnect to assign or check a barcode.</p>}
        {storageError != null && <ErrorState error={storageError} />}{' '}
        {error != null && <ErrorState error={error} />}{' '}
        {receipt && (
          <section role={receipt.status === 'success' ? 'status' : 'alert'}>
            <p>{receipt.message}</p>
            <p className="muted">
              Receipt {receipt.id} · {receipt.createdAt}
              {receipt.auditId ? ' · Activity ' + receipt.auditId : ''}
            </p>
          </section>
        )}
      </section>
      {pending.length > 0 && (
        <section className="surface" style={{ padding: 24, marginTop: 16 }}>
          <h2>Saved assignments</h2>
          <p>
            Check the original action before assigning another barcode. This check never writes a
            barcode.
          </p>
          {pending.map((row) => (
            <div key={row.input.operationId}>
              <p>
                Product {row.input.productId} · Barcode {row.input.barcode}
              </p>
              <p className="muted">{row.input.operationId}</p>
              <button
                className="button secondary"
                disabled={!online || busy}
                onClick={() => void recover(row.input)}
              >
                Check original action
              </button>
              {retryId === row.input.operationId && (
                <>
                  <p>This original action is not saved yet. Retrying uses the same action ID.</p>
                  <button
                    className="button secondary"
                    disabled={!online || busy}
                    onClick={() => void submit(row.input)}
                  >
                    Retry original assignment
                  </button>
                </>
              )}
            </div>
          ))}
        </section>
      )}
    </>
  );
}
export function BarcodeAssignmentsPage({ user }: { user: Principal }) {
  if (user.userType !== 1 || ![1, 2, 3].includes(user.role))
    return <p role="alert">Barcode assignment requires an internal administrator.</p>;
  return <BarcodeForm key={user.id} user={user} />;
}
export default BarcodeAssignmentsPage;
