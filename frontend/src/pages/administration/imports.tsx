import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Principal } from '../../api/types';
import { params, request } from '../../api/client';
import { Empty, ErrorState, Loading } from '../../components/common';
import { mutateAdministration, pageSchema } from './api';
import { AdministrationEditor } from './editor';
import {
  downloadImportCsv,
  importCapabilitiesSchema,
  importJobSchema,
  importPreviewSchema,
  importRowSchema,
  stockImportHeaders,
  type ImportJob,
  type ImportPreview,
} from './import-api';

const base = '/api/v1/admin/inventory-imports';
function ImportProgress({
  user,
  importId,
  onChange,
}: {
  user: Principal;
  importId: string;
  onChange: () => Promise<void>;
}) {
  const [after, setAfter] = useState('0'),
    [state, setState] = useState('all'),
    [history, setHistory] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [cancelling, setCancelling] = useState(false),
    [error, setError] = useState<unknown>(null);
  const detail = useQuery({
    queryKey: [user.id, 'administration', 'inventory-import', importId],
    queryFn: ({ signal }) =>
      request(`${base}/${importId}`, { operatorId: user.id, signal }, importJobSchema),
    refetchInterval: (query) =>
      ['QUEUED', 'RUNNING'].includes(query.state.data?.state || '') ? 2000 : false,
  });
  const rows = useQuery({
    queryKey: [user.id, 'administration', 'inventory-import-rows', importId, after, state],
    queryFn: ({ signal }) =>
      request(
        `${base}/${importId}/rows?${params({ after, state, limit: '50' })}`,
        { operatorId: user.id, signal },
        pageSchema(importRowSchema),
      ),
    refetchInterval:
      detail.data && ['QUEUED', 'RUNNING'].includes(detail.data.state) ? 2000 : false,
  });
  async function control(action: 'resume' | 'cancel') {
    setBusy(true);
    try {
      await mutateAdministration(`${base}/${importId}/${action}`, 'POST', {}, user.id);
      setError(null);
      await onChange();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  async function download() {
    setBusy(true);
    try {
      await downloadImportCsv(
        `${base}/${importId}/failures.csv`,
        `InventoryImport-${importId}-failed.csv`,
        user.id,
      );
      setError(null);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="surface administration-section-gap">
      {detail.isPending ? (
        <Loading />
      ) : detail.isError ? (
        <ErrorState error={detail.error} />
      ) : (
        <>
          <div className="administration-heading">
            <div>
              <h3>{detail.data.name}</h3>
              <p>
                {detail.data.state} · {detail.data.processedRows}/{detail.data.totalRows} processed
                · {detail.data.successfulRows} succeeded · {detail.data.failedRows} failed
              </p>
            </div>
            <div className="administration-actions">
              {detail.data.failedRows > 0 && (
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => void download()}
                >
                  Download failed records
                </button>
              )}
              {detail.data.state === 'BLOCKED' && (
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() => void control('resume')}
                >
                  Resume import
                </button>
              )}
              {!['COMPLETED', 'CANCELLED'].includes(detail.data.state) && (
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => setCancelling(true)}
                >
                  Cancel pending records
                </button>
              )}
            </div>
          </div>
          {detail.data.state === 'BLOCKED' && (
            <p className="administration-notice">
              Processing needs attention before it can continue. Resolve the reported dependency or
              account access, then resume.
            </p>
          )}
          {error !== null && <ErrorState error={error} />}
          <div className="administration-heading">
            <label>
              Record status{' '}
              <select
                aria-label="Import record status"
                value={state}
                onChange={(event) => {
                  setState(event.target.value);
                  setAfter('0');
                  setHistory([]);
                }}
              >
                {['all', 'PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED'].map((value) => (
                  <option key={value} value={value}>
                    {value === 'all' ? 'All records' : value}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {rows.isPending ? (
            <Loading />
          ) : rows.isError ? (
            <ErrorState error={rows.error} />
          ) : (
            <>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Record</th>
                      {stockImportHeaders.map((name) => (
                        <th key={name}>{name}</th>
                      ))}
                      <th>Status</th>
                      <th>Message</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.data.data.map((row) => (
                      <tr key={row.rowNumber}>
                        <td>{row.rowNumber}</td>
                        {row.cells.map((value, index) => (
                          <td key={index}>{value || '—'}</td>
                        ))}
                        <td>{row.state}</td>
                        <td>{row.message || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="administration-heading">
                <button
                  className="button secondary"
                  disabled={!history.length}
                  onClick={() => {
                    setAfter(history.at(-1)!);
                    setHistory(history.slice(0, -1));
                  }}
                >
                  Previous records
                </button>
                <button
                  className="button secondary"
                  disabled={!rows.data.nextCursor}
                  onClick={() => {
                    setHistory([...history, after]);
                    setAfter(rows.data.nextCursor!);
                  }}
                >
                  Next records
                </button>
              </div>
            </>
          )}
          {cancelling && (
            <AdministrationEditor
              title="Cancel remaining import records?"
              fields={[]}
              initialValues={{}}
              description="Already applied records stay in effect. Remaining records will be cancelled."
              submitLabel="Cancel remaining records"
              onClose={() => setCancelling(false)}
              onSave={async () => {
                await mutateAdministration(`${base}/${importId}/cancel`, 'POST', {}, user.id);
                await onChange();
              }}
            />
          )}
        </>
      )}
    </section>
  );
}
export function InventoryImportAdministration({ user }: { user: Principal }) {
  const client = useQueryClient(),
    previewAbort = useRef<AbortController | null>(null);
  const [draft, setDraft] = useState<{ id: string; name: string; csv: string } | null>(null),
    [preview, setPreview] = useState<ImportPreview | null>(null),
    [selected, setSelected] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [message, setMessage] = useState('');
  const [historyMode, setHistoryMode] = useState(false),
    [from, setFrom] = useState(() =>
      new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
    ),
    [to, setTo] = useState(() => new Date(Date.now() - 86400000).toISOString().slice(0, 10));
  useEffect(() => () => previewAbort.current?.abort(), []);
  const capabilities = useQuery({
    enabled: user.userType === 1,
    queryKey: [user.id, 'administration', 'inventory-import-capabilities'],
    queryFn: ({ signal }) =>
      request(`${base}/capabilities`, { operatorId: user.id, signal }, importCapabilitiesSchema),
  });
  const jobs = useInfiniteQuery({
    enabled: user.userType === 1 && !historyMode,
    queryKey: [user.id, 'administration', 'inventory-imports'],
    initialPageParam: '0',
    queryFn: ({ pageParam, signal }) =>
      request(
        `${base}?${params({ after: pageParam, limit: '30' })}`,
        { operatorId: user.id, signal },
        pageSchema(importJobSchema),
      ),
    getNextPageParam: (page) => page.nextCursor || undefined,
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) =>
        page.data.some((job) => ['QUEUED', 'RUNNING'].includes(job.state)),
      )
        ? 3000
        : false,
  });
  const historicalJobs = useInfiniteQuery({
    enabled: user.userType === 1 && historyMode && !!capabilities.data?.historyEnabled,
    queryKey: [user.id, 'administration', 'inventory-import-history', from, to],
    initialPageParam: '0',
    queryFn: ({ pageParam, signal }) =>
      request(
        `${base}/history?${params({ after: pageParam, limit: '30', from, to })}`,
        { operatorId: user.id, signal },
        pageSchema(importJobSchema),
      ),
    getNextPageParam: (page) => page.nextCursor || undefined,
  });
  const collection = historyMode ? historicalJobs : jobs;
  const changed = () => client.invalidateQueries({ queryKey: [user.id] });
  async function choose(file: File | undefined) {
    previewAbort.current?.abort();
    const controller = new AbortController();
    previewAbort.current = controller;
    setDraft(null);
    setPreview(null);
    setError(null);
    setMessage('');
    if (!file) return;
    setBusy(true);
    try {
      if (!/\.csv$/i.test(file.name) || file.size > (capabilities.data?.maximumBytes || 262144))
        throw new Error('Choose a CSV file up to 256 KiB.');
      const csv = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      controller.signal.throwIfAborted();
      const input = { id: crypto.randomUUID(), name: file.name, csv };
      const result = await request(
        `${base}/preview`,
        {
          operatorId: user.id,
          method: 'POST',
          body: JSON.stringify(input),
          signal: controller.signal,
        },
        importPreviewSchema,
      );
      if (previewAbort.current !== controller) return;
      setDraft(input);
      setPreview(result);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure);
    } finally {
      if (previewAbort.current === controller) setBusy(false);
    }
  }
  async function submit() {
    if (!draft || !preview?.canSubmit) return;
    setBusy(true);
    try {
      const job = await request(
        base,
        { operatorId: user.id, method: 'POST', body: JSON.stringify(draft) },
        importJobSchema,
      );
      setSelected(job.id);
      setDraft(null);
      setPreview(null);
      setError(null);
      setMessage('Import queued. Each record is checked again before applying.');
      await changed();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  async function template() {
    setBusy(true);
    try {
      await downloadImportCsv(`${base}/template`, 'ProductStock-template.csv', user.id);
      setError(null);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  const records: ImportJob[] = collection.data?.pages.flatMap((page) => page.data) || [];
  if (user.userType === 2)
    return <Empty title="Inventory imports require an in-house administrator" />;
  return (
    <>
      <div className="administration-heading">
        <h2>Inventory CSV imports</h2>
        <button className="button secondary" disabled={busy} onClick={() => void template()}>
          Download stock template
        </button>
      </div>
      <p>
        Use SKU and store IDs. Leave movement fields empty to change listing status only. Use IsHold
        1 to hold stock or 0 to release it. Remove the instruction and example records before
        uploading.
      </p>
      {capabilities.isPending ? (
        <Loading />
      ) : capabilities.isError ? (
        <ErrorState error={capabilities.error} />
      ) : (
        <>
          {!capabilities.data.stockEnabled && (
            <p className="administration-notice">
              Holding and releasing stock are currently unavailable. Listing-status imports can
              still run when enabled.
            </p>
          )}
          <section className="surface">
            <label>
              Choose inventory CSV{' '}
              <input
                aria-label="Choose inventory CSV"
                type="file"
                accept=".csv,text/csv"
                disabled={busy}
                onChange={(event) => void choose(event.target.files?.[0])}
              />
            </label>
            {busy && <p role="status">Processing…</p>}
            {preview && (
              <>
                <p>
                  {draft?.name} · {preview.totalRows} records · {preview.validRows} currently valid
                  · {preview.invalidRows} with errors
                </p>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Record</th>
                        <th>SKU</th>
                        <th>Store</th>
                        <th>Movement</th>
                        <th>Quantity</th>
                        <th>Validation</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((row) => (
                        <tr key={row.rowNumber}>
                          <td>{row.rowNumber}</td>
                          <td>{row.cells[0]}</td>
                          <td>{row.cells[1]}</td>
                          <td>{row.command?.movement || '—'}</td>
                          <td>{row.command?.quantity || '—'}</td>
                          <td>{row.errorCode ? row.message : row.message || 'Ready'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {preview.remainingRows > 0 && <p>Showing the first 100 records.</p>}
                {preview.invalidRows > 0 && (
                  <p>Failed records are recorded separately; other records continue processing.</p>
                )}
                <button
                  className="button primary"
                  disabled={busy || !preview.canSubmit}
                  onClick={() => void submit()}
                >
                  Queue import
                </button>
                {!preview.canSubmit && (
                  <p className="administration-notice">
                    This file requires an import capability that is currently unavailable.
                  </p>
                )}
              </>
            )}
          </section>
        </>
      )}
      {error !== null && <ErrorState error={error} />}
      {message && (
        <div role="status" className="administration-status">
          {message}
        </div>
      )}
      <div className="administration-heading administration-section-gap">
        <h2>{historyMode ? 'Completed import history' : 'Recent imports'}</h2>
        <div className="administration-filters">
          <select
            aria-label="Import history scope"
            value={historyMode ? 'historical' : 'current'}
            onChange={(event) => {
              setHistoryMode(event.target.value === 'historical');
              setSelected(null);
            }}
          >
            <option value="current">Last 24 hours and unfinished</option>
            <option value="historical" disabled={!capabilities.data?.historyEnabled}>
              Completed history
            </option>
          </select>
          {historyMode && (
            <>
              <label>
                From{' '}
                <input
                  aria-label="Import history from"
                  type="date"
                  value={from}
                  onChange={(event) => {
                    setFrom(event.target.value);
                    setSelected(null);
                  }}
                />
              </label>
              <label>
                To{' '}
                <input
                  aria-label="Import history to"
                  type="date"
                  value={to}
                  onChange={(event) => {
                    setTo(event.target.value);
                    setSelected(null);
                  }}
                />
              </label>
            </>
          )}
        </div>
      </div>
      {!capabilities.isPending && !capabilities.data?.historyEnabled && (
        <p className="administration-notice">Completed history is currently unavailable.</p>
      )}
      <section className="surface">
        {collection.isPending ? (
          <Loading />
        ) : collection.isError ? (
          <ErrorState error={collection.error} />
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Status</th>
                    <th>Processed</th>
                    <th>Succeeded</th>
                    <th>Failed</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((job) => (
                    <tr key={job.id}>
                      <td>{job.name}</td>
                      <td>{job.state}</td>
                      <td>
                        {job.processedRows}/{job.totalRows}
                      </td>
                      <td>{job.successfulRows}</td>
                      <td>{job.failedRows}</td>
                      <td>
                        <button className="button secondary" onClick={() => setSelected(job.id)}>
                          View records
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!records.length && <Empty title="No inventory imports yet" />}
            {collection.hasNextPage && (
              <button className="button secondary" onClick={() => void collection.fetchNextPage()}>
                Load more imports
              </button>
            )}
          </>
        )}
      </section>
      {selected && (
        <ImportProgress key={selected} user={user} importId={selected} onChange={changed} />
      )}
    </>
  );
}
