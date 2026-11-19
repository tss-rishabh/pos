import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { Principal } from '../../../api/types';
import { request } from '../../../api/client';
import { Empty, ErrorState, Loading, PageTitle } from '../../../components/common';
import { useOnline } from '../../../hooks/use-pos';
import { historyCapabilities, historyResult, historySelection, type HistoryModel } from './api';
import '../styles.css';

interface Filters {
  model: HistoryModel;
  objectId: string;
  from: string | null;
  to: string | null;
  page: string;
}
const endpoint = '/api/v1/admin/model-history';
export function AdministrationHistoryPage({ user }: { user: Principal }) {
  const location = useLocation(),
    parsed = historySelection.safeParse(location.state);
  return (
    <HistoryScreen
      key={user.id + ':' + location.key}
      user={user}
      initial={parsed.success ? parsed.data : { model: 'operator', objectId: user.id }}
    />
  );
}
function HistoryScreen({
  user,
  initial,
}: {
  user: Principal;
  initial: { model: HistoryModel; objectId: string };
}) {
  const online = useOnline(),
    allowed = user.role === 1 && user.userType === 1;
  const [model, setModel] = useState(initial.model),
    [objectId, setObjectId] = useState(initial.objectId),
    [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [page, setPage] = useState('1'),
    [error, setError] = useState('');
  const [filters, setFilters] = useState<Filters>({ ...initial, from: null, to: null, page: '1' });
  const meta = useQuery({
    queryKey: [user.id, 'administration-history', 'capabilities'],
    enabled: allowed && online,
    gcTime: 0,
    retry: false,
    queryFn: ({ signal }) =>
      request(
        endpoint + '/capabilities',
        { operatorId: user.id, signal, cache: 'no-store' },
        historyCapabilities,
      ),
  });
  const available = meta.data?.models.some((value) => value.id === filters.model) === true;
  const rows = useQuery({
    queryKey: [user.id, 'administration-history', filters],
    enabled: allowed && online && available,
    gcTime: 0,
    retry: false,
    queryFn: ({ signal }) =>
      request(
        endpoint + '/search',
        {
          operatorId: user.id,
          signal,
          cache: 'no-store',
          method: 'POST',
          body: JSON.stringify(filters),
        },
        historyResult,
      ),
  });
  if (!allowed) return <Empty title="Internal model administration access is required" />;
  function apply(dates: { from: string | null; to: string | null }) {
    if (!meta.data?.models.some((value) => value.id === model)) {
      setError('Choose a model you can view.');
      return;
    }
    if (!objectId || !/^[1-9]\d{0,18}$/.test(objectId)) {
      setError('Enter the existing object ID.');
      return;
    }
    if (
      Boolean(dates.from) !== Boolean(dates.to) ||
      (dates.from && dates.to && dates.from > dates.to)
    ) {
      setError('Choose both dates in order, or all history.');
      return;
    }
    setError('');
    setPage('1');
    const next = { model, objectId, ...dates, page: '1' };
    if (JSON.stringify(next) === JSON.stringify(filters)) void rows.refetch();
    setFilters(next);
  }
  return (
    <>
      <PageTitle title="Model history" />
      <section className="surface permission-activity-filters">
        <p>
          View changes made through the legacy administration site. Each page contains up to100
          changes, oldest first.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            apply({ from: from || null, to: to || null });
          }}
        >
          <div className="administration-fields">
            <label>
              Model
              <select
                aria-label="History model"
                value={model}
                onChange={(event) => setModel(event.target.value as HistoryModel)}
              >
                {(
                  meta.data?.models || [
                    { id: 'operator', label: 'Operator' },
                    { id: 'store', label: 'Store' },
                  ]
                ).map((value) => (
                  <option key={value.id} value={value.id}>
                    {value.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Object ID
              <input
                aria-label="History object ID"
                maxLength={36}
                autoComplete="off"
                value={objectId}
                onChange={(event) => setObjectId(event.target.value)}
              />
            </label>
            <label>
              From date
              <input
                aria-label="Model history from date"
                type="date"
                min="1000-01-01"
                max="9999-12-31"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
              />
            </label>
            <label>
              To date
              <input
                aria-label="Model history to date"
                type="date"
                min="1000-01-01"
                max="9999-12-31"
                value={to}
                onChange={(event) => setTo(event.target.value)}
              />
            </label>
          </div>
          <div className="administration-actions">
            <button className="button primary" disabled={!online || !meta.data || rows.isFetching}>
              View history
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={!online || !meta.data || rows.isFetching}
              onClick={() => {
                const today = meta.data!.today;
                setFrom(today);
                setTo(today);
                apply({ from: today, to: today });
              }}
            >
              Today
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={!online || !meta.data || rows.isFetching}
              onClick={() => {
                setFrom('');
                setTo('');
                apply({ from: null, to: null });
              }}
            >
              All history
            </button>
          </div>
        </form>
        {error && <p role="alert">{error}</p>}
        {meta.data && (
          <p>
            Dates use {meta.data.timeZone} wall time. All history and earlier dates use the
            historical reader.
          </p>
        )}
        {meta.isError && <ErrorState error={meta.error} retry={() => void meta.refetch()} />}
      </section>
      <section className="surface administration-section-gap">
        {!online ? (
          <Empty title="Reconnect to view model history" />
        ) : meta.isPending ? (
          <Loading />
        ) : meta.isError ? null : !meta.data.models.length ? (
          <Empty title="Model view permission is required" />
        ) : !available ? (
          <Empty title="Choose a model you can view" />
        ) : rows.isPending ? (
          <Loading />
        ) : rows.isError ? (
          <ErrorState error={rows.error} retry={() => void rows.refetch()} />
        ) : (
          <>
            <h2>{rows.data.resource.label}</h2>
            <p role="status">
              {rows.data.total} changes. Page {rows.data.page} of {rows.data.pages}.
            </p>
            {rows.data.notice && <p>{rows.data.notice}</p>}
            <div className="table-wrap">
              <table className="administration-table">
                <thead>
                  <tr>
                    <th>Date/time</th>
                    <th>User</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.data.data.map((value) => (
                    <tr key={value.id}>
                      <td>
                        <time dateTime={value.actionTime.replace(' ', 'T')}>
                          {value.actionTimeLabel}
                        </time>
                      </td>
                      <td style={{ whiteSpace: 'pre-wrap' }}>{value.actor}</td>
                      <td style={{ whiteSpace: 'pre-wrap' }}>{value.action}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!rows.data.data.length && !rows.data.notice && (
              <Empty title="No administration changes recorded">
                This object may not have been added or changed through the administration site.
              </Empty>
            )}
            <div className="administration-actions">
              <button
                className="button secondary"
                disabled={rows.isFetching || rows.data.page === '1'}
                onClick={() => {
                  const next = (BigInt(rows.data.page) - 1n).toString();
                  setPage(next);
                  setFilters({ ...filters, page: next });
                }}
              >
                Previous history page
              </button>
              <button
                className="button secondary"
                disabled={rows.isFetching || rows.data.page === rows.data.pages}
                onClick={() => {
                  const next = (BigInt(rows.data.page) + 1n).toString();
                  setPage(next);
                  setFilters({ ...filters, page: next });
                }}
              >
                Next history page
              </button>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  setFilters({ ...filters, page });
                }}
              >
                <label>
                  Page
                  <input
                    aria-label="Model history page"
                    maxLength={80}
                    inputMode="numeric"
                    value={page}
                    onChange={(event) => setPage(event.target.value)}
                  />
                </label>
                <button className="button secondary" disabled={rows.isFetching}>
                  Go to history page
                </button>
              </form>
            </div>
          </>
        )}
      </section>
    </>
  );
}
