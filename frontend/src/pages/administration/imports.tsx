import { useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Principal } from '../../api/types';
import { params, request } from '../../api/client';
import { Empty, ErrorState, Loading } from '../../components/common';
import {
  downloadTemplate,
  uploadDetailSchema,
  uploadPageSchema,
  uploadResultSchema,
  type UploadType,
} from './import-api';

const base = '/api/v1/admin/inventory-imports';
const maximumBytes = 256 * 1024;
const profiles: Record<
  UploadType,
  { title: string; instructions: string; fileLabel: string; templateLabel: string }
> = {
  PRODUCT_STOCK_CSV: {
    title: 'Inventory CSV imports',
    instructions:
      'Columns SkuId, StoreId, IsHold, Hold/UnholdQty, IsAvailable, IsDelete. A Hold/UnholdQty with any IsHold value moves that quantity from saleable stock into hold stock. Leave both empty to change listing flags only. Remove the instruction and example rows before uploading.',
    fileLabel: 'Choose inventory CSV',
    templateLabel: 'Download stock template',
  },
  PRODUCT_STORE_CSV: {
    title: 'Parent/store assignments',
    instructions:
      'Columns SkuId, StoreId, IsActive. Use parent product IDs only. IsActive 1 recreates the parent and its live variant assignments with zero stock; IsActive 0 removes them. Remove the instruction and example rows before uploading.',
    fileLabel: 'Choose parent/store CSV',
    templateLabel: 'Download parent/store template',
  },
};
const statusText = (imported: boolean) => (imported ? 'Imported' : 'Processing');

function UploadDetailView({ user, uploadId }: { user: Principal; uploadId: string }) {
  const detail = useQuery({
    queryKey: [user.id, 'administration', 'csv-upload', uploadId],
    queryFn: ({ signal }) =>
      request(`${base}/${uploadId}`, { operatorId: user.id, signal }, uploadDetailSchema),
    refetchInterval: (query) => (query.state.data && !query.state.data.isImported ? 3000 : false),
  });
  if (detail.isPending) return <Loading />;
  if (detail.isError) return <ErrorState error={detail.error} />;
  const value = detail.data,
    failed = value.failedData ?? [],
    columns = [...new Set(failed.flatMap((entry) => Object.keys(entry.data)))];
  return (
    <section className="surface administration-section-gap">
      <h3>Upload {value.id}</h3>
      <p>
        {statusText(value.isImported)}
        {value.message ? ` · ${value.message}` : ''}
      </p>
      {value.isImported &&
        (failed.length ? (
          <div className="table-wrap">
            <table>
              <caption>Failed records</caption>
              <thead>
                <tr>
                  {columns.map((column) => (
                    <th key={column}>{column}</th>
                  ))}
                  <th>Message</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {failed.map((entry, index) => (
                  <tr key={index}>
                    {columns.map((column) => (
                      <td key={column}>{entry.data[column] ?? ''}</td>
                    ))}
                    <td>{entry.message}</td>
                    <td>{entry.other_error ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>No failed records.</p>
        ))}
    </section>
  );
}

function CsvUploadAdministration({ user, type }: { user: Principal; type: UploadType }) {
  const profile = profiles[type],
    client = useQueryClient();
  const [file, setFile] = useState<{ name: string; csv: string } | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState<unknown>(null),
    [selected, setSelected] = useState<string | null>(null),
    [inputKey, setInputKey] = useState(0);
  const history = useInfiniteQuery({
    queryKey: [user.id, 'administration', 'csv-uploads', type],
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) =>
      request(
        `${base}?${params({ type, limit: '30', ...(pageParam ? { before: pageParam } : {}) })}`,
        { operatorId: user.id, signal },
        uploadPageSchema,
      ),
    getNextPageParam: (page) => page.nextBefore ?? undefined,
  });
  async function choose(selectedFile: File | undefined) {
    setMessage('');
    setError(null);
    setFile(null);
    if (!selectedFile) return;
    if (!selectedFile.name.endsWith('.csv'))
      return setError(new Error('Only CSV file is accepted'));
    if (selectedFile.size > maximumBytes)
      return setError(new Error('Choose a CSV file up to 256 KiB.'));
    setFile({ name: selectedFile.name, csv: await selectedFile.text() });
  }
  async function upload() {
    if (!file) return;
    setBusy(true);
    try {
      const result = await request(
        base,
        {
          method: 'POST',
          operatorId: user.id,
          body: JSON.stringify({ type, name: file.name, csv: file.csv }),
        },
        uploadResultSchema,
      );
      setMessage(result.message);
      setError(null);
      setFile(null);
      setInputKey((key) => key + 1);
      setSelected(result.id);
      await client.invalidateQueries({
        queryKey: [user.id, 'administration', 'csv-uploads', type],
      });
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  async function template() {
    setBusy(true);
    try {
      await downloadTemplate(type, user.id);
      setError(null);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  const rows = history.data?.pages.flatMap((page) => page.data) ?? [];
  return (
    <>
      <div className="administration-heading">
        <h2>{profile.title}</h2>
        <button className="button secondary" disabled={busy} onClick={() => void template()}>
          {profile.templateLabel}
        </button>
      </div>
      <section className="surface">
        <p>{profile.instructions}</p>
        <label>
          {profile.fileLabel}
          <input
            key={inputKey}
            type="file"
            accept=".csv,text/csv"
            disabled={busy}
            onChange={(event) => void choose(event.target.files?.[0])}
          />
        </label>
        <button className="button primary" disabled={busy || !file} onClick={() => void upload()}>
          Upload CSV
        </button>
      </section>
      {message && (
        <div role="status" className="administration-status">
          {message}
        </div>
      )}
      {error !== null && <ErrorState error={error} />}
      {selected && <UploadDetailView key={selected} user={user} uploadId={selected} />}
      <h3 className="administration-section-gap">Upload history</h3>
      <section className="surface">
        {history.isPending ? (
          <Loading />
        ) : history.isError ? (
          <ErrorState error={history.error} />
        ) : !rows.length ? (
          <Empty title="No uploads yet" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Uploaded by</th>
                  <th>Uploaded at</th>
                  <th>Status</th>
                  <th>Message</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.id}</td>
                    <td>{row.uploaderName || row.uploadedBy || ''}</td>
                    <td>{row.createdAt ?? ''}</td>
                    <td>{statusText(row.isImported)}</td>
                    <td>{row.message ?? ''}</td>
                    <td>
                      <button className="button secondary" onClick={() => setSelected(row.id)}>
                        View records
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {history.hasNextPage && (
          <button className="button secondary" onClick={() => void history.fetchNextPage()}>
            Load more
          </button>
        )}
      </section>
    </>
  );
}

export function InventoryImportAdministration({ user }: { user: Principal }) {
  return <CsvUploadAdministration user={user} type="PRODUCT_STOCK_CSV" />;
}
export function ParentStoreImportAdministration({ user }: { user: Principal }) {
  return <CsvUploadAdministration user={user} type="PRODUCT_STORE_CSV" />;
}
