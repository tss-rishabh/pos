import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { z } from 'zod';
import { request } from '../../api/client';
import type { Principal } from '../../api/types';
import { Empty, ErrorState, Loading, PageTitle } from '../../components/common';
import './style.css';
const responseSchema = z.object({
  reader: z.enum(['data', 'bigquery', 'primary']),
  data: z.array(
    z.object({
      order_id: z.string(),
      storeId: z.string().nullable(),
      name: z.string().nullable(),
      email: z.string().nullable(),
      telephone: z.string().nullable(),
      feedback: z.union([z.string(), z.number(), z.null()]),
      question: z.string().nullable(),
      store_name: z.string(),
      feedback_date: z.string().nullable(),
      order_date: z.string(),
    }),
  ),
  total: z.number(),
  page: z.number(),
  totalPages: z.number(),
});
interface Filters {
  from: string;
  to: string;
  stores: string[];
  orderIds: string;
  email: string;
}
const today = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
export function CustomerFeedbackPage({ user, storeId }: { user: Principal; storeId: string }) {
  const [filters, setFilters] = useState<Filters>(() => ({
      from: today() + 'T00:00:00',
      to: today() + 'T23:59:59',
      stores: storeId ? [storeId] : [],
      orderIds: '',
      email: '',
    })),
    [submitted, setSubmitted] = useState<Filters | null>(null),
    [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(25),
    [searchId, setSearchId] = useState(0);
  const stores = useQuery({
    queryKey: [user.id, 'finance-cash-ledger-stores'],
    queryFn: () =>
      request(
        '/api/v1/reports/store-cash-balances/stores',
        { operatorId: user.id },
        z.object({ data: z.array(z.object({ id: z.string(), name: z.string() })) }),
      ),
  });
  const report = useQuery({
    queryKey: [user.id, 'customer-feedback', submitted, page, pageSize, searchId],
    enabled: submitted !== null,
    queryFn: () =>
      request(
        '/api/v1/reports/customer-feedback/search',
        {
          method: 'POST',
          operatorId: user.id,
          body: JSON.stringify({
            from: submitted!.from,
            to: submitted!.to,
            storeIds: submitted!.stores,
            ...(submitted!.orderIds.trim()
              ? { orderIds: submitted!.orderIds.split(',').map((id) => id.trim()) }
              : {}),
            ...(submitted!.email.trim() ? { email: submitted!.email.trim() } : {}),
            page,
            pageSize,
          }),
        },
        responseSchema,
      ),
    retry: false,
  });
  const update = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    setFilters((current) => ({ ...current, [key]: value }));
  return (
    <>
      <PageTitle eyebrow="LISTEN TO THE CUSTOMER" title="Customer feedback" />
      <form
        className="surface operational-report-filters"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted({ ...filters });
          setPage(1);
          setSearchId((value) => value + 1);
        }}
      >
        <label>
          Orders from
          <input
            type="datetime-local"
            step="1"
            required
            value={filters.from}
            onChange={(event) => update('from', event.target.value)}
          />
        </label>
        <label>
          Orders to
          <input
            type="datetime-local"
            step="1"
            required
            min={filters.from}
            value={filters.to}
            onChange={(event) => update('to', event.target.value)}
          />
        </label>
        <label>
          Stores
          <select
            multiple
            value={filters.stores}
            onChange={(event) =>
              update(
                'stores',
                Array.from(event.target.selectedOptions, (option) => option.value),
              )
            }
          >
            {stores.data?.data.map((store) => (
              <option key={store.id} value={store.id}>
                {store.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Order IDs
          <input
            value={filters.orderIds}
            onChange={(event) => update('orderIds', event.target.value)}
            placeholder="1001, 1002"
            maxLength={10000}
          />
        </label>
        <label>
          Customer email
          <input
            type="email"
            autoComplete="off"
            value={filters.email}
            onChange={(event) => update('email', event.target.value)}
            maxLength={254}
          />
        </label>
        <button
          className="button primary"
          disabled={report.isFetching || (user.userType === 2 && !filters.stores.length)}
        >
          <Search size={16} />
          Search feedback
        </button>
      </form>
      {user.userType === 2 && (
        <p className="muted">
          Customer names and contact details are masked. Select at least one store.
        </p>
      )}
      {report.data?.reader === 'bigquery' && (
        <p className="muted">
          Historical feedback can lag recent changes. Customer and question details show their
          current values.
        </p>
      )}
      {stores.isError && <ErrorState error={stores.error} />}{' '}
      {!submitted ? (
        <Empty title="What customers are telling us">
          Choose the order window and stores to view feedback.
        </Empty>
      ) : report.isPending ? (
        <Loading />
      ) : report.isError ? (
        <ErrorState error={report.error} retry={() => void report.refetch()} />
      ) : report.data.data.length === 0 ? (
        <Empty title="No matching feedback">
          Adjust the order window, store, or email filters.
        </Empty>
      ) : (
        <>
          <div className="surface operational-report-table">
            <table>
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Store</th>
                  <th>Customer</th>
                  <th>Email</th>
                  <th>Telephone</th>
                  <th>Question</th>
                  <th>Feedback</th>
                  <th>Feedback date</th>
                  <th>Order date</th>
                </tr>
              </thead>
              <tbody>
                {report.data.data.map((row, index) => (
                  <tr key={`${row.order_id}:${row.storeId}:${row.feedback_date}:${index}`}>
                    <td>{row.order_id}</td>
                    <td>{row.store_name}</td>
                    <td>{row.name || '—'}</td>
                    <td>{row.email || '—'}</td>
                    <td>{row.telephone || '—'}</td>
                    <td>{row.question || '—'}</td>
                    <td>{row.feedback ?? '—'}</td>
                    <td>{row.feedback_date || '—'}</td>
                    <td>{row.order_date}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="operational-report-pagination">
            <button
              className="button secondary"
              disabled={report.data.page <= 1}
              onClick={() => setPage(report.data.page - 1)}
            >
              Previous
            </button>
            <span>
              {report.data.total} response(s) · Page {report.data.page} of {report.data.totalPages}
            </span>
            <label>
              Rows
              <select
                value={pageSize}
                onChange={(event) => {
                  setPageSize(Number(event.target.value));
                  setPage(1);
                }}
              >
                {[10, 25, 50, 100, 500].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <button
              className="button secondary"
              disabled={report.data.page >= report.data.totalPages}
              onClick={() => setPage(report.data.page + 1)}
            >
              Next
            </button>
          </div>
        </>
      )}
    </>
  );
}
