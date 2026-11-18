import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { request } from '../../api/client';
import type { Principal } from '../../api/types';
import { ErrorState, Loading } from '../../components/common';
import { useOnline } from '../../hooks/use-pos';
import {
  CatalogPagination,
  CatalogTable,
  downloadCatalogFile,
  type CatalogColumn,
} from '../catalog/table';
import { csvCell } from '../reports';
import { administrationIdentifier } from './api';
import '../catalog/style.css';

const terminalRow = z.object({
  id: administrationIdentifier,
  provider: z.enum(['paytm', 'pine-labs']),
  name: z.string(),
  merchantName: z.string(),
  channelId: z.string(),
  hardwareId: z.string(),
  imei: z.string(),
  deviceSerialNumber: z.string(),
  terminalId: z.string(),
  merchantId: z.string(),
  storeCode: z.string(),
  storeName: z.string(),
  storeId: administrationIdentifier,
  active: z.number(),
});
export type TerminalDirectoryRow = z.infer<typeof terminalRow>;
const response = z.object({
  data: z.array(terminalRow),
  total: z.number().int().nonnegative(),
  start: z.number().int().nonnegative(),
  length: z.number().int().positive(),
});
type DisplayRow = TerminalDirectoryRow & { machineId: string; actions: null };
const sortFields = [
  'id',
  'provider',
  'name',
  'merchantName',
  'storeName',
  'terminalId',
  'storeId',
] as const;
interface Filters {
  allStores: boolean;
  provider: 'all' | 'paytm' | 'pine-labs';
  search: string;
  sort: (typeof sortFields)[number];
  direction: 'asc' | 'desc';
}
export function TerminalDirectory({
  user,
  storeId,
  onEdit,
  onDelete,
}: {
  user: Principal;
  storeId: string;
  onEdit: (row: TerminalDirectoryRow) => void;
  onDelete: (row: TerminalDirectoryRow) => void;
}) {
  const online = useOnline(),
    [filters, setFilters] = useState<Filters>({
      allStores: false,
      provider: 'all',
      search: '',
      sort: 'id',
      direction: 'desc',
    }),
    [submitted, setSubmitted] = useState(filters),
    [start, setStart] = useState(0),
    [length, setLength] = useState(25),
    [exporting, setExporting] = useState(false),
    [exportError, setExportError] = useState<Error | null>(null),
    exportController = useRef<AbortController | null>(null);
  useEffect(() => () => exportController.current?.abort(), []);
  const body = {
    ...(submitted.allStores ? {} : { storeId }),
    provider: submitted.provider,
    search: submitted.search,
    sort: submitted.sort,
    direction: submitted.direction,
  };
  const data = useQuery({
    queryKey: [user.id, 'administration', 'terminal-directory', body, start, length],
    enabled: !!storeId,
    queryFn: ({ signal }) =>
      request(
        '/api/v1/admin/payment-terminals/search',
        {
          method: 'POST',
          operatorId: user.id,
          signal,
          body: JSON.stringify({ ...body, start, length }),
        },
        response,
      ),
  });
  const columns: readonly CatalogColumn<DisplayRow>[] = [
    { key: 'machineId', label: 'Machine ID' },
    { key: 'provider', label: 'Provider' },
    { key: 'merchantName', label: 'Merchant' },
    { key: 'name', label: 'Machine name' },
    { key: 'channelId', label: 'Client / channel ID' },
    { key: 'hardwareId', label: 'Hardware ID / Paytm MID' },
    { key: 'imei', label: 'IMEI' },
    { key: 'deviceSerialNumber', label: 'Device serial number' },
    { key: 'terminalId', label: 'Terminal ID' },
    { key: 'merchantId', label: 'Merchant ID' },
    { key: 'storeCode', label: 'Store POS code' },
    { key: 'storeName', label: 'Store' },
    { key: 'storeId', label: 'Store ID' },
    {
      key: 'active',
      label: 'Status',
      render: (row) => (row.active === 1 ? 'Active' : 'Archived'),
      exportValue: (row) => (row.active === 1 ? 'Active' : 'Archived'),
    },
    {
      key: 'actions',
      label: 'Actions',
      exportValue: () => '',
      render: (row) => (
        <div className="administration-table-actions">
          <button
            className="button secondary"
            disabled={!online}
            onClick={() => onEdit({ ...row, id: row.machineId })}
          >
            Edit
          </button>
          <button
            className="button secondary"
            disabled={!online}
            onClick={() => onDelete({ ...row, id: row.machineId })}
          >
            Delete
          </button>
        </div>
      ),
    },
  ];
  const display = (row: TerminalDirectoryRow): DisplayRow => ({
    ...row,
    machineId: row.id,
    id: `${row.provider}:${row.id}`,
    actions: null,
  });
  async function exportAll(visible: readonly CatalogColumn<DisplayRow>[]) {
    if (exportController.current) return;
    const controller = new AbortController();
    exportController.current = controller;
    setExporting(true);
    setExportError(null);
    try {
      const lines: string[] = [],
        maxBytes = 32 * 1024 * 1024;
      let bytes = 3,
        expected: number | undefined;
      const append = (values: readonly unknown[]) => {
        const line = values.map(csvCell).join(',') + '\r\n';
        bytes += new TextEncoder().encode(line).byteLength;
        if (bytes > maxBytes)
          throw new Error('This export is too large. Choose fewer matching terminals.');
        lines.push(line);
      };
      append(visible.map((column) => column.label));
      for (let offset = 0; ; offset += 500) {
        const result = await request(
          '/api/v1/admin/payment-terminals/search',
          {
            method: 'POST',
            operatorId: user.id,
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]),
            body: JSON.stringify({ ...body, start: offset, length: 500 }),
          },
          response,
        );
        if (result.total > 70000) throw new Error('Choose fewer matching terminals for export.');
        if (expected !== undefined && result.total !== expected)
          throw new Error('The terminal directory changed. Refresh and export again.');
        expected = result.total;
        for (const raw of result.data) {
          const row = display(raw);
          append(
            visible.map((column) =>
              column.exportValue ? column.exportValue(row) : row[column.key],
            ),
          );
        }
        if (offset + result.data.length >= result.total) break;
        if (result.data.length !== 500)
          throw new Error('The terminal directory changed. Refresh and export again.');
      }
      controller.signal.throwIfAborted();
      downloadCatalogFile(
        'payment-terminals.csv',
        new Blob(['\uFEFF', ...lines], { type: 'text/csv;charset=utf-8' }),
      );
    } catch (error) {
      if (!controller.signal.aborted)
        setExportError(error instanceof Error ? error : new Error('Export failed.'));
    } finally {
      if (exportController.current === controller) exportController.current = null;
      if (!controller.signal.aborted) setExporting(false);
    }
  }
  return (
    <>
      <form
        className="surface catalog-filters"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(filters);
          setStart(0);
        }}
      >
        <label>
          Machine type
          <select
            value={filters.provider}
            onChange={(event) =>
              setFilters({
                ...filters,
                provider: z.enum(['all', 'paytm', 'pine-labs']).parse(event.target.value),
              })
            }
          >
            <option value="all">All providers</option>
            <option value="paytm">Paytm</option>
            <option value="pine-labs">Pine Labs</option>
          </select>
        </label>
        <label>
          Stores
          <select
            value={String(filters.allStores)}
            onChange={(event) =>
              setFilters({ ...filters, allStores: event.target.value === 'true' })
            }
          >
            <option value="false">Selected store</option>
            <option value="true">All permitted stores</option>
          </select>
        </label>
        <label>
          Search
          <input
            maxLength={100}
            value={filters.search}
            onChange={(event) => setFilters({ ...filters, search: event.target.value })}
          />
        </label>
        <label>
          Sort by
          <select
            value={filters.sort}
            onChange={(event) =>
              setFilters({ ...filters, sort: z.enum(sortFields).parse(event.target.value) })
            }
          >
            {sortFields.map((field) => (
              <option key={field} value={field}>
                {field === 'id'
                  ? 'Machine ID'
                  : field.replace(/[A-Z]/g, (letter) => ' ' + letter.toLowerCase())}
              </option>
            ))}
          </select>
        </label>
        <label>
          Direction
          <select
            value={filters.direction}
            onChange={(event) =>
              setFilters({ ...filters, direction: event.target.value === 'asc' ? 'asc' : 'desc' })
            }
          >
            <option value="desc">Descending</option>
            <option value="asc">Ascending</option>
          </select>
        </label>
        <button className="button primary" disabled={!online || data.isFetching || exporting}>
          View terminals
        </button>
        <button
          className="button secondary"
          type="button"
          disabled={!online || data.isFetching || exporting}
          onClick={() => void data.refetch()}
        >
          Reload table
        </button>
      </form>
      {exportError && <ErrorState error={exportError} />}
      {data.isPending ? (
        <Loading />
      ) : data.isError ? (
        <ErrorState error={data.error} />
      ) : (
        <>
          <CatalogTable
            ownerId={user.id}
            columns={columns}
            rows={data.data.data.map(display)}
            name="payment-terminals-page.csv"
            description={`${data.data.total.toLocaleString()} matching terminals`}
            extra={(visible) => (
              <button
                className="button secondary"
                disabled={!online || exporting || !visible.length || !data.data.total}
                onClick={() => void exportAll(visible)}
              >
                {exporting ? 'Exporting…' : 'Export all matching CSV'}
              </button>
            )}
          />
          <CatalogPagination
            start={start}
            total={data.data.total}
            length={length}
            busy={data.isFetching || exporting}
            onStart={setStart}
            onLength={(value) => {
              setLength(value);
              setStart(0);
            }}
          />
        </>
      )}
    </>
  );
}
