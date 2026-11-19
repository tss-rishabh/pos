import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import type { Principal } from '../../api/types';
import { captureOperatorScope, request } from '../../api/client';
import { Empty, ErrorState, PageTitle } from '../../components/common';
import { SkeletonTable } from '../../components/loader';
import { useOnline } from '../../hooks/use-pos';
import {
  activityCapabilitiesSchema,
  activityColumns,
  activityPageCsv,
  activityResultSchema,
  type ActivityColumn,
} from './permission-history-api';
import './styles.css';

const initialPlatforms = ['barcode', 'Tss Money', 'Tss Points', 'Gift Voucher', 'Gift Card'];
const endpoint = '/api/v1/admin/special-permission-activity';
const lengths = [10, 25, 50, 100, 500];
const defaultColumns = activityColumns.map(([key]) => key);
const layoutSchema = z
  .object({
    length: z
      .number()
      .int()
      .refine((value) => lengths.includes(value)),
    columns: z.array(z.enum(defaultColumns)).max(defaultColumns.length),
  })
  .strict();
function savedLayout(ownerId: string) {
  try {
    return layoutSchema.parse(
      JSON.parse(
        localStorage.getItem('pos:permission-activity-layout:' + ownerId) || 'null',
      ) as unknown,
    );
  } catch {
    return { length: 10, columns: defaultColumns };
  }
}
interface Filters {
  from: string | null;
  to: string | null;
  search: string;
  platforms: string[];
}
export function SpecialPermissionHistoryPage({ user }: { user: Principal }) {
  const online = useOnline(),
    [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [search, setSearch] = useState(''),
    [platforms, setPlatforms] = useState(initialPlatforms),
    [filters, setFilters] = useState<Filters>({
      from: null,
      to: null,
      search: '',
      platforms: initialPlatforms,
    }),
    [start, setStart] = useState(0),
    [length, setLength] = useState(() => savedLayout(user.id).length),
    [columns, setColumns] = useState<ActivityColumn[]>(() => savedLayout(user.id).columns),
    [error, setError] = useState('');
  const visible = activityColumns.filter(([key]) => columns.includes(key));
  useEffect(() => {
    try {
      localStorage.setItem(
        'pos:permission-activity-layout:' + user.id,
        JSON.stringify({ length, columns }),
      );
    } catch {
      /* Layout preferences must not prevent report reads. */
    }
  }, [user.id, length, columns]);
  const allowed = user.userType === 1 && [1, 2, 3].includes(user.role);
  const meta = useQuery({
    queryKey: [user.id, 'permission-activity', 'capabilities'],
    enabled: allowed && online,
    queryFn: ({ signal }) =>
      request(
        endpoint + '/capabilities',
        { operatorId: user.id, signal, cache: 'no-store' },
        activityCapabilitiesSchema,
      ),
    retry: false,
  });
  const rows = useQuery({
    queryKey: [user.id, 'permission-activity', filters, start, length],
    enabled: allowed && online,
    queryFn: ({ signal }) =>
      request(
        endpoint + '/search',
        {
          method: 'POST',
          operatorId: user.id,
          signal,
          cache: 'no-store',
          body: JSON.stringify({ ...filters, start, length, draw: 1 }),
        },
        activityResultSchema,
      ),
    retry: false,
  });
  if (!allowed) return <Empty title="Internal administration access is required" />;
  function apply(next: Filters) {
    setError('');
    if (
      start === 0 &&
      filters.from === next.from &&
      filters.to === next.to &&
      filters.search === next.search &&
      filters.platforms.length === next.platforms.length &&
      filters.platforms.every((value, index) => value === next.platforms[index])
    )
      void rows.refetch();
    setStart(0);
    setFilters(next);
  }
  function download() {
    if (!rows.data || !visible.length) return;
    try {
      captureOperatorScope(user.id);
      const url = URL.createObjectURL(
          new Blob([activityPageCsv(rows.data.data, columns)], { type: 'text/csv;charset=utf-8' }),
        ),
        anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'permission-activity.csv';
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setError('The signed-in operator changed. Sign in again to export activity.');
    }
  }
  return (
    <>
      <PageTitle title="Permission activity" />
      <section className="surface permission-activity-filters">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (Boolean(from) !== Boolean(to) || from > to) {
              setError('Choose both dates in order, or all history.');
              return;
            }
            apply({ from: from || null, to: to || null, search, platforms });
          }}
        >
          <div className="administration-fields">
            <label>
              From date
              <input
                aria-label="Activity from date"
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
                aria-label="Activity to date"
                type="date"
                min="1000-01-01"
                max="9999-12-31"
                value={to}
                onChange={(event) => setTo(event.target.value)}
              />
            </label>
            <label className="administration-wide">
              Find recipient, comment, platform or date
              <input
                aria-label="Find permission activity"
                maxLength={255}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
          </div>
          <fieldset className="administration-access-fieldset">
            <legend>Platforms</legend>
            <div className="administration-assignment-list">
              {(meta.data?.platforms || initialPlatforms).map((platform) => (
                <label key={platform}>
                  <input
                    type="checkbox"
                    checked={platforms.includes(platform)}
                    onChange={(event) =>
                      setPlatforms((current) =>
                        event.target.checked
                          ? [...new Set([...current, platform])]
                          : current.filter((value) => value !== platform),
                      )
                    }
                  />
                  {platform}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="administration-actions">
            <button className="button primary" disabled={!online || rows.isFetching}>
              Apply filters
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={!online || !meta.data}
              onClick={() => {
                if (meta.data) {
                  setFrom(meta.data.today);
                  setTo(meta.data.today);
                  apply({ from: meta.data.today, to: meta.data.today, search, platforms });
                }
              }}
            >
              Today
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={!online}
              onClick={() => {
                setFrom('');
                setTo('');
                apply({ from: null, to: null, search, platforms });
              }}
            >
              All history
            </button>
            <label>
              Rows per page
              <select
                aria-label="Activity rows per page"
                value={length}
                onChange={(event) => {
                  setLength(Number(event.target.value));
                  setStart(0);
                }}
              >
                {lengths.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </form>
        {error && <p role="alert">{error}</p>}
        {!online && <p>Reconnect to load activity history.</p>}
        {meta.isError && <ErrorState error={meta.error} />}
      </section>
      <section className="surface administration-section-gap">
        {rows.isPending ? (
          <SkeletonTable />
        ) : rows.isError ? (
          <ErrorState error={rows.error} retry={() => void rows.refetch()} />
        ) : (
          <>
            <p role="status">{rows.data.recordsFiltered} matching activities.</p>
            <div className="administration-actions">
              <button
                className="button secondary"
                onClick={download}
                disabled={!rows.data.data.length || !visible.length || rows.isFetching}
              >
                Export visible page CSV
              </button>
              <details>
                <summary>Activity columns</summary>
                <div className="administration-assignment-list">
                  {activityColumns.map(([key, label]) => (
                    <label key={key}>
                      <input
                        type="checkbox"
                        checked={columns.includes(key)}
                        onChange={(event) =>
                          setColumns((current) =>
                            event.target.checked
                              ? [...new Set([...current, key])]
                              : current.filter((value) => value !== key),
                          )
                        }
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </details>
            </div>
            <div className="table-wrap">
              <table className="administration-table">
                <thead>
                  <tr>
                    {visible.map(([key, label]) => (
                      <th key={key}>{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.data.data.map((row) => (
                    <tr key={row.id}>
                      {visible.map(([key]) => (
                        <td key={key} className="administration-wrap">
                          {row[key]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!rows.data.data.length && <Empty title="No matching activities" />}
            <div className="administration-actions">
              <button
                className="button secondary"
                disabled={!online || rows.isFetching || rows.data.start === 0}
                onClick={() => setStart(Math.max(0, rows.data.start - length))}
              >
                Previous activity page
              </button>
              <button
                className="button secondary"
                disabled={
                  !online ||
                  rows.isFetching ||
                  BigInt(rows.data.start) + BigInt(rows.data.data.length) >=
                    BigInt(rows.data.recordsFiltered) ||
                  rows.data.start > Number.MAX_SAFE_INTEGER - length
                }
                onClick={() => setStart(rows.data.start + length)}
              >
                Next activity page
              </button>
            </div>
          </>
        )}
      </section>
    </>
  );
}
