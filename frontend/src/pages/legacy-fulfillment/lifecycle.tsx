import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { captureOperatorScope, request } from '../../api/client';
import type { Principal } from '../../api/types';
import { ErrorState, Loading } from '../../components/common';
import { useOnline } from '../../hooks/use-pos';
import {
  deliveryCapabilities,
  deliveryReceipt,
  type DeliveryAction,
  type DeliveryReceipt,
} from './lifecycle-contracts';
import {
  reconcileDeliveryCommand,
  recoverDeliveryCommand,
  submitDeliveryCommand,
} from './lifecycle-client';

const labels: Record<DeliveryAction, string> = {
    create: 'Accept delivery',
    pass: 'Pass to backup stores',
    convert: 'Convert to online',
    cancel: 'Cancel delivery',
  },
  descriptions: Record<DeliveryAction, string> = {
    create: 'Request a courier and settle this store’s reserved inventory.',
    pass: 'Release this store’s reservation and offer the order to its aligned backup stores. Without an eligible backup, the order moves to online conversion.',
    convert:
      'Create the online replacement for this returning delivery and record its charge refund.',
    cancel:
      'Cancel the selected local-delivery items and request their refund. Other online items in a split order remain separate.',
  },
  pending = (receipt: DeliveryReceipt) => !['completed', 'rejected'].includes(receipt.phase),
  outcome: Record<DeliveryReceipt['outcome'], string> = {
    pending: 'In progress',
    created: 'Courier created',
    transferred: 'Passed to backup stores',
    converted: 'Converted to online',
    cancelled: 'Cancellation recorded',
    'arrival-scheduled': 'Arrival recorded',
    'already-recorded': 'Previously recorded',
    rejected: 'Request rejected',
  },
  phase: Record<DeliveryReceipt['phase'], string> = {
    queued: 'Queued',
    scheduled: 'Scheduled',
    sending: 'Waiting for the provider',
    uncertain: 'Provider outcome unconfirmed',
    applying: 'Recording the confirmed result',
    completed: 'Completed',
    'reconciliation-required': 'Review required',
    rejected: 'Rejected',
  };
