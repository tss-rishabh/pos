import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Principal } from '../../api/types';
import { ApiError, captureOperatorScope, request } from '../../api/client';
import { PageTitle, RequestReference, useProblem } from '../../components/common';
import { currency } from '../../lib/format';
import {
  cancelVoucherIntent,
  createVoucherIssuance,
  readVoucherOperation,
  voucherCapabilitySchema,
  voucherSelectionSchema,
  type VoucherReceipt,
  type VoucherSelection,
} from './api';
import { voucherJournal, type VoucherIntent } from './journal';
import { GlobalVoucherReceipt } from './receipt';
import './style.css';

export default function GlobalVouchersPage({ user, online }: { user: Principal; online: boolean }) {
  return <VoucherIssuer key={user.id} user={user} online={online} />;
}
function VoucherIssuer({ user, online }: { user: Principal; online: boolean }) {
  const [email, setEmail] = useState(''),
    [amount, setAmount] = useState(''),
    [selection, setSelection] = useState<VoucherSelection | null>(null),
    [capabilities, setCapabilities] = useState<{ enabled: true } | null>(null),
    [intent, setIntent] = useState<VoucherIntent | null>(null),
    [receipt, setReceipt] = useState<VoucherReceipt | null>(null),
    [busy, setBusy] = useState(false),
    [problem, setProblem, problemCause, reportProblem] = useProblem(),
    [absent, setAbsent] = useState(false),
    [review, setReview] = useState(false);
  const journal = useRef(voucherJournal('pos-voucher-issuance:' + user.id)),
    lifetime = useRef(new AbortController()),
    running = useRef(false);
  // core/views.py:1175-1176: roles 1-3, franchise operators (user_type 2) excluded.
  const allowed = user.userType !== 2 && [1, 2, 3].includes(user.role);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    try {
      const saved = journal.current.read();
      if (saved && saved.operatorId === user.id && saved.kind === 'issuance') setIntent(saved);
    } catch {
      setProblem('The saved voucher reference requires review.');
    }
    return () => controller.abort();
  }, [user.id]);
  useEffect(() => {
    if (!online || !allowed) return;
    const signal = AbortSignal.any([captureOperatorScope(user.id), lifetime.current.signal]);
    void request(
      '/api/v1/gift-vouchers/capabilities',
      { signal, operatorId: user.id },
      voucherCapabilitySchema,
    )
      .then((value) => {
        if (!signal.aborted) setCapabilities(value);
      })
      .catch((error: unknown) => {
        if (!signal.aborted) reportProblem(error, 'Gift vouchers are unavailable.');
      });
  }, [user.id, online, allowed]);
  async function act(task: (signal: AbortSignal) => Promise<void>) {
    if (running.current || !online) return;
    const signal = AbortSignal.any([captureOperatorScope(user.id), lifetime.current.signal]);
    running.current = true;
    setBusy(true);
    setProblem('');
    try {
      await task(signal);
    } catch (error) {
      if (!signal.aborted) reportProblem(error, 'The voucher outcome needs confirmation.');
    } finally {
      running.current = false;
      if (!signal.aborted) setBusy(false);
    }
  }
  async function lookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSelection(null);
    setReview(false);
    await act(async (signal) => {
      const value = await request(
        '/api/v1/gift-voucher-customer-lookups',
        { method: 'POST', body: JSON.stringify({ email }), operatorId: user.id, signal },
        voucherSelectionSchema,
      );
      signal.throwIfAborted();
      setSelection(value);
    });
  }
  async function send(saved?: VoucherIntent) {
    await act(async (signal) => {
      let command = saved;
      if (!command) {
        if (!selection || selection.expiresAt <= Date.now())
          throw new Error('Look up the customer again before issuing a voucher.');
        command = {
          kind: 'issuance',
          operatorId: user.id,
          operationId: crypto.randomUUID(),
          selectionId: selection.selectionId,
          amount,
        };
        signal.throwIfAborted();
        journal.current.save(command);
        setIntent(command);
        setReview(false);
      }
      if (command.kind !== 'issuance')
        throw new Error('The saved voucher reference does not match.');
      setAbsent(false);
      const value = await createVoucherIssuance(
        user.id,
        {
          operationId: command.operationId,
          selectionId: command.selectionId,
          amount: command.amount,
        },
        signal,
      );
      signal.throwIfAborted();
      setReceipt(value);
      setEmail('');
      setSelection(null);
    });
  }
  async function recover() {
    if (!intent) return;
    await act(async (signal) => {
      try {
        const result = await readVoucherOperation(user.id, intent.operationId, signal);
        signal.throwIfAborted();
        if (result.status === 'succeeded') setReceipt(result.receipt);
        else {
          journal.current.clear();
          setIntent(null);
          setSelection(null);
          setReview(false);
        }
        setAbsent(false);
      } catch (error) {
        if (error instanceof ApiError && error.code === 'GLOBAL_VOUCHER_OPERATION_NOT_FOUND') {
          setAbsent(true);
          return;
        }
        throw error;
      }
    });
  }
  async function cancel() {
    if (!intent || intent.kind !== 'issuance') return;
    await act(async (signal) => {
      const result = await cancelVoucherIntent(
        user.id,
        intent.operationId,
        { kind: 'issuance', selectionId: intent.selectionId },
        signal,
      );
      signal.throwIfAborted();
      if (result.status === 'succeeded') setReceipt(result.receipt);
      else {
        journal.current.clear();
        setIntent(null);
        setSelection(null);
        setReview(false);
        setAbsent(false);
      }
    });
  }
  if (!allowed)
    return <p role="alert">Gift voucher issuance requires an internal administrator.</p>;
  return (
    <div className="global-vouchers">
      <PageTitle eyebrow="Administration" title="Gift vouchers">
        <p>Issue a non-expiring gift voucher to a customer by email.</p>
      </PageTitle>
      {!online && <p role="status">Connect to issue a voucher or check its original outcome.</p>}
      {problem && (
        <p className="inline-error" role="alert">
          {problem}
        </p>
      )}
      {problem && <RequestReference error={problemCause} />}
      {receipt && <GlobalVoucherReceipt receipt={receipt} />}
      {intent ? (
        <section className="global-voucher-card">
          <h2>{receipt ? 'Voucher confirmed' : 'Check the saved voucher operation'}</h2>
          <p>
            Operation <code>{intent.operationId}</code>
          </p>
          {!receipt && (
            <p>
              Check the original reference before retrying. Checking never creates another voucher.
            </p>
          )}
          <div className="global-voucher-actions">
            <button
              className="button secondary"
              disabled={!online || busy}
              onClick={() => void recover()}
            >
              Check voucher status
            </button>
            {absent && !receipt && (
              <button
                className="button primary"
                disabled={!online || busy || !capabilities?.enabled}
                onClick={() => void send(intent)}
              >
                Retry original issuance
              </button>
            )}
            {!receipt && (
              <button
                className="button secondary"
                disabled={!online || busy}
                onClick={() => void cancel()}
              >
                Stop original issuance
              </button>
            )}
            {receipt && (
              <button
                className="button primary"
                disabled={busy}
                onClick={() => {
                  journal.current.clear();
                  setIntent(null);
                  setReceipt(null);
                  setAmount('');
                  setReview(false);
                }}
              >
                New voucher
              </button>
            )}
          </div>
        </section>
      ) : (
        <section className="global-voucher-card">
          <h2>{review ? 'Review voucher' : 'Customer and value'}</h2>
          <form onSubmit={(event) => void lookup(event)}>
            <label>
              Customer email
              <input
                type="email"
                autoComplete="off"
                required
                maxLength={96}
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setSelection(null);
                  setReview(false);
                }}
                disabled={busy || review}
              />
            </label>
            <button
              className="button secondary"
              type="submit"
              disabled={busy || !online || !capabilities?.enabled || review}
            >
              Find customer
            </button>
          </form>
          {selection && (
            <>
              <p>
                {selection.name} · Customer {selection.customerId}
              </p>
              <label>
                Voucher amount
                <input
                  inputMode="decimal"
                  aria-label="Voucher amount"
                  value={amount}
                  onChange={(event) => {
                    setAmount(event.target.value);
                    setReview(false);
                  }}
                  disabled={busy || review}
                />
              </label>
              <p>Won’t expire</p>
              {review ? (
                <>
                  <p>Issue {currency(amount)} to the confirmed customer?</p>
                  <div className="global-voucher-actions">
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => setReview(false)}
                    >
                      Edit
                    </button>
                    <button
                      className="button primary"
                      disabled={!online || busy || !capabilities?.enabled}
                      onClick={() => void send()}
                    >
                      Confirm voucher issuance
                    </button>
                  </div>
                </>
              ) : (
                <button
                  className="button primary"
                  disabled={
                    busy ||
                    !online ||
                    !/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(amount) ||
                    Number(amount) <= 0 ||
                    Number(amount) > 99999999
                  }
                  onClick={() => setReview(true)}
                >
                  Review voucher
                </button>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}
