import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { currency } from '../../lib/format';
import { Loader } from '../../components/loader';
import { readDiscountApproval, type Checkout, type CheckoutReply } from './client';

export function DiscountApproval({
  checkout,
  disabled,
  mutate,
  act,
  onReady,
}: {
  checkout: Checkout;
  disabled: boolean;
  mutate: (
    path: string,
    method: 'POST' | 'PUT',
    body?: Record<string, unknown>,
  ) => Promise<CheckoutReply>;
  act: (task: () => Promise<void>) => Promise<void>;
  onReady: (version: number, ready: boolean) => void;
}) {
  const [code, setCode] = useState(''),
    [sent, setSent] = useState('');
  const approval = useQuery({
    queryKey: ['checkout-discount-approval', checkout.storeId, checkout.id, checkout.version],
    queryFn: () => readDiscountApproval(checkout),
    retry: false,
  });
  const ready = Boolean(
    approval.data && ['not-required', 'approved'].includes(approval.data.status),
  );
  useEffect(() => onReady(checkout.version, ready), [checkout.version, ready, onReady]);
  if (approval.isPending) return <Loader inline label="Checking discount approval…" />;
  if (approval.error)
    return (
      <div className="inline-error">
        <p>{approval.error.message}</p>
        <button
          className="button secondary"
          disabled={disabled}
          onClick={() => void approval.refetch()}
        >
          Check discount approval
        </button>
      </div>
    );
  const value = approval.data;
  if (!value || value.status === 'not-required') return null;
  const request = () =>
    act(async () => {
      await mutate('discount-approval/challenges', 'POST');
      setSent('OTP Sent To Managers');
      await approval.refetch();
    });
  return (
    <section className="discount-approval" aria-label="Manager discount approval">
      <h3>Manager discount approval</h3>
      {sent && <p role="status">{sent}</p>}
      <p>
        {currency(value.amount)} discount ·{' '}
        {value.status === 'approved'
          ? 'Approved for this final quote.'
          : 'Approval is required before creating this order.'}
      </p>
      {value.status === 'approved' ? (
        <p role="status">
          Approval expires {value.expiresAt ? new Date(value.expiresAt).toLocaleTimeString() : ''}.
          A changed quote requires approval again.
        </p>
      ) : (
        <>
          {value.status === 'pending' && (
            <p role="status">
              {value.delivered > 0
                ? 'The manager code was sent.'
                : value.pending > 0
                  ? 'Manager email delivery is queued.'
                  : 'Delivery could not be confirmed. If a code arrives, it can still be verified.'}
            </p>
          )}
          {(value.status === 'locked' || value.status === 'expired') && (
            <p role="alert">
              {value.status === 'locked'
                ? 'Too many incorrect codes.'
                : 'The manager code expired.'}{' '}
              Request a new approval code.
            </p>
          )}
          {value.status === 'pending' ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const entered = code;
                setCode('');
                void act(async () => {
                  try {
                    await mutate('discount-approval/confirmations', 'POST', { code: entered });
                  } finally {
                    await approval.refetch();
                  }
                });
              }}
            >
              <label>
                Manager approval code
                <input
                  type="password"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  aria-label="Manager approval code"
                  pattern="[1-9]{6}"
                  maxLength={6}
                  required
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/[^1-9]/g, ''))}
                />
              </label>
              <button className="button secondary" disabled={disabled}>
                Verify manager approval
              </button>
            </form>
          ) : (
            <button
              className="button secondary"
              disabled={disabled || Boolean(value.retryAt && value.retryAt > Date.now())}
              onClick={() => void request()}
            >
              Request manager approval code
            </button>
          )}
          <button
            className="button secondary"
            disabled={disabled}
            onClick={() => void approval.refetch()}
          >
            Check approval status
          </button>
        </>
      )}
    </section>
  );
}