export function DeliveryLifecyclePanel({
  user,
  storeId,
  orderId,
}: {
  user: Principal;
  storeId: string;
  orderId: string;
}) {
  const online = useOnline(),
    client = useQueryClient(),
    owner = JSON.stringify([
      user.id,
      user.role,
      user.userType,
      [...new Set(user.storeIds)].sort(),
      storeId,
      orderId,
    ]),
    prefix = [user.id, 'local-delivery-lifecycle', owner],
    base = `/api/v1/stores/${storeId}/local-deliveries/orders/${orderId}`,
    controller = useRef<AbortController | null>(null),
    recoveryOperation = useRef<{
      commandId: string;
      expectedVersion: number;
      reason: string;
    } | null>(null),
    [choice, setChoice] = useState<DeliveryAction | null>(null),
    [reason, setReason] = useState(''),
    [category, setCategory] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [selectedId, setSelectedId] = useState(''),
    [recoveryReason, setRecoveryReason] = useState(''),
    [notice, setNotice] = useState('');
  useEffect(() => {
    const current = new AbortController();
    controller.current = current;
    return () => {
      current.abort();
      if (controller.current === current) controller.current = null;
    };
  }, [owner]);
  function signal() {
    const local = controller.current?.signal;
    if (!local || local.aborted)
      throw new DOMException('The delivery workspace changed.', 'AbortError');
    return AbortSignal.any([captureOperatorScope(user.id), local]);
  }
  const capabilities = useQuery({
      queryKey: [...prefix, 'capabilities'],
      enabled: online,
      retry: false,
      gcTime: 0,
      queryFn: ({ signal }) =>
        request(
          base + '/capabilities',
          { operatorId: user.id, signal, cache: 'no-store' },
          deliveryCapabilities,
        ),
      refetchInterval: (query) => (query.state.data?.workflowPending ? 5000 : false),
    }),
    history = useQuery({
      queryKey: [...prefix, 'commands'],
      enabled: online,
      retry: false,
      gcTime: 0,
      queryFn: ({ signal }) =>
        request(
          base + '/commands',
          { operatorId: user.id, signal, cache: 'no-store' },
          z.object({ data: z.array(deliveryReceipt).max(20) }).strict(),
        ),
      refetchInterval: (query) => (query.state.data?.data.some(pending) ? 5000 : false),
    }),
    selected = useQuery({
      queryKey: [...prefix, 'receipt', selectedId],
      enabled: online && !!selectedId,
      retry: false,
      gcTime: 0,
      queryFn: ({ signal }) =>
        request(
          '/api/v1/local-delivery-commands/' + selectedId,
          { operatorId: user.id, signal, cache: 'no-store' },
          deliveryReceipt,
        ),
      refetchInterval: (query) =>
        query.state.data &&
        (pending(query.state.data) || query.state.data.integrationState === 'pending')
          ? 5000
          : false,
    }),
    refresh = () => client.invalidateQueries({ queryKey: prefix }),
    submit = useMutation({
      mutationFn: async (kind: DeliveryAction) => {
        if (!online) throw new Error('Reconnect before recording a delivery action.');
        return submitDeliveryCommand(user.id, storeId, orderId, kind, reason, category, signal());
      },
      onSuccess: async (receipt) => {
        setSelectedId(receipt.commandId);
        setChoice(null);
        setConfirmed(false);
        setNotice(
          'Delivery request recorded. Check the command outcome before taking another action.',
        );
        await refresh();
      },
    }),
    recover = useMutation({
      mutationFn: async () => {
        const captured = signal();
        for (const kind of ['create', 'pass', 'convert', 'cancel'] as const) {
          const receipt = await recoverDeliveryCommand(user.id, storeId, orderId, kind, captured);
          captured.throwIfAborted();
          if (receipt) setSelectedId(receipt.commandId);
        }
        return true;
      },
      onSuccess: async () => {
        setNotice(
          'Saved request receipts checked. Unconfirmed requests keep their original command ID.',
        );
        await refresh();
      },
    }),
    reconcile = useMutation({
      mutationFn: async () => {
        const captured = signal(),
          receipt = selected.data;
        if (!receipt) throw new Error('Select a command receipt first.');
        const saved = recoveryOperation.current;
        if (saved && (saved.expectedVersion !== receipt.version || saved.reason !== recoveryReason))
          throw new Error('Check the receipt of the previous review before changing its reason.');
        const operation = saved || {
          commandId: crypto.randomUUID(),
          expectedVersion: receipt.version,
          reason: recoveryReason,
        };
        recoveryOperation.current = operation;
        return reconcileDeliveryCommand(user.id, receipt, recoveryReason, operation, captured);
      },
      onSuccess: async (receipt) => {
        recoveryOperation.current = null;
        setSelectedId(receipt.commandId);
        setRecoveryReason('');
        setNotice(
          'Provider evidence checked. A still-unconfirmed action remains frozen for review.',
        );
        await refresh();
      },
    });
  const value = capabilities.data,
    receipt =
      selected.data ||
      history.data?.data.find((row) => row.commandId === selectedId) ||
      value?.activeCommand,
    busy = submit.isPending || recover.isPending || reconcile.isPending,
    allowed: Record<DeliveryAction, boolean> = {
      create: value?.canCreate === true,
      pass: value?.canPass === true,
      convert: value?.canConvert === true,
      cancel: value?.canCancel === true,
    },
    date = (milliseconds: number) =>
      new Intl.DateTimeFormat('en-IN', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: value?.timeZone || 'Asia/Kolkata',
      }).format(milliseconds);
  return (
    <section className="surface local-delivery-lifecycle" aria-label="Delivery actions">
      <div className="page-heading">
        <div>
          <h2>Delivery actions</h2>
          <p>Accept, hand off or review the current delivery.</p>
        </div>
        <button
          className="button secondary"
          disabled={!online || busy}
          onClick={() => void refresh()}
        >
          Refresh actions
        </button>
      </div>
      {!online && <p role="status">Reconnect to send delivery commands or check their outcome.</p>}
      {notice && <p role="status">{notice}</p>}
      {capabilities.isError ? (
        <ErrorState error={capabilities.error} retry={() => void capabilities.refetch()} />
      ) : capabilities.isPending && online ? (
        <Loading />
      ) : (
        value && (
          <>
            {!value.checkedIn && (
              <p role="status">Check in to this store before sending a delivery command.</p>
            )}
            {!value.contractReady && (
              <p role="status">
                Delivery processing is not ready for this store. Ask an administrator to check its
                setup.
              </p>
            )}
            {!value.reservationsVerified && !value.workflowPending && (
              <p>Existing reservations need review before acceptance or transfer.</p>
            )}
            {value.workflowPending && (
              <p role="status">
                A delivery command is in progress. Check its receipt before starting another action.
              </p>
            )}
            <div className="local-delivery-actions">
              {(['create', 'pass', 'convert', 'cancel'] as const).map((kind) => (
                <button
                  key={kind}
                  className={'button ' + (kind === 'cancel' ? 'danger' : 'secondary')}
                  disabled={!online || busy || !allowed[kind]}
                  onClick={() => {
                    setChoice(kind);
                    setConfirmed(false);
                  }}
                >
                  {labels[kind]}
                </button>
              ))}
            </div>
          </>
        )
      )}
      {choice && (
        <form
          className="local-delivery-command-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (confirmed && allowed[choice]) submit.mutate(choice);
          }}
        >
          <h3>{labels[choice]}</h3>
          <p>{descriptions[choice]}</p>
          <label className="local-delivery-note">
            Reason
            <input
              aria-label="Delivery action reason"
              value={reason}
              maxLength={choice === 'cancel' ? 200 : 255}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          {choice === 'pass' && (
            <label className="local-delivery-note">
              Reason category
              <input
                aria-label="Delivery reason category"
                value={category}
                maxLength={255}
                onChange={(event) => setCategory(event.target.value)}
              />
            </label>
          )}
          <label className="local-delivery-confirmation">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I checked this order and confirm this action.
          </label>
          <div className="local-delivery-actions">
            <button
              type="submit"
              className="button primary"
              disabled={!online || busy || !confirmed || !allowed[choice]}
            >
              Confirm {labels[choice].toLowerCase()}
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => setChoice(null)}
            >
              Keep current delivery
            </button>
          </div>
        </form>
      )}
      {submit.error && <ErrorState error={submit.error} />}{' '}
      {recover.error && <ErrorState error={recover.error} />}
      <button
        className="button secondary"
        disabled={!online || busy}
        onClick={() => recover.mutate()}
      >
        Check saved delivery requests
      </button>
      {history.isError && <ErrorState error={history.error} retry={() => void history.refetch()} />}
      {!!history.data?.data.length && (
        <div className="table-wrap">
          <table aria-label="Delivery command history">
            <thead>
              <tr>
                <th>Action</th>
                <th>Outcome</th>
                <th>Recorded</th>
                <th>Receipt</th>
              </tr>
            </thead>
            <tbody>
              {[...history.data.data]
                .sort((a, b) => b.createdAt - a.createdAt)
                .map((row) => (
                  <tr key={row.commandId}>
                    <td>
                      {row.action === 'arrival'
                        ? 'Arrival'
                        : row.action === 'observer-cancel'
                          ? 'Courier cancellation'
                          : labels[row.action]}
                    </td>
                    <td>
                      {outcome[row.outcome]} · {phase[row.phase]}
                    </td>
                    <td>{date(row.createdAt)}</td>
                    <td>
                      <button
                        className="button secondary"
                        onClick={() => {
                          setSelectedId(row.commandId);
                          recoveryOperation.current = null;
                        }}
                        disabled={busy}
                      >
                        View receipt {row.commandId.slice(0, 8)}
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
      {selected.isError && (
        <ErrorState error={selected.error} retry={() => void selected.refetch()} />
      )}
      {receipt && (
        <aside className="local-delivery-receipt" aria-label="Delivery command receipt">
          <h3>{outcome[receipt.outcome]}</h3>
          <p>
            {phase[receipt.phase]} · Updated {date(receipt.updatedAt)}
          </p>
          <p>
            Command {receipt.commandId} · Version {receipt.version} · Recorded by{' '}
            {receipt.actorId === 'service' ? 'Delivery service' : `operator ${receipt.actorId}`}
          </p>
          {receipt.courierOrderId && <p>Courier order {receipt.courierOrderId}</p>}
          {receipt.newOrderId && <p>Online replacement order {receipt.newOrderId}</p>}
          {receipt.nextJobAt && <p>Next scheduled check {date(receipt.nextJobAt)}</p>}
          {receipt.integrationState === 'uncertain' && (
            <p role="status">
              An external delivery result is unconfirmed. A manager can check provider evidence;
              repeating the action is blocked.
            </p>
          )}
          {receipt.integrationState === 'pending' && (
            <p role="status">Some delivery communications are pending.</p>
          )}
          {['uncertain', 'reconciliation-required'].includes(receipt.phase) && (
            <p role="alert">
              This command needs review. Its inventory and refund effects stay protected until the
              outcome is confirmed.
            </p>
          )}
          {user.role <= 4 &&
            value?.checkedIn &&
            (['uncertain', 'reconciliation-required'].includes(receipt.phase) ||
              receipt.integrationState === 'uncertain' ||
              receipt.integrationState === 'pending') && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (selected.data) reconcile.mutate();
                }}
              >
                <label className="local-delivery-note">
                  Review reason
                  <input
                    aria-label="Delivery review reason"
                    value={recoveryReason}
                    maxLength={200}
                    required
                    onChange={(event) => setRecoveryReason(event.target.value)}
                  />
                </label>
                <button
                  className="button secondary"
                  disabled={!online || busy || !selected.data || !recoveryReason.trim()}
                >
                  Check provider evidence
                </button>
                <p>This records an audited review. An unknown provider outcome remains blocked.</p>
              </form>
            )}
          {reconcile.error && <ErrorState error={reconcile.error} />}
        </aside>
      )}
    </section>
  );
}
