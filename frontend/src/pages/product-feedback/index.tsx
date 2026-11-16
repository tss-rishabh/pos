import { useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import type { Principal } from '../../api/types';
import { ApiError } from '../../api/client';
import { ErrorState, Loading } from '../../components/common';
import {
  feedbackInput,
  feedbackScope,
  readProductFeedback,
  saveProductFeedback,
  type FeedbackInput,
  type FeedbackScope,
  type FeedbackWorkspace,
} from './client';
import './style.css';

const options = [
  ['overall', 'Overall rating'],
  ['fit', 'Product fit'],
  ['size', 'Product size'],
  ['quality', 'Product quality'],
] as const;
const labels = new Map([
  ['0', 'Overall rating'],
  ['1', 'Product fit'],
  ['2', 'Product size'],
  ['3', 'Product quality'],
]);
function ExistingRatings({ rows }: { rows: FeedbackWorkspace['items'][number]['feedback'] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Rating</th>
          <th>Score</th>
          <th>Platform</th>
          <th>Comment</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <th scope="row">
              {labels.get(row.optionId ?? '') ?? `Option ${row.optionId ?? 'unset'}`}
            </th>
            <td>{row.rating ?? '—'}</td>
            <td>{row.platform ?? '—'}</td>
            <td>{row.optionId === '0' ? row.comment || '—' : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
function RatingForm({
  item,
  version,
  disabled,
  submit,
}: {
  item: FeedbackWorkspace['items'][number];
  version: number;
  disabled: boolean;
  submit: (input: FeedbackInput) => Promise<void>;
}) {
  const [error, setError] = useState<Error | null>(null);
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    const data = new FormData(event.currentTarget);
    try {
      const number = (name: string) => (data.get(name) === '' ? undefined : Number(data.get(name)));
      const command = feedbackInput.parse({
        operationId: crypto.randomUUID(),
        expectedVersion: version,
        productId: item.productId,
        overall: number('overall'),
        fit: number('fit'),
        size: number('size'),
        quality: number('quality'),
        comment: data.get('comment'),
      });
      setError(null);
      await submit(command);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error('Check the product feedback.'));
    }
  }
  return (
    <form onSubmit={(event) => void onSubmit(event)}>
      <fieldset disabled={disabled}>
        <legend>Add product feedback</legend>
        <div className="product-feedback-ratings">
          {options.map(([name, label]) => (
            <label key={name}>
              {label}
              <input
                type="number"
                name={name}
                required={name === 'overall'}
                min="0"
                max="5"
                step="0.1"
                placeholder={name === 'overall' ? 'Required' : '0'}
                aria-label={`${label} for line ${item.lineId}`}
              />
            </label>
          ))}
        </div>
        <label>
          Comment
          <textarea
            name="comment"
            maxLength={255}
            rows={3}
            aria-label={`Comment for line ${item.lineId}`}
          />
        </label>
        <p className="caption">
          Optional ratings default to 0. Comments are saved with the overall rating.
        </p>
        {error && <ErrorState error={error} />}
        <button type="submit" className="button primary">
          Save feedback
        </button>
      </fieldset>
    </form>
  );
}

export function ProductFeedbackPage({
  user,
  storeId,
  online,
}: {
  user: Principal;
  storeId: string;
  online: boolean;
}) {
  const params = useParams();
  const scope = feedbackScope.safeParse({ operatorId: user.id, ...params });
  if (!scope.success || scope.data.storeId !== storeId)
    return (
      <ErrorState
        error={new Error('Open product feedback from the customer history in your current store.')}
      />
    );
  return (
    <ProductFeedbackWorkspace
      key={Object.values(scope.data).join(':')}
      scope={scope.data}
      online={online}
    />
  );
}
export function ProductFeedbackWorkspace({
  scope,
  online,
}: {
  scope: FeedbackScope;
  online: boolean;
}) {
  const [cursors, setCursors] = useState<string[]>([]);
  const [intent, setIntent] = useState<{ input: FeedbackInput; retryReady: boolean } | null>(null);
  const intentRef = useRef<typeof intent>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failure, setFailure] = useState<Error | null>(null);
  const [saved, setSaved] = useState<ReadonlySet<string>>(new Set());
  const after = cursors.at(-1);
  const query = useQuery({
    queryKey: [
      scope.operatorId,
      'product-feedback',
      scope.storeId,
      scope.checkoutId,
      scope.customerId,
      scope.orderId,
      after,
    ],
    enabled: online,
    gcTime: 0,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: ({ signal }) => readProductFeedback(scope, after, signal),
  });
  function updateIntent(value: typeof intent) {
    intentRef.current = value;
    setIntent(value);
  }
  async function execute(input: FeedbackInput, reconcile: boolean) {
    if (busyRef.current || !online) return;
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    setMessage('');
    try {
      await saveProductFeedback(scope, input, reconcile);
      setSaved((current) => new Set([...current, input.productId]));
      updateIntent(null);
      setMessage('Product feedback saved.');
      void query.refetch();
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error('Could not save product feedback.');
      if (reconcile && error instanceof ApiError && error.status === 404) {
        updateIntent({ input, retryReady: true });
        setMessage('No saved submission was found. Retry the same feedback below.');
      } else if (
        !reconcile &&
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500
      ) {
        updateIntent(null);
        setFailure(error);
        if (error.code === 'PRODUCT_FEEDBACK_ALREADY_EXISTS') void query.refetch();
      } else {
        updateIntent({ input, retryReady: false });
        setFailure(error);
        setMessage('The result is unknown. Check this submission before trying again.');
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function submit(input: FeedbackInput) {
    if (intentRef.current || busyRef.current || !online) return;
    updateIntent({ input, retryReady: false });
    await execute(input, false);
  }
  return (
    <main className="product-feedback-page">
      <div className="page-title">
        <div>
          <p className="eyebrow">Customer history</p>
          <h1>Product feedback</h1>
          <p>Order {scope.orderId}</p>
        </div>
        <Link className="button secondary" to="/">
          Back to counter
        </Link>
      </div>
      {!online ? (
        <p role="status">Connect to view and save product feedback.</p>
      ) : (
        <>
          {message && <p role="status">{message}</p>}
          {failure && <ErrorState error={failure} />}
          {intent && (
            <section className="product-feedback-pending" aria-label="Pending feedback">
              <p>Submission {intent.input.operationId}</p>
              <button
                className="button secondary"
                type="button"
                disabled={busy}
                onClick={() => void execute(intent.input, !intent.retryReady)}
              >
                {busy
                  ? 'Checking…'
                  : intent.retryReady
                    ? 'Retry saved feedback'
                    : 'Check submission'}
              </button>
            </section>
          )}
          {query.isPending || query.isFetching ? (
            <Loading />
          ) : query.isError ? (
            <ErrorState error={query.error} retry={() => void query.refetch()} />
          ) : (
            query.data && (
              <>
                <p>
                  Order amount{' '}
                  {new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(
                    query.data.orderAmount,
                  )}
                </p>
                {!query.data.editable && (
                  <p role="status">
                    Existing feedback is available to view. New feedback requires a delivered order
                    and an editable sale.
                  </p>
                )}
                {!query.data.items.length && <p>No products were recorded for this order.</p>}
                {query.data.items.map((item) => (
                  <section
                    key={item.lineId}
                    className="product-feedback-item"
                    aria-label={`Feedback for line ${item.lineId}`}
                  >
                    <h2>{item.name}</h2>
                    <p className="caption">
                      Product {item.productId} · Line {item.lineId}
                    </p>
                    {item.feedback.length ? (
                      <ExistingRatings rows={item.feedback} />
                    ) : saved.has(item.productId) ? (
                      <p role="status">Feedback saved for this product.</p>
                    ) : query.data.editable ? (
                      <RatingForm
                        item={item}
                        version={query.data.checkoutVersion}
                        disabled={Boolean(intent) || busy}
                        submit={submit}
                      />
                    ) : (
                      <p>No feedback recorded.</p>
                    )}
                  </section>
                ))}
                <div className="toolbar">
                  <button
                    type="button"
                    className="button secondary"
                    disabled={!cursors.length || busy || Boolean(intent)}
                    onClick={() => setCursors(cursors.slice(0, -1))}
                  >
                    Previous products
                  </button>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={!query.data.nextCursor || busy || Boolean(intent)}
                    onClick={() => {
                      if (query.data?.nextCursor) setCursors([...cursors, query.data.nextCursor]);
                    }}
                  >
                    Next products
                  </button>
                </div>
              </>
            )
          )}
        </>
      )}
    </main>
  );
}
