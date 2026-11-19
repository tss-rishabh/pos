import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, History, RefreshCw, ShieldCheck } from 'lucide-react';
import { z } from 'zod';
import { params, request } from '../../api/client';
import type { Principal } from '../../api/types';
import { ErrorState, Loading, Metric, PageTitle } from '../../components/common';
import { confirmClose, pendingClose, submitClose } from './commands';
import {
  cents,
  closeSchema,
  decimal,
  differences,
  entriesSchema,
  initialEntries,
  reasons,
  stateSchema,
  type CloseState,
  type Entries,
} from './model';
import './style.css';
import { CloseReview, type ReviewedClose } from './close-review';

const labels: Record<(typeof reasons)[number], string> = {
  '': 'Choose a reason',
  MANUAL_BILL_MADE: 'Manual bill made',
  MANUAL_BILL_PUNCHED: 'Manual bill punched',
  CHANGE_SHORT: 'Change short',
  CHANGE_EXCESS: 'Change excess',
  JUMBLING: 'Payment mix-up',
};
export function DayClosePage({ user, storeId }: { user: Principal; storeId: string }) {
  const [search, setSearch] = useSearchParams();
  const requestedDates = search.getAll('date');
  const requested = z.iso.date().safeParse(requestedDates[0]);
  const invalidDate =
    requestedDates.length > 0 && (requestedDates.length !== 1 || !requested.success);
  const date = requested.success && requestedDates.length === 1 ? requested.data : '';
  const setDate = (value: string) => {
    const next = new URLSearchParams(search);
    if (value) next.set('date', value);
    else next.delete('date');
    setSearch(next);
  };
  const state = useQuery({
    queryKey: [user.id, 'finance-day-close', storeId, date],
    enabled: !!storeId && !invalidDate,
    queryFn: ({ signal }) => {
      if (invalidDate) throw new Error('Choose a valid business date.');
      return request(
        `/api/v1/stores/${storeId}/day-closes?${params({ date: date || undefined })}`,
        { operatorId: user.id, signal },
        stateSchema,
      );
    },
  });
  return (
    <>
      <PageTitle title="Day close">
        <button
          className="button secondary"
          disabled={invalidDate || !storeId}
          onClick={() => void state.refetch()}
        >
          <RefreshCw size={16} />
          Refresh figures
        </button>
      </PageTitle>
      <div className="finance-date">
        <label>
          Business date
          <input
            type="date"
            value={date || state.data?.close_date || ''}
            onChange={(event) => setDate(event.target.value)}
          />
        </label>
        <span>Cash collection and refunds are checked again when you submit.</span>
      </div>
      {invalidDate ? (
        <ErrorState error={new Error('Choose a valid business date.')} />
      ) : state.isPending ? (
        <Loading />
      ) : state.isError ? (
        <ErrorState error={state.error} retry={() => void state.refetch()} />
      ) : (
        <CloseForm
          key={`${user.id}:${storeId}:${state.data.close_date}:${state.data.close?.version || 0}`}
          user={user}
          storeId={storeId}
          state={state.data}
        />
      )}
    </>
  );
}
function CloseForm({
  user,
  storeId,
  state,
}: {
  user: Principal;
  storeId: string;
  state: CloseState;
}) {
  const client = useQueryClient(),
    [entries, setEntries] = useState<Entries>(() => initialEntries(state)),
    [notice, setNotice] = useState(''),
    [history, setHistory] = useState(false),
    [review, setReview] = useState<ReviewedClose | null>(null),
    [entryError, setEntryError] = useState<string | null>(null);
  const hasPending = () => {
    try {
      return Boolean(pendingClose(user.id, storeId, state.close_date));
    } catch {
      return true;
    }
  };
  const [pending, setPending] = useState(hasPending);
  const diff = differences(state, entries),
    allowed = cents(state.tolerance),
    cashReason = (diff.cash < 0n ? -diff.cash : diff.cash) > allowed,
    cardReason = (diff.card < 0n ? -diff.card : diff.card) > allowed;
  const update = <K extends keyof Entries>(key: K, value: Entries[K]) =>
    setEntries((current) => ({ ...current, [key]: value }));
  const refresh = () =>
    client.invalidateQueries({ queryKey: [user.id, 'finance-day-close', storeId] });
  const submit = useMutation({
    mutationFn: (reviewed: ReviewedClose) =>
      submitClose(user.id, storeId, reviewed.date, reviewed.expectedVersion, reviewed.entries),
    onSuccess: async (result) => {
      setPending(false);
      setReview(null);
      setNotice(`Day closed. Version ${result.version} is recorded.`);
      await refresh();
    },
    onError: () => {
      setReview(null);
      setPending(hasPending());
    },
  });
  const confirm = useMutation({
    mutationFn: () => confirmClose(user.id, storeId, state.close_date),
    onSuccess: async (result) => {
      setPending(false);
      if (result) setNotice(`Submission confirmed as version ${result.version}.`);
      await refresh();
    },
  });
  const versions = useQuery({
    queryKey: [user.id, 'finance-day-close-versions', storeId, state.close_date],
    enabled: history,
    queryFn: () =>
      request(
        `/api/v1/stores/${storeId}/day-closes/${state.close_date}/versions`,
        {},
        z.object({ data: z.array(closeSchema.nullable()), nextVersion: z.number().nullable() }),
      ),
  });
  const field = (key: keyof Entries, label: string) => (
    <label key={key}>
      {label}
      <input
        required
        inputMode="decimal"
        autoComplete="off"
        value={entries[key]}
        disabled={submit.isPending || !state.window.allowed}
        onChange={(event) => update(key, event.target.value)}
        aria-label={label}
      />
    </label>
  );
  return (
    <>
      <div className="finance-metrics">
        <Metric label="Orders collected" value={String(state.system.order_count)} />
        <Metric
          label="Cash collection"
          value={`₹${state.system.cash}`}
          note={`Cash refunds ₹${state.system.cash_refund}`}
        />
        <Metric
          label="Total online collection"
          value={`₹${state.system.total_online}`}
          note={`Card / UPI ₹${state.system.card_upi} · Other online ₹${state.system.online_other} · District ₹${state.system.district}`}
        />
        <Metric label="Total collection" value={`₹${state.system.total_collection}`} />
      </div>
      <div className="finance-window">
        <ShieldCheck size={18} />
        <div>
          <strong>
            {state.close?.status === 'STALE'
              ? 'Collection changed — review and close again'
              : state.close?.status === 'CLOSED'
                ? `Closed · version ${state.close.version}`
                : `${state.window.state.toLowerCase()} window`}
          </strong>
          <span>
            {state.window.message ||
              `Open ${state.window.opens_at} · closes ${state.window.closes_at}`}
          </span>
          {state.close && (
            <span>
              Signed at {state.close.closed_at} · attempt {state.close.version}
              {state.close.status === 'STALE' && (
                <>
                  {' '}
                  ·{' '}
                  {(
                    {
                      PAYMENT: 'a payment was confirmed',
                      MANUAL_PAID: 'a bill was marked paid',
                      REFUND: 'a cash refund was paid out',
                      DRIFT: 'the day’s figures changed',
                    } as Record<string, string>
                  )[state.close.stale_reason || ''] || 'the day’s figures changed'}
                  {state.close.stale_trigger_ref ? ` (order ${state.close.stale_trigger_ref})` : ''}
                  . Please count again and close the day once more.
                </>
              )}
            </span>
          )}
          {state.window.override && (
            <span>An elevated access override will be recorded for this submission.</span>
          )}
        </div>
      </div>
      {pending && (
        <div className="finance-pending" role="status">
          <span>
            A submission is awaiting confirmation. Check the result or retry with the exact same
            figures.
          </span>
          <button
            className="button secondary"
            disabled={confirm.isPending}
            onClick={() => confirm.mutate()}
          >
            Check submission
          </button>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {entryError && <ErrorState error={new Error(entryError)} />}
      {submit.isError && <ErrorState error={submit.error} />}{' '}
      {confirm.isError && <ErrorState error={confirm.error} />}{' '}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (submit.isPending || confirm.isPending || !state.window.allowed) return;
          const validated = entriesSchema.safeParse(entries);
          if (!validated.success) {
            setEntryError(
              validated.error.issues[0]?.message ||
                'Enter every amount, including 0 when there were none.',
            );
            return;
          }
          if (
            (cashReason && (!entries.cash_reason || !entries.cash_comment.trim())) ||
            (cardReason && (!entries.card_reason || !entries.card_comment.trim()))
          ) {
            setEntryError(
              'Add a reason and comment for each difference outside the allowed tolerance.',
            );
            return;
          }
          setEntryError(null);
          setReview({
            date: state.close_date,
            expectedVersion: state.close?.version || 0,
            revising: state.close?.status === 'CLOSED',
            entries: { ...validated.data },
            cashSystem: state.system.cash,
            onlineSystem: state.system.total_online,
            cashDifference: diff.cash,
            onlineDifference: diff.card,
            tolerance: allowed,
          });
        }}
      >
        <div className="finance-grid">
          {(['cash', 'card'] as const).map((kind) => (
            <section className="surface finance-section" key={kind}>
              <h2>{kind === 'cash' ? 'Cash reconciliation' : 'Card / UPI reconciliation'}</h2>
              {field(`${kind}_actual`, 'Actual ' + (kind === 'cash' ? 'cash' : 'card / UPI'))}
              {field(`${kind}_manual_punched`, 'Manual bills punched (' + kind + ')')}
              {field(`${kind}_manual_created`, 'Manual bills created (' + kind + ')')}
              <div className={`finance-difference ${diff[kind] === 0n ? 'balanced' : ''}`}>
                <span>Difference</span>
                <strong>₹{decimal(diff[kind])}</strong>
              </div>
              <label>
                Difference reason{' '}
                {(kind === 'cash' ? cashReason : cardReason) ? '(required)' : '(optional)'}
                <select
                  value={entries[`${kind}_reason`]}
                  onChange={(event) =>
                    update(`${kind}_reason`, event.target.value as Entries['cash_reason'])
                  }
                  disabled={!state.window.allowed}
                >
                  {reasons.map((reason) => (
                    <option key={reason} value={reason}>
                      {labels[reason]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Comment
                <textarea
                  value={entries[`${kind}_comment`]}
                  maxLength={255}
                  onChange={(event) => update(`${kind}_comment`, event.target.value)}
                  disabled={!state.window.allowed}
                />
              </label>
            </section>
          ))}
        </div>
        <section className="surface finance-banking">
          <div>
            <h2>Banking deposit</h2>
            <p>Record the amount banked for this business date.</p>
          </div>
          {field('banking_amount', 'Amount banked')}
          <button
            className="button primary"
            type="submit"
            disabled={!state.window.allowed || submit.isPending || confirm.isPending}
          >
            <Check size={16} />
            {submit.isPending ? 'Recording…' : state.close ? 'Submit revision' : 'Close this day'}
          </button>
        </section>
      </form>
      {review && (
        <CloseReview
          reviewed={review}
          submitting={submit.isPending}
          onCancel={() => setReview(null)}
          onConfirm={() => submit.mutate(review)}
        />
      )}
      <button className="button secondary" onClick={() => setHistory((value) => !value)}>
        <History size={16} />
        Version history
      </button>
      {history &&
        (versions.isPending ? (
          <Loading />
        ) : versions.isError ? (
          <ErrorState error={versions.error} />
        ) : (
          <div className="surface finance-history">
            <table>
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Status</th>
                  <th>Closed at</th>
                  <th>Cash difference</th>
                  <th>Card difference</th>
                  <th>Banked</th>
                </tr>
              </thead>
              <tbody>
                {versions.data?.data.map(
                  (row) =>
                    row && (
                      <tr key={row.version}>
                        <td>{row.version}</td>
                        <td>{row.status}</td>
                        <td>{row.closed_at}</td>
                        <td>₹{row.cash.difference}</td>
                        <td>₹{row.card.difference}</td>
                        <td>₹{row.banking_amount}</td>
                      </tr>
                    ),
                )}
              </tbody>
            </table>
            {versions.data?.nextVersion && <p>Showing the latest 30 versions.</p>}
          </div>
        ))}
    </>
  );
}
