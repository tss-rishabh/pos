import { useEffect, useRef, useState } from 'react';
import { liveQuery } from 'dexie';
import type { z } from 'zod';
import type { Principal } from '../../../api/types';
import { captureOperatorScope } from '../../../api/client';
import { PageTitle, RequestReference, useProblem } from '../../../components/common';
import { currency } from '../../../lib/format';
import {
  activeWalletCommand,
  beginNewWalletAdjustment,
  dispatchWalletAdjustment,
  prepareWalletAdjustment,
  refreshWalletAdjustment,
} from '../../../offline/benefits/commands';
import { lookupWalletCustomer, readWalletCapabilities } from '../../../offline/benefits/client';
import {
  walletAdjustmentSchema,
  walletCustomerSchema,
  type WalletAdjustmentInput,
} from '../../../offline/benefits/contracts';
import { benefitReasons, moneyPlatforms, pointPlatforms } from '../../../offline/benefits/fields';
import type { WalletCommand } from '../../../offline/benefits/storage';
import './styles.css';

type Review = { input: Omit<WalletAdjustmentInput, 'operationId'>; customerName: string };
export function GlobalBenefitAdjustmentsPage({
  user,
  online,
}: {
  user: Principal;
  online: boolean;
}) {
  const [current, setCurrent] = useState<WalletCommand | null>(null),
    [enabled, setEnabled] = useState(false),
    [busy, setBusy] = useState(false),
    [problem, setProblem, problemCause, reportProblem] = useProblem(),
    [email, setEmail] = useState(''),
    [customer, setCustomer] = useState<z.infer<typeof walletCustomerSchema> | null>(null),
    [asset, setAsset] = useState<'money' | 'points'>('money'),
    [direction, setDirection] = useState<'add' | 'subtract'>('add'),
    [amount, setAmount] = useState(''),
    [platform, setPlatform] = useState('ORDER_REFUND'),
    [reason, setReason] = useState('Other'),
    [expiry, setExpiry] = useState(''),
    [orderId, setOrderId] = useState('0'),
    [productId, setProductId] = useState('0'),
    [review, setReview] = useState<Review | null>(null),
    [now, setNow] = useState(Date.now);
  const lookupVersion = useRef(0),
    allowed = [1, 2, 3].includes(user.role) && user.userType === 1;
  useEffect(() => {
    if (!allowed) return;
    const signal = captureOperatorScope(user.id),
      subscription = liveQuery(() => activeWalletCommand(user, { signal })).subscribe({
        next: setCurrent,
        error: () => setProblem('The saved wallet workspace needs reconciliation.'),
      });
    return () => subscription.unsubscribe();
  }, [user, allowed]);
  useEffect(() => {
    if (!allowed || !online) return;
    const signal = captureOperatorScope(user.id);
    void readWalletCapabilities(user.id)
      .then((value) => {
        if (!signal.aborted) setEnabled(value.enabled);
      })
      .catch((error: unknown) => {
        if (!signal.aborted) reportProblem(error, 'Wallet adjustments are unavailable.');
      });
  }, [user, online, allowed]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!allowed || !online || !current || !['dispatching', 'uncertain'].includes(current.state))
      return;
    const signal = captureOperatorScope(user.id),
      id = current.id;
    const refresh = () =>
      void refreshWalletAdjustment(user, id, { signal }).catch((error: unknown) => {
        if (!signal.aborted) reportProblem(error, 'The saved wallet outcome needs confirmation.');
      });
    refresh();
    const timer = setInterval(refresh, 30000);
    return () => clearInterval(timer);
  }, [user, online, allowed, current?.id, current?.state]);

  async function lookup() {
    if (busy || !online) return;
    const signal = captureOperatorScope(user.id),
      version = ++lookupVersion.current;
    setBusy(true);
    setProblem('');
    setCustomer(null);
    try {
      const value = await lookupWalletCustomer(user.id, email);
      signal.throwIfAborted();
      if (version === lookupVersion.current) setCustomer(value);
    } catch (error) {
      if (!signal.aborted) reportProblem(error, 'Customer lookup was not confirmed.');
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  function inspect() {
    if (!customer) return;
    const parsed = walletAdjustmentSchema.safeParse({
      operationId: crypto.randomUUID(),
      customerId: customer.id,
      adjustment: {
        asset,
        direction,
        amount,
        platform,
        reason,
        expiry: expiry || null,
        orderId,
        productId,
      },
    });
    if (!parsed.success) {
      setProblem(parsed.error.issues[0]?.message || 'Check the adjustment fields.');
      return;
    }
    setProblem('');
    setReview({
      input: { customerId: parsed.data.customerId, adjustment: parsed.data.adjustment },
      customerName: customer.name,
    });
  }
  async function confirm() {
    if (!review || busy || !enabled || !online) return;
    const signal = captureOperatorScope(user.id);
    setBusy(true);
    setProblem('');
    try {
      const command = await prepareWalletAdjustment(user, review.input, { signal });
      signal.throwIfAborted();
      setReview(null);
      await dispatchWalletAdjustment(user, command.id, { signal });
    } catch (error) {
      if (!signal.aborted) reportProblem(error, 'The adjustment outcome needs confirmation.');
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  async function recover(action: 'check' | 'send' | 'retry' | 'new') {
    if (!current || busy) return;
    const signal = captureOperatorScope(user.id),
      id = current.id;
    setBusy(true);
    setProblem('');
    try {
      if (action === 'new') {
        // Reset before publishing the empty pointer, so a late continuation
        // cannot wipe inputs already entered in the newly visible form.
        lookupVersion.current++;
        setCustomer(null);
        setEmail('');
        setAmount('');
        setReview(null);
        setAsset('money');
        setDirection('add');
        setPlatform('ORDER_REFUND');
        setReason('Other');
        setExpiry('');
        setOrderId('0');
        setProductId('0');
        await beginNewWalletAdjustment(user, id, { signal });
      } else if (action === 'check') {
        const result = await refreshWalletAdjustment(user, id, { signal });
        if (!result && !signal.aborted)
          setProblem(
            'The server outcome is not yet confirmed. Keep this saved adjustment for reconciliation.',
          );
      } else await dispatchWalletAdjustment(user, id, { signal }, action === 'retry');
    } catch (error) {
      if (!signal.aborted) reportProblem(error, 'The saved adjustment outcome needs confirmation.');
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  if (!allowed)
    return (
      <p role="alert">Global benefit administration requires a current internal administrator.</p>
    );
  return (
    <>
      <PageTitle eyebrow="Customer benefits" title="Wallet adjustments" />
      <p>
        Review the customer, amount and earning details before applying an adjustment. Cashback is
        preserved.
      </p>
      {!online && (
        <p role="status">Reconnect before looking up customers or sending a wallet adjustment.</p>
      )}
      {!enabled && online && (
        <p role="status">
          Wallet adjustments have not been enabled for this workspace. Saved outcomes can still be
          checked.
        </p>
      )}
      {problem && (
        <p role="alert" className="inline-error">
          {problem}
        </p>
      )}
      {problem && <RequestReference error={problemCause} />}
      {current ? (
        <section className="wallet-adjustment-card" aria-label="Saved wallet adjustment">
          <h2>
            {current.state === 'completed'
              ? 'Wallet adjustment confirmed'
              : 'Saved wallet adjustment'}
          </h2>
          <dl className="wallet-adjustment-summary">
            <dt>Customer</dt>
            <dd>{current.request.customerId}</dd>
            <dt>Wallet</dt>
            <dd>{current.request.adjustment.asset === 'money' ? 'TSS Money' : 'TSS Points'}</dd>
            <dt>Operation</dt>
            <dd>
              {current.request.adjustment.direction === 'add' ? 'Add' : 'Subtract'}{' '}
              {currency(current.request.adjustment.amount)}
            </dd>
            <dt>Platform</dt>
            <dd>{current.request.adjustment.platform}</dd>
            <dt>Reason</dt>
            <dd>{current.request.adjustment.reason}</dd>
            <dt>Expiry</dt>
            <dd>{current.request.adjustment.expiry || 'No earning expiry'}</dd>
            <dt>Reference</dt>
            <dd>
              <code>{current.id}</code>
            </dd>
            {current.receipt && (
              <>
                <dt>Balance before</dt>
                <dd>{currency(current.receipt.balanceBefore)}</dd>
                <dt>Balance after</dt>
                <dd>{currency(current.receipt.balanceAfter)}</dd>
                <dt>Confirmed at</dt>
                <dd>{current.receipt.createdAt}</dd>
              </>
            )}
          </dl>
          {current.state !== 'completed' && (
            <p role="status">
              {current.state === 'prepared'
                ? 'This exact adjustment is saved and ready to send.'
                : 'The saved adjustment is awaiting confirmation. Check its status before explicitly retrying it.'}
            </p>
          )}
          <div className="wallet-adjustment-actions">
            <button
              className="button secondary"
              disabled={!online || busy}
              onClick={() => void recover('check')}
            >
              Check wallet adjustment status
            </button>
            {current.state === 'prepared' && (
              <button
                className="button primary"
                disabled={!online || !enabled || busy}
                onClick={() => void recover('send')}
              >
                Send saved wallet adjustment
              </button>
            )}
            {(current.state === 'uncertain' ||
              (current.state === 'dispatching' && (current.claimedAt || 0) + 30000 <= now)) && (
              <button
                className="button primary"
                disabled={!online || !enabled || busy}
                onClick={() => void recover('retry')}
              >
                Retry saved wallet adjustment
              </button>
            )}
            {current.state === 'completed' && (
              <button
                className="button primary"
                disabled={busy}
                onClick={() => void recover('new')}
              >
                New wallet adjustment
              </button>
            )}
          </div>
        </section>
      ) : review ? (
        <section className="wallet-adjustment-card" aria-label="Review wallet adjustment">
          <h2>Review wallet adjustment</h2>
          <p>
            {review.customerName} · Customer {review.input.customerId}
          </p>
          <p>
            {review.input.adjustment.direction === 'add' ? 'Add' : 'Subtract'}{' '}
            {currency(review.input.adjustment.amount)}{' '}
            {review.input.adjustment.asset === 'money' ? 'TSS Money' : 'TSS Points'}
          </p>
          <p>
            {review.input.adjustment.platform} · {review.input.adjustment.reason} · Expiry{' '}
            {review.input.adjustment.expiry || 'none'}
          </p>
          <div className="wallet-adjustment-actions">
            <button className="button secondary" disabled={busy} onClick={() => setReview(null)}>
              Edit adjustment
            </button>
            <button
              className="button primary"
              disabled={!enabled || !online || busy}
              onClick={() => void confirm()}
            >
              Confirm wallet adjustment
            </button>
          </div>
        </section>
      ) : (
        <section className="wallet-adjustment-card" aria-label="New wallet adjustment">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void lookup();
            }}
            className="wallet-adjustment-form"
          >
            <label>
              Customer email
              <input
                type="email"
                value={email}
                maxLength={96}
                required
                disabled={busy || !online}
                onChange={(event) => {
                  lookupVersion.current++;
                  setEmail(event.target.value);
                  setCustomer(null);
                }}
              />
            </label>
            <button className="button secondary" disabled={busy || !online || !email}>
              Find benefit customer
            </button>
          </form>
          {customer && (
            <>
              <p role="status">
                {customer.name} · Customer {customer.id} · TSS Money {currency(customer.money)} ·
                TSS Points {currency(customer.points)}
              </p>
              <form
                className="wallet-adjustment-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  inspect();
                }}
              >
                <label>
                  Benefit wallet
                  <select
                    value={asset}
                    onChange={(event) => {
                      setAsset(event.target.value === 'points' ? 'points' : 'money');
                      setPlatform('ORDER_REFUND');
                    }}
                  >
                    <option value="money">TSS Money</option>
                    <option value="points">TSS Points</option>
                  </select>
                </label>
                <label>
                  Adjustment operation
                  <select
                    value={direction}
                    onChange={(event) =>
                      setDirection(event.target.value === 'subtract' ? 'subtract' : 'add')
                    }
                  >
                    <option value="add">Add</option>
                    <option value="subtract">Subtract</option>
                  </select>
                </label>
                <label>
                  Adjustment amount
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    max="99999"
                    required
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                  />
                </label>
                <label>
                  Benefit platform
                  <select value={platform} onChange={(event) => setPlatform(event.target.value)}>
                    {(asset === 'money' ? moneyPlatforms : pointPlatforms).map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                    {asset === 'points' && (
                      <option disabled value="DONATION_POINTS">
                        DONATION_POINTS · unavailable
                      </option>
                    )}
                  </select>
                </label>
                <label>
                  Adjustment reason
                  <select value={reason} onChange={(event) => setReason(event.target.value)}>
                    {benefitReasons.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Earning expiry
                  <input
                    type="date"
                    required={direction === 'add'}
                    value={expiry}
                    onChange={(event) => setExpiry(event.target.value)}
                  />
                </label>
                <label>
                  Related order ID
                  <input
                    inputMode="numeric"
                    value={orderId}
                    onChange={(event) => setOrderId(event.target.value)}
                    required
                  />
                </label>
                <label>
                  Related product ID
                  <input
                    inputMode="numeric"
                    value={productId}
                    onChange={(event) => setProductId(event.target.value)}
                    required
                  />
                </label>
                <button className="button primary" disabled={busy || !online || !enabled}>
                  Review wallet adjustment
                </button>
              </form>
            </>
          )}
        </section>
      )}
    </>
  );
}
