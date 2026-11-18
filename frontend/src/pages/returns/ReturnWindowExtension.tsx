import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { ErrorState, Loading } from '../../components/common';
import { readReturnWindow, setReturnWindow, type ReturnWindowScope } from './client';

export function ReturnWindowExtension({
  scope,
  online,
  busy,
  run,
}: {
  scope: ReturnWindowScope;
  online: boolean;
  busy: boolean;
  run: (work: () => Promise<void>) => Promise<void>;
}) {
  const client = useQueryClient(),
    mounted = useRef(true);
  const [editing, setEditing] = useState(false),
    [date, setDate] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [problem, setProblem] = useState<unknown>(null),
    [saved, setSaved] = useState(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const key = [
      scope.operatorId,
      'return-window',
      scope.storeId,
      scope.counterId,
      scope.orderId,
      scope.lineId,
      scope.productId,
      scope.verificationId,
    ],
    current = useQuery({
      queryKey: key,
      queryFn: () => readReturnWindow(scope),
      enabled: online,
      retry: false,
    });
  async function refresh() {
    setProblem(null);
    try {
      const value = await readReturnWindow(scope);
      if (!mounted.current) return;
      client.setQueryData(key, value);
      setUncertain(false);
      setConfirmed(false);
      setSaved(false);
    } catch (error) {
      if (mounted.current) setProblem(error);
    }
  }
  async function save() {
    if (!current.data || !date || !confirmed || uncertain || !online) return;
    const revision = current.data.revision;
    setProblem(null);
    setSaved(false);
    try {
      const value = await setReturnWindow(scope, date, revision);
      if (!mounted.current) return;
      client.setQueryData(key, value);
      setSaved(true);
      setEditing(false);
      setConfirmed(false);
      setDate('');
    } catch (error) {
      if (!mounted.current) return;
      setProblem(error);
      if (
        !(error instanceof ApiError) ||
        error.status >= 500 ||
        error.code === 'RETURN_EXTENSION_CHANGED'
      )
        setUncertain(true);
    }
  }
  return (
    <section aria-label="Manager return date" className="return-window-extension">
      <h4>Return date</h4>
      {current.isPending && online ? (
        <Loading />
      ) : current.isError ? (
        <ErrorState error={current.error} />
      ) : (
        current.data && (
          <>
            <p>
              {current.data.active && current.data.date
                ? `Recorded through ${current.data.date}, 23:59:59.`
                : 'No active extended date is recorded.'}
            </p>
            <p className="caption">
              Other return and exchange eligibility checks still apply. This action does not refund
              money or accept an item.
            </p>
            {saved && <p role="status">Return date saved.</p>}
            {!editing && (current.data.windowClosed || current.data.date !== null) && (
              <button
                type="button"
                className="button secondary"
                disabled={!online || busy || uncertain}
                onClick={() => {
                  setDate(current.data?.date || current.data?.today || '');
                  setConfirmed(false);
                  setEditing(true);
                  setSaved(false);
                }}
              >
                {current.data.date ? 'Change return date' : 'Extend return date'}
              </button>
            )}
            {editing && (
              <>
                <label>
                  Return through date
                  <input
                    type="date"
                    min={current.data.today}
                    max="9999-12-31"
                    value={date}
                    disabled={!online || busy || uncertain}
                    onChange={(event) => {
                      setDate(event.target.value);
                      setConfirmed(false);
                    }}
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={!online || busy || uncertain}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  I request this return date for the selected item.
                </label>
                <div className="button-row">
                  <button
                    type="button"
                    className="button primary"
                    disabled={!online || busy || uncertain || !confirmed || !date}
                    onClick={() => void run(save)}
                  >
                    Save return date
                  </button>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy}
                    onClick={() => {
                      setEditing(false);
                      setDate('');
                      setConfirmed(false);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}
          </>
        )
      )}
      {uncertain && (
        <p role="status">
          The save outcome is unconfirmed. Read the recorded date before making another change.
        </p>
      )}
      <button
        type="button"
        className="text-button"
        disabled={!online || busy}
        onClick={() => void run(refresh)}
      >
        Read recorded date
      </button>
      {problem !== null && <ErrorState error={problem} />}
    </section>
  );
}
