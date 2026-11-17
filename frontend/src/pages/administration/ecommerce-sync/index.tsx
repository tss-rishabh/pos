import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import type { Principal } from '../../../api/types';
import { ApiError, captureOperatorScope, request } from '../../../api/client';
import { Empty, ErrorState, Loading } from '../../../components/common';
import { useOnline } from '../../../hooks/use-pos';
import { AdministrationEditor } from '../editor';
import { ecommerceSettingSchema } from '../settings-api';
import {
  ecommerceBase,
  ecommerceInput,
  ecommerceReceipt,
  matchingReceipt,
  readEcommerceReceipt,
  recordsSchema,
  synchronizationSchema,
} from './api';
import {
  actionId,
  readEcommerceJournal,
  saveEcommerceJournal,
  type EcommerceAction,
  type EcommerceJournal,
} from './journal';

export function EcommerceDeliveryAdministration(props: { user: Principal; storeId: string }) {
  if (!props.storeId) return <Empty title="Choose a store to manage e-commerce delivery" />;
  return <EcommerceEditor key={props.user.id + ':' + props.storeId} {...props} />;
}
function EcommerceEditor({ user, storeId }: { user: Principal; storeId: string }) {
  const online = useOnline(),
    client = useQueryClient(),
    abort = useRef(new AbortController()),
    [initial] = useState(() => {
      try {
        return { row: readEcommerceJournal(user.id, storeId), error: null };
      } catch (error) {
        return { row: null, error };
      }
    }),
    [journal, setJournal] = useState<EcommerceJournal | null>(initial.row),
    [error, setError] = useState<unknown>(initial.error),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [missing, setMissing] = useState(false),
    [editing, setEditing] = useState(false),
    [clock, setClock] = useState(Date.now()),
    [cursor, setCursor] = useState<string | undefined>();
  useEffect(() => () => abort.current.abort(), []);
  const scopeSignal = () => AbortSignal.any([abort.current.signal, captureOperatorScope(user.id)]);
  const settings = useQuery({
    queryKey: [user.id, 'administration', storeId, 'ecommerce-settings'],
    enabled: online,
    queryFn: ({ signal }) =>
      request(
        ecommerceBase(storeId) + '/ecommerce-settings',
        { operatorId: user.id, signal },
        ecommerceSettingSchema,
      ),
  });
  const syncId = journal?.syncId,
    status = useQuery({
      queryKey: [user.id, 'administration', storeId, 'ecommerce-sync', syncId],
      enabled: online && !!syncId,
      queryFn: ({ signal }) =>
        request(
          ecommerceBase(storeId) + '/ecommerce-inventory-syncs/' + syncId,
          { operatorId: user.id, signal },
          synchronizationSchema,
        ),
      refetchInterval: (query) =>
        query.state.data?.completed || query.state.data?.state === 'BLOCKED' ? false : 5000,
    }),
    records = useQuery({
      queryKey: [user.id, 'administration', storeId, 'ecommerce-sync-records', syncId, cursor],
      enabled: online && !!syncId,
      queryFn: ({ signal }) =>
        request(
          ecommerceBase(storeId) +
            '/ecommerce-inventory-syncs/' +
            syncId +
            '/records?limit=50' +
            (cursor ? '&after=' + cursor : ''),
          { operatorId: user.id, signal },
          recordsSchema,
        ),
      refetchInterval: status.data?.completed || status.data?.state === 'BLOCKED' ? false : 5000,
    });
  const lockedUntil = settings.data?.lockedUntil,
    coolingDown = !!lockedUntil && Date.parse(lockedUntil) > clock;
  useEffect(() => {
    if (!lockedUntil || Date.parse(lockedUntil) <= Date.now()) return;
    const timer = setTimeout(
      () => setClock(Date.now()),
      Math.min(3600000, Date.parse(lockedUntil) - Date.now() + 100),
    );
    return () => clearTimeout(timer);
  }, [lockedUntil]);
  function persist(row: EcommerceJournal) {
    scopeSignal().throwIfAborted();
    setJournal(saveEcommerceJournal(row));
  }
  async function adopt(result: z.infer<typeof ecommerceReceipt>, action: EcommerceAction) {
    scopeSignal().throwIfAborted();
    matchingReceipt(result, user.id, storeId, actionId(action));
    if (action.kind === 'cancel' && result.originalOperationId !== action.original.operationId)
      throw new Error(
        'The cancellation does not match the original request. Keep it for recovery.',
      );
    persist({
      ownerId: user.id,
      storeId,
      action: null,
      syncId: result.ecommerceSyncId || journal?.syncId || null,
    });
    setMessage(result.message);
    setMissing(false);
    setError(null);
    setEditing(false);
    setCursor(undefined);
    await client.invalidateQueries({ queryKey: [user.id, 'administration', storeId] });
  }
  async function dispatch(action: EcommerceAction) {
    const path =
      ecommerceBase(storeId) +
      (action.kind === 'change'
        ? '/ecommerce-settings'
        : action.kind === 'cancel'
          ? '/ecommerce-settings/cancellations'
          : '/ecommerce-inventory-syncs/' + action.syncId + '/retries');
    const body =
      action.kind === 'change'
        ? action.input
        : action.kind === 'cancel'
          ? { operationId: action.operationId, original: action.original }
          : { operationId: action.operationId };
    await adopt(
      await request(
        path,
        {
          operatorId: user.id,
          method: action.kind === 'change' ? 'PUT' : 'POST',
          body: JSON.stringify(body),
          signal: scopeSignal(),
        },
        ecommerceReceipt,
      ),
      action,
    );
  }
  async function run(task: () => Promise<void>) {
    if (busy || !online) return;
    setBusy(true);
    setError(null);
    setMissing(false);
    try {
      await task();
    } catch (failure) {
      if (!abort.current.signal.aborted) setError(failure);
    } finally {
      if (!abort.current.signal.aborted) setBusy(false);
    }
  }
  const pending = journal?.action;
  return (
    <>
      <div className="administration-heading administration-section-gap">
        <h2>E-commerce delivery</h2>
      </div>
      {message && (
        <p role="status" className="administration-status">
          {message}
        </p>
      )}
      {error !== null && <ErrorState error={error} />}
      <section className="surface">
        {settings.isPending ? (
          <Loading />
        ) : settings.isError ? (
          <ErrorState error={settings.error} />
        ) : (
          <>
            <div className="administration-heading">
              <div>
                <strong>{settings.data.name}</strong>
                <p>
                  {settings.data.active ? 'Open' : 'Closed'} · Stock threshold{' '}
                  {settings.data.threshold}
                </p>
              </div>
              <button
                className="button secondary"
                disabled={
                  !online || !journal || !!pending || busy || coolingDown || !settings.data.editable
                }
                onClick={() => setEditing(true)}
              >
                Edit e-commerce delivery
              </button>
            </div>
            {!settings.data.editable && (
              <p className="administration-notice">
                E-commerce updates require inventory synchronization to be enabled.
              </p>
            )}
            {coolingDown && (
              <p className="administration-notice">
                Another update is available after {new Date(lockedUntil!).toLocaleTimeString()}.
              </p>
            )}
          </>
        )}
        {pending && (
          <div className="administration-notice">
            <p>
              The original settings action needs recovery. No replacement request has been sent.
            </p>
            <code>{actionId(pending)}</code>
            <div className="administration-actions">
              <button
                className="button secondary"
                disabled={busy || !online}
                onClick={() =>
                  void run(async () => {
                    try {
                      await adopt(
                        await readEcommerceReceipt(
                          user.id,
                          storeId,
                          actionId(pending),
                          scopeSignal(),
                        ),
                        pending,
                      );
                    } catch (failure) {
                      if (
                        failure instanceof ApiError &&
                        failure.code === 'ECOMMERCE_OPERATION_NOT_FOUND'
                      )
                        setMissing(true);
                      throw failure;
                    }
                  })
                }
              >
                Check original settings action
              </button>
              {missing && (
                <button
                  className="button secondary"
                  disabled={busy || !online}
                  onClick={() => void run(() => dispatch(pending))}
                >
                  Retry original settings action
                </button>
              )}
              {pending.kind === 'change' && (
                <button
                  className="button secondary"
                  disabled={busy || !online}
                  onClick={() =>
                    void run(async () => {
                      const next: EcommerceAction = {
                        kind: 'cancel',
                        operationId: crypto.randomUUID(),
                        original: pending.input,
                      };
                      persist({
                        ownerId: user.id,
                        storeId,
                        syncId: journal?.syncId || null,
                        action: next,
                      });
                      await dispatch(next);
                    })
                  }
                >
                  Cancel if not accepted
                </button>
              )}
            </div>
          </div>
        )}
        {syncId && (
          <div className="administration-section-gap">
            <h3>Inventory synchronization</h3>
            <code>{syncId}</code>
            {status.isPending ? (
              <Loading />
            ) : status.isError ? (
              <ErrorState error={status.error} />
            ) : (
              <>
                <p role="status">
                  {status.data.completed
                    ? 'Inventory and full catalog synchronization completed.'
                    : status.data.state === 'BLOCKED'
                      ? 'Synchronization needs reconciliation.'
                      : status.data.state === 'FULL_SYNC'
                        ? 'Stock refreshed. Full catalog synchronization is still pending.'
                        : 'Stock synchronization is queued or processing.'}
                </p>
                <p>
                  {status.data.processedRows} / {status.data.selectedRows} selected associations
                  processed; {status.data.skippedRows} removed associations skipped.
                </p>
                {status.data.errorCode && (
                  <p className="administration-notice">Diagnostic: {status.data.errorCode}</p>
                )}
                {status.data.blockedRecord && (
                  <p className="administration-notice">
                    Reconcile product {status.data.blockedRecord.productId}, association{' '}
                    {status.data.blockedRecord.associationId} before resuming.
                  </p>
                )}
                {status.data.fullState === 'UNCERTAIN' && (
                  <p className="administration-notice">
                    The full-sync outcome is unknown. Recovery checks the original operation without
                    sending a replacement.
                  </p>
                )}
                <button
                  className="button secondary"
                  disabled={busy || !online}
                  onClick={() => {
                    void status.refetch();
                    void records.refetch();
                  }}
                >
                  Check synchronization status
                </button>
                {status.data.state === 'BLOCKED' && (
                  <button
                    className="button secondary"
                    disabled={busy || !online || !!pending || !journal}
                    onClick={() =>
                      void run(async () => {
                        const action: EcommerceAction = {
                          kind: 'retry',
                          operationId: crypto.randomUUID(),
                          syncId,
                        };
                        persist({ ownerId: user.id, storeId, syncId, action });
                        await dispatch(action);
                      })
                    }
                  >
                    Resume after reconciliation
                  </button>
                )}
              </>
            )}
            {records.isError ? (
              <ErrorState error={records.error} />
            ) : (
              !!records.data?.data.length && (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Product ID</th>
                        <th>Selected stock</th>
                        <th>Locked stock</th>
                        <th>State</th>
                      </tr>
                    </thead>
                    <tbody>
                      {records.data.data.map((row) => (
                        <tr key={row.associationId}>
                          <td>{row.productId}</td>
                          <td>{row.selectedStock}</td>
                          <td>{row.currentStock ?? '—'}</td>
                          <td>{row.state}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="administration-actions">
                    {cursor && (
                      <button className="button secondary" onClick={() => setCursor(undefined)}>
                        First records
                      </button>
                    )}
                    {records.data.nextCursor && (
                      <button
                        className="button secondary"
                        onClick={() => setCursor(records.data!.nextCursor!)}
                      >
                        Next records
                      </button>
                    )}
                  </div>
                </div>
              )
            )}
          </div>
        )}
      </section>
      {editing && settings.data && (
        <AdministrationEditor
          title="Edit e-commerce delivery"
          fields={[
            {
              name: 'threshold',
              label: 'Delivery stock threshold',
              kind: 'number',
              required: true,
            },
            {
              name: 'active',
              label: 'Delivery availability',
              kind: 'select',
              required: true,
              options: [
                { value: 'true', label: 'Open' },
                { value: 'false', label: 'Closed' },
              ],
            },
          ]}
          initialValues={{
            threshold: String(settings.data.threshold),
            active: String(settings.data.active),
          }}
          onClose={() => setEditing(false)}
          onSave={async (values) => {
            if (!journal || journal.action)
              throw new Error('Recover the original settings action first.');
            const input = ecommerceInput.parse({
                operationId: crypto.randomUUID(),
                expectedVersion: settings.data.version,
                threshold: Number(values.threshold),
                active: values.active === 'true',
              }),
              action: EcommerceAction = { kind: 'change', input };
            persist({ ...journal, action });
            setEditing(false);
            await run(() => dispatch(action));
          }}
        />
      )}
    </>
  );
}
