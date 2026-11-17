import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { Principal } from '../../../api/types';
import { ApiError, captureOperatorScope } from '../../../api/client';
import { currency } from '../../../lib/format';
import {
  cancelOrderImport,
  downloadImportTemplate,
  importInputSchema,
  importIsTerminal,
  previewOrderImport,
  readImportCapabilities,
  readImportResults,
  readOrderImport,
  stageOrderImport,
  type OrderImportCapabilities,
  type OrderImportInput,
  type OrderImportJob,
  type OrderImportPreview,
  type OrderImportResult,
} from './client';
import {
  clearImportIntent,
  orderImportInputHash,
  readImportIntent,
  saveImportIntent,
  type OrderImportIntent,
} from './journal';
import '../styles.css';

export default function OrderImportsPage(props: { user: Principal; online: boolean }) {
  return <OrderImports key={props.user.id} {...props} />;
}
function OrderImports({ user, online }: { user: Principal; online: boolean }) {
  const [initial] = useState(() => {
    try {
      return { intent: readImportIntent(user.id), error: '' };
    } catch {
      return {
        intent: null,
        error:
          'The saved import reference is unreadable. Keep this device for administrator recovery.',
      };
    }
  });
  const [intent, setIntent] = useState<OrderImportIntent | null>(initial.intent),
    [id, setId] = useState(initial.intent?.id ?? crypto.randomUUID()),
    [kind, setKind] = useState<'offline' | 'shopify'>(initial.intent?.kind ?? 'offline'),
    [storeId, setStoreId] = useState(initial.intent?.storeId ?? ''),
    [counters, setCounters] = useState(
      initial.intent?.counters ?? [{ storeId: '', counterId: '' }],
    ),
    [csv, setCsv] = useState(''),
    [preview, setPreview] = useState<OrderImportPreview | null>(null),
    [capabilities, setCapabilities] = useState<OrderImportCapabilities | null>(null),
    [job, setJob] = useState<OrderImportJob | null>(null),
    [results, setResults] = useState<OrderImportResult[]>([]),
    [nextAfter, setNextAfter] = useState<number | null>(null),
    [lookupId, setLookupId] = useState(initial.intent?.id ?? ''),
    [busy, setBusy] = useState(false),
    [problem, setProblem] = useState(initial.error),
    [notice, setNotice] = useState('');
  const locked = useRef(false),
    alive = useRef(true),
    readRevision = useRef(0),
    fileInput = useRef<HTMLInputElement>(null);
  const disabled = busy || !online || Boolean(initial.error);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function act(task: (signal: AbortSignal) => Promise<void>) {
    if (locked.current || !online || initial.error) return;
    const signal = captureOperatorScope(user.id);
    locked.current = true;
    setBusy(true);
    setProblem('');
    setNotice('');
    try {
      await task(signal);
      signal.throwIfAborted();
    } catch (error) {
      if (alive.current && !signal.aborted)
        setProblem(
          error instanceof ApiError
            ? `${error.message}${error.requestId ? ' (Reference ' + error.requestId + ')' : ''}`
            : error instanceof Error
              ? error.message
              : 'The import could not be confirmed. Keep its original reference.',
        );
    } finally {
      locked.current = false;
      if (alive.current && !signal.aborted) setBusy(false);
    }
  }
  async function refresh(jobId: string, signal: AbortSignal) {
    const revision = ++readRevision.current;
    const value = await readOrderImport(user.id, jobId);
    signal.throwIfAborted();
    if (!alive.current || revision !== readRevision.current) return;
    if (value.id !== jobId) throw new Error('The response belongs to a different import.');
    setJob(value);
    setLookupId(value.id);
    const page = await readImportResults(user.id, value.id);
    signal.throwIfAborted();
    if (!alive.current || revision !== readRevision.current) return;
    setResults(page.data);
    setNextAfter(page.nextAfter);
  }
  useEffect(() => {
    if (!online || initial.error) return;
    const signal = captureOperatorScope(user.id);
    let mounted = true;
    void readImportCapabilities(user.id)
      .then((value) => {
        signal.throwIfAborted();
        if (mounted) setCapabilities(value);
      })
      .catch(() => {
        if (mounted && !signal.aborted)
          setProblem('Import permissions or configuration could not be confirmed.');
      });
    try {
      const saved = readImportIntent(user.id);
      if (saved) {
        setIntent(saved);
        setId(saved.id);
        setKind(saved.kind);
        setStoreId(saved.storeId ?? '');
        setCounters(saved.counters);
        const pending = refresh(saved.id, signal),
          revision = readRevision.current;
        void pending.catch(() => {
          if (mounted && !signal.aborted && revision === readRevision.current)
            setProblem(
              'The original import is unconfirmed. Refresh its reference; no new file was queued.',
            );
        });
      }
    } catch {
      setProblem(
        'The saved import reference is unreadable. Keep this device for administrator recovery.',
      );
    }
    return () => {
      mounted = false;
      readRevision.current++;
    };
  }, [user.id, online, initial]);
  function input(): OrderImportInput {
    const parsed = importInputSchema.safeParse(
      kind === 'offline' ? { id, kind, counters, csv } : { id, kind, storeId, counters, csv },
    );
    if (!parsed.success)
      throw new Error(
        'Select a CSV file and one valid store/counter pair for each imported store.',
      );
    return parsed.data;
  }
  function changed() {
    setPreview(null);
  }
  async function selectFile(file: File | undefined) {
    if (!file) return;
    await act(async (signal) => {
      if (file.size > 5242880) throw new Error('Select a CSV file no larger than 5 MB.');
      const bytes = await file.arrayBuffer();
      signal.throwIfAborted();
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new Error('Save the file as UTF-8 CSV before importing.');
      }
      setCsv(text);
      setPreview(null);
    });
  }
  async function queue(signal: AbortSignal, retry: boolean) {
    const body = input(),
      hash = await orderImportInputHash(body);
    signal.throwIfAborted();
    if (intent && (body.id !== intent.id || hash !== intent.inputHash))
      throw new Error('Retry requires the exact original file, format and counter selections.');
    if (!retry && (!preview || preview.id !== body.id))
      throw new Error('Review this file before queuing its orders.');
    const saved: OrderImportIntent = {
      version: 1,
      operatorId: user.id,
      id: body.id,
      kind: body.kind,
      inputHash: hash,
      counters: body.counters,
      storeId: body.kind === 'shopify' ? body.storeId : null,
    };
    saveImportIntent(saved);
    readRevision.current++;
    setIntent(saved);
    setLookupId(saved.id);
    try {
      const value = await stageOrderImport(user.id, body);
      signal.throwIfAborted();
      if (value.id !== saved.id || value.kind !== saved.kind)
        throw new Error('The response does not confirm the original import.');
      setJob(value);
      setNotice('The import is queued. Refresh its status to review confirmed orders.');
    } finally {
      if (!signal.aborted) {
        setCsv('');
        setPreview(null);
        if (fileInput.current) fileInput.current.value = '';
      }
    }
  }
  return (
    <section className="surface administration-panel">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Administration</p>
          <h1>Historical order imports</h1>
        </div>
      </div>
      <p>
        Import the original offline or Shopify CSV format. Review the dates and values before
        creating orders. Files stay in memory on this device; saved recovery references contain no
        customer details.
      </p>
      {!online && (
        <p role="status">
          Connect to prepare files or recover queued orders. Existing server jobs continue
          independently.
        </p>
      )}
      {problem && (
        <p role="alert" className="inline-error">
          {problem}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {capabilities && !capabilities.ready && (
        <p role="status">
          You can validate files and recover existing imports. Creating historical orders is not
          enabled.
        </p>
      )}
      {intent && (
        <p role="status">
          Saved import reference: <code>{intent.id}</code>. Reconcile this import before preparing
          another file.
        </p>
      )}
      <fieldset disabled={disabled}>
        <legend>Prepare a file</legend>
        <label>
          CSV format
          <select
            value={kind}
            disabled={Boolean(intent)}
            onChange={(event) => {
              setKind(event.target.value === 'shopify' ? 'shopify' : 'offline');
              changed();
            }}
          >
            <option value="offline">Offline orders</option>
            <option value="shopify">Shopify export</option>
          </select>
        </label>
        {kind === 'shopify' && (
          <label>
            Shopify store ID
            <input
              inputMode="numeric"
              value={storeId}
              disabled={Boolean(intent)}
              onChange={(event) => {
                setStoreId(event.target.value);
                changed();
              }}
            />
          </label>
        )}
        {counters.map((scope, index) => (
          <div className="form-grid" key={index}>
            <label>
              Store ID {index + 1}
              <input
                inputMode="numeric"
                value={scope.storeId}
                disabled={Boolean(intent)}
                onChange={(event) => {
                  setCounters((values) =>
                    values.map((value, position) =>
                      position === index ? { ...value, storeId: event.target.value } : value,
                    ),
                  );
                  changed();
                }}
              />
            </label>
            <label>
              Counter ID {index + 1}
              <input
                inputMode="numeric"
                value={scope.counterId}
                disabled={Boolean(intent)}
                onChange={(event) => {
                  setCounters((values) =>
                    values.map((value, position) =>
                      position === index ? { ...value, counterId: event.target.value } : value,
                    ),
                  );
                  changed();
                }}
              />
            </label>
            {counters.length > 1 && (
              <button
                type="button"
                disabled={Boolean(intent)}
                onClick={() => {
                  setCounters((values) => values.filter((_, position) => position !== index));
                  changed();
                }}
              >
                Remove store {index + 1}
              </button>
            )}
          </div>
        ))}
        <button
          type="button"
          disabled={Boolean(intent) || counters.length >= 100}
          onClick={() => {
            setCounters((values) => [...values, { storeId: '', counterId: '' }]);
            changed();
          }}
        >
          Add store and counter
        </button>
        <label>
          Order CSV file
          <input
            ref={fileInput}
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => void selectFile(event.target.files?.[0])}
          />
        </label>
        <button
          type="button"
          onClick={() =>
            void act(async (signal) => {
              const blob = await downloadImportTemplate(user.id, kind);
              signal.throwIfAborted();
              const url = URL.createObjectURL(blob),
                anchor = document.createElement('a');
              try {
                anchor.href = url;
                anchor.download = kind + '-orders-template.csv';
                anchor.click();
              } finally {
                URL.revokeObjectURL(url);
              }
            })
          }
        >
          Download template
        </button>
        <button
          type="button"
          disabled={!csv || Boolean(intent)}
          onClick={() =>
            void act(async (signal) => {
              const value = await previewOrderImport(user.id, input());
              signal.throwIfAborted();
              setPreview(value);
            })
          }
        >
          Review file
        </button>
        {preview && (
          <div role="region" aria-label="Import preview">
            <p>
              {preview.totalOrders} orders · {preview.totalUnits} units · line value{' '}
              {currency(preview.lineValue)}
            </p>
            <p>
              Business dates: {preview.earliestBusinessDate} to {preview.latestBusinessDate}
            </p>
            <p>
              Historical dates and payment values will be retained. Closed periods need the
              configured financial approval.
            </p>
            <button
              type="button"
              disabled={!capabilities?.ready || Boolean(intent)}
              onClick={() => void act((signal) => queue(signal, false))}
            >
              Queue reviewed orders
            </button>
          </div>
        )}
        {intent && !job && (
          <button
            type="button"
            disabled={!csv || !capabilities?.ready}
            onClick={() => void act((signal) => queue(signal, true))}
          >
            Retry exact saved import
          </button>
        )}
      </fieldset>
      <fieldset disabled={disabled}>
        <legend>Recover an import</legend>
        <label>
          Import reference
          <input value={lookupId} onChange={(event) => setLookupId(event.target.value)} />
        </label>
        <button
          type="button"
          disabled={!z.uuid().safeParse(lookupId).success}
          onClick={() => void act((signal) => refresh(lookupId, signal))}
        >
          Refresh import
        </button>
      </fieldset>
      {job && (
        <div role="region" aria-label="Import status">
          <h2>Import {job.id}</h2>
          <p role="status">Status: {job.state}</p>
          <p>
            {job.importedOrders} confirmed · {job.failedOrders} failed · {job.cancelledOrders}{' '}
            cancelled · {job.totalOrders} total
          </p>
          {job.errorCode && (
            <p role="alert">
              Review required: {job.errorCode}. Confirm the original outcome before submitting any
              replacement orders.
            </p>
          )}
          {!importIsTerminal(job) && (
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                void act(async (signal) => {
                  const value = await cancelOrderImport(user.id, job.id);
                  signal.throwIfAborted();
                  setJob(value);
                  await refresh(value.id, signal);
                })
              }
            >
              Cancel unsent orders
            </button>
          )}
          {importIsTerminal(job) && (!intent || intent.id === job.id) && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                try {
                  clearImportIntent(user.id, job.id);
                  readRevision.current++;
                  setIntent(null);
                  setId(crypto.randomUUID());
                  setCsv('');
                  setPreview(null);
                  setJob(null);
                  setResults([]);
                  setNextAfter(null);
                  setNotice('The previous import is terminal. You can prepare another file.');
                } catch {
                  setProblem(
                    'The original recovery reference could not be retired. Refresh before preparing another file.',
                  );
                }
              }}
            >
              Prepare another file
            </button>
          )}
          {!!results.length && (
            <table>
              <thead>
                <tr>
                  <th>CSV row</th>
                  <th>Store</th>
                  <th>Counter</th>
                  <th>Status</th>
                  <th>Order</th>
                  <th>Business date</th>
                  <th>Review code</th>
                </tr>
              </thead>
              <tbody>
                {results.map((row) => (
                  <tr key={row.sequence}>
                    <td>{row.firstRow}</td>
                    <td>{row.storeId}</td>
                    <td>{row.counterId}</td>
                    <td>{row.state}</td>
                    <td>{row.orderId ?? '—'}</td>
                    <td>{row.businessDate ?? '—'}</td>
                    <td>{row.errorCode ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {nextAfter !== null && (
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                void act(async (signal) => {
                  const page = await readImportResults(user.id, job.id, nextAfter);
                  signal.throwIfAborted();
                  setResults((values) => [...values, ...page.data]);
                  setNextAfter(page.nextAfter);
                })
              }
            >
              Load more results
            </button>
          )}
        </div>
      )}
    </section>
  );
}
