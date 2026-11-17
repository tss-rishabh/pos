import { useEffect, useRef, useState } from 'react';
import type { Principal } from '../../../api/types';
import { captureOperatorScope } from '../../../api/client';
import { orderImportActorScope } from './approval-journal';
import { readCorrection, type CorrectionReceipt, type CorrectionFence } from './correction-client';
import {
  clearCorrectionIntent,
  correctionJournalEvent,
  listCorrectionIntents,
  type CorrectionIntent,
} from './correction-journal';

export function SavedImportCorrections({
  user,
  online,
  onPendingChanged,
  onRecorded,
  onFenced,
}: {
  user: Principal;
  online: boolean;
  onPendingChanged: (value: boolean) => void;
  onRecorded: (receipt: CorrectionReceipt) => void;
  onFenced: (value: CorrectionFence) => void;
}) {
  const [intents, setIntents] = useState<CorrectionIntent[]>([]),
    [problem, setProblem] = useState('');
  const changed = useRef(onPendingChanged);
  changed.current = onPendingChanged;
  useEffect(() => {
    const synchronize = () => {
      try {
        const values = listCorrectionIntents(user.id);
        setIntents(values);
        changed.current(values.length > 0);
        setProblem('');
      } catch {
        setProblem(
          'Saved correction references are unreadable. Keep this device for manager recovery.',
        );
        changed.current(true);
      }
    };
    synchronize();
    window.addEventListener('storage', synchronize);
    window.addEventListener(correctionJournalEvent, synchronize);
    return () => {
      window.removeEventListener('storage', synchronize);
      window.removeEventListener(correctionJournalEvent, synchronize);
    };
  }, [user.id]);
  return (
    <>
      {problem && <p role="alert">{problem}</p>}
      {!!intents.length && (
        <section aria-label="Pending import corrections">
          <h2>Pending correction references</h2>
          <p>
            Only the original reference is recovered. No correction or financial operation is
            resent.
          </p>
          {intents.map((intent) => (
            <SavedCorrection
              key={JSON.stringify([orderImportActorScope(user), intent])}
              intent={intent}
              online={online}
              onRecorded={onRecorded}
              onFenced={onFenced}
            />
          ))}
        </section>
      )}
    </>
  );
}
function SavedCorrection({
  intent,
  online,
  onRecorded,
  onFenced,
}: {
  intent: CorrectionIntent;
  online: boolean;
  onRecorded: (value: CorrectionReceipt) => void;
  onFenced: (value: CorrectionFence) => void;
}) {
  const [busy, setBusy] = useState(false),
    [problem, setProblem] = useState(''),
    alive = useRef<AbortController | null>(null),
    locked = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    alive.current = controller;
    return () => controller.abort();
  }, []);
  async function recover() {
    if (!online || locked.current || !alive.current) return;
    const signal = AbortSignal.any([alive.current.signal, captureOperatorScope(intent.operatorId)]);
    locked.current = true;
    setBusy(true);
    setProblem('');
    try {
      const value = await readCorrection(
        intent.operatorId,
        { jobId: intent.jobId, operationId: intent.operationId },
        intent,
        signal,
      );
      signal.throwIfAborted();
      if (value.status === 'accepted') {
        onRecorded(value.receipt);
        await clearCorrectionIntent(intent, signal);
      } else {
        onFenced(value);
        setProblem(
          'This correction did not queue a successor. Use its fenced receipt to begin an explicit fresh review.',
        );
      }
    } catch {
      if (!signal.aborted)
        setProblem(
          'The original correction is unconfirmed. Keep its reference and check again; no replacement was sent.',
        );
    } finally {
      locked.current = false;
      if (!signal.aborted) setBusy(false);
    }
  }
  return (
    <div>
      <p>
        Original correction: <code>{intent.id}</code> · original import <code>{intent.jobId}</code>
      </p>
      {problem && <p role="alert">{problem}</p>}
      <button type="button" disabled={!online || busy} onClick={() => void recover()}>
        Recover original correction {intent.id}
      </button>
    </div>
  );
}
