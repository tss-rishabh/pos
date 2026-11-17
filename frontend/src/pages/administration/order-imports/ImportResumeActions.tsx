import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, captureOperatorScope } from '../../../api/client';
import { readOrderImportResumption, resumeOrderImport, type OrderImportJob } from './client';
import {
  clearImportResumption,
  readImportResumption,
  saveImportResumption,
  type ImportResumptionIntent,
} from './resumption-journal';

export function ImportResumeActions({
  operatorId,
  job,
  online,
  enabled,
  onAccepted,
  onPendingChanged,
}: {
  operatorId: string;
  job: OrderImportJob;
  online: boolean;
  enabled: boolean;
  onAccepted: () => Promise<void>;
  onPendingChanged: (pending: boolean) => void;
}) {
  const [initial] = useState(() => {
    try {
      return { intent: readImportResumption(operatorId, job.id), error: '' };
    } catch {
      return {
        intent: null,
        error:
          'The saved resume reference is unreadable. Keep this device for administrator recovery.',
      };
    }
  });
  const [intent, setIntent] = useState<ImportResumptionIntent | null>(initial.intent),
    [busy, setBusy] = useState(false),
    [problem, setProblem] = useState(initial.error),
    [notRecorded, setNotRecorded] = useState(false),
    [acceptedView, setAcceptedView] = useState<string | null>(null);
  const locked = useRef(false),
    mounted = useRef(true),
    accepted = useRef(onAccepted),
    view = JSON.stringify([
      job.state,
      job.updatedAt,
      job.importedOrders,
      job.cancelledOrders,
      job.failedOrders,
    ]);
  useEffect(() => {
    accepted.current = onAccepted;
  }, [onAccepted]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    onPendingChanged(Boolean(intent || busy || initial.error));
    return () => onPendingChanged(false);
  }, [intent, busy, initial.error, onPendingChanged]);
  const confirm = useCallback(
    async (pending: ImportResumptionIntent, signal: AbortSignal) => {
      signal.throwIfAborted();
      if (!mounted.current) return;
      clearImportResumption(pending);
      setIntent(null);
      setNotRecorded(false);
      setAcceptedView(view);
      await accepted.current();
    },
    [view],
  );
  const recover = useCallback(async () => {
    if (!online || !intent || locked.current || initial.error) return;
    const signal = captureOperatorScope(operatorId);
    locked.current = true;
    setBusy(true);
    setProblem('');
    setNotRecorded(false);
    try {
      await readOrderImportResumption(operatorId, job.id, intent.operationId);
      signal.throwIfAborted();
      await confirm(intent, signal);
    } catch (error: unknown) {
      if (mounted.current && !signal.aborted) {
        setNotRecorded(
          error instanceof ApiError && error.code === 'ORDER_IMPORT_RESUMPTION_NOT_FOUND',
        );
        setProblem(
          'The original resume request is unconfirmed. Refresh its receipt before continuing.',
        );
      }
    } finally {
      locked.current = false;
      if (mounted.current && !signal.aborted) setBusy(false);
    }
  }, [online, intent, initial.error, operatorId, job.id, confirm]);
  useEffect(() => {
    void recover();
  }, [recover]);
  async function send() {
    if (!online || !enabled || locked.current || initial.error || (intent && !notRecorded)) return;
    const signal = captureOperatorScope(operatorId);
    locked.current = true;
    setBusy(true);
    setProblem('');
    setNotRecorded(false);
    try {
      const pending = saveImportResumption(
        intent ?? {
          version: 1,
          operatorId,
          jobId: job.id,
          operationId: crypto.randomUUID(),
        },
      );
      signal.throwIfAborted();
      setIntent(pending);
      await resumeOrderImport(operatorId, job.id, pending.operationId);
      signal.throwIfAborted();
      await confirm(pending, signal);
    } catch (error: unknown) {
      if (mounted.current && !signal.aborted)
        setProblem(
          error instanceof Error ? error.message : 'The resume request could not be confirmed.',
        );
    } finally {
      locked.current = false;
      if (mounted.current && !signal.aborted) setBusy(false);
    }
  }
  const preparation =
    job.errorCode === 'ORDER_IMPORT_PREPARATION_RETRY_REQUIRED' ||
    job.errorCode === 'ORDER_IMPORT_PREPARATION_RELEASE_REQUIRED';
  const available =
    job.state === 'BLOCKED' && (job.errorCode === 'ORDER_IMPORT_ACCESS_CHANGED' || preparation);
  if (!available && !intent && !problem && acceptedView === null) return null;
  return (
    <section aria-label="Resume historical import">
      {problem && <p role="alert">{problem}</p>}
      {acceptedView !== null && (
        <p role="status">
          The original resume request was accepted. Refresh the import to review its current
          progress.
        </p>
      )}
      {intent ? (
        <>
          <p role="status">
            Saved resume reference: <code>{intent.operationId}</code>. The original file and
            completed orders will be retained.
          </p>
          <button
            type="button"
            disabled={busy || !online || Boolean(initial.error)}
            onClick={() => void recover()}
          >
            Refresh resume receipt
          </button>
          {notRecorded && (
            <button
              type="button"
              disabled={busy || !online || !enabled || Boolean(initial.error)}
              onClick={() => void send()}
            >
              Retry the same resume request
            </button>
          )}
        </>
      ) : (
        available && (
          <>
            <p>
              {preparation
                ? 'Preparation stopped before an order was sent. After its configuration or reservation is repaired, explicitly resume this original import.'
                : 'After access is restored, resume the unsent orders in this original import.'}
            </p>
            <button
              type="button"
              disabled={
                busy || !online || !enabled || Boolean(initial.error) || acceptedView === view
              }
              onClick={() => void send()}
            >
              Resume unsent orders
            </button>
          </>
        )
      )}
    </section>
  );
}
