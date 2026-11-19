import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { ApiError, captureOperatorScope, request } from '../../api/client';
import { RequestReference, useProblem } from '../../components/common';
import type { Checkout } from '../checkout/client';
import {
  checkVoucher,
  createVoucherConversion,
  readConversionOperation,
  type VoucherCheckResult,
} from './api';
import { voucherJournal, type VoucherIntent } from './journal';
import './style.css';

export interface GlobalVoucherConversionProps {
  user: { id: string };
  state: Checkout;
  online: boolean;
  disabled?: boolean;
  onPending: (pending: boolean) => void;
  onSaved: () => Promise<void>;
}
/**
 * Legacy "Check and Top-up Gift Voucher/Gift Card to TSS Money" (create_order.html:287-301,
 * 3786-4060), shown when ENABLE_VOUCHER_TO_MONEY_CHECK_AND_COVERT is on. The input is enabled
 * only for a verified customer.
 */
export function GlobalVoucherConversion(props: GlobalVoucherConversionProps) {
  const { user, state } = props;
  return (
    <ScopedVoucherConversion
      key={`${user.id}:${state.storeId}:${state.counterId}:${state.id}:${state.customerId}`}
      {...props}
    />
  );
}
type PinStep = { action: 'check' | 'convert'; message: string };
function ScopedVoucherConversion({
  user,
  state,
  online,
  disabled = false,
  onPending,
  onSaved,
}: GlobalVoucherConversionProps) {
  const [code, setCode] = useState(''),
    [pin, setPin] = useState(''),
    [enabled, setEnabled] = useState(false),
    [details, setDetails] = useState<VoucherCheckResult | null>(null),
    [confirming, setConfirming] = useState(false),
    [pinStep, setPinStep] = useState<PinStep | null>(null),
    [intent, setIntent] = useState<VoucherIntent | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [problem, setProblem, problemCause, reportProblem] = useProblem();
  const journal = useRef(
      voucherJournal(
        `pos-voucher-conversion:${user.id}:${state.storeId}:${state.counterId}:${state.id}:${state.customerId}`,
      ),
    ),
    lifetime = useRef(new AbortController()),
    active = useRef(false);
  const verified = Boolean(
    state.customerId && state.verifiedCustomerUntil && state.verifiedCustomerUntil > Date.now(),
  );
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    try {
      const saved = journal.current.read();
      if (
        saved &&
        saved.kind === 'conversion' &&
        saved.operatorId === user.id &&
        saved.checkoutId === state.id &&
        saved.customerId === state.customerId
      )
        setIntent(saved);
    } catch {
      setProblem('The saved top-up reference requires review.');
    }
    return () => {
      controller.abort();
      onPending(false);
    };
  }, [user.id, state.id, state.storeId, state.counterId, state.customerId]);
  useEffect(() => {
    onPending(busy || Boolean(intent));
  }, [busy, intent, onPending]);
  useEffect(() => {
    if (!online) return;
    const signal = AbortSignal.any([captureOperatorScope(user.id), lifetime.current.signal]);
    void request(
      `/api/v1/stores/${state.storeId}/checkout-sessions/${state.id}/voucher-conversions/capabilities`,
      { signal, operatorId: user.id },
      z.object({ enabled: z.boolean() }).strict(),
    )
      .then((result) => {
        if (!signal.aborted) setEnabled(result.enabled);
      })
      .catch(() => {
        if (!signal.aborted) setEnabled(false);
      });
  }, [user.id, state.storeId, state.id, online]);
  async function act(task: (signal: AbortSignal) => Promise<void>) {
    if (!online || active.current) return;
    const signal = AbortSignal.any([captureOperatorScope(user.id), lifetime.current.signal]);
    active.current = true;
    setBusy(true);
    setProblem('');
    setNotice('');
    try {
      await task(signal);
    } catch (error) {
      if (signal.aborted) return;
      if (
        error instanceof ApiError &&
        (error.code === 'GIFT_CARD_PIN_REQUIRED' || error.code === 'GIFT_CARD_PIN_INVALID')
      )
        return;
      reportProblem(error, 'The voucher request failed.');
    } finally {
      active.current = false;
      if (!signal.aborted) setBusy(false);
    }
  }
  /** Shows the PIN dialog for upstream `is_pin_required` and keeps it open on a wrong PIN. */
  function pinRequired(error: unknown, action: PinStep['action']) {
    if (error instanceof ApiError && error.code === 'GIFT_CARD_PIN_REQUIRED')
      setPinStep({ action, message: '' });
    else if (error instanceof ApiError && error.code === 'GIFT_CARD_PIN_INVALID')
      setPinStep({ action, message: error.message });
    throw error;
  }
  async function check(giftCardPin?: string) {
    const voucherCode = code.trim();
    await act(async (signal) => {
      setDetails(null);
      try {
        const result = await checkVoucher(
          user.id,
          state.storeId,
          state.id,
          { voucherCode, ...(giftCardPin ? { giftCardPin } : {}) },
          signal,
        );
        signal.throwIfAborted();
        setPinStep(null);
        setPin('');
        setDetails(result);
        setNotice(result.pinUsed ? 'Gift Card Data Fetched' : 'Gift Voucher Data Fetched');
      } catch (error) {
        pinRequired(error, 'check');
      }
    });
  }
  async function convert(giftCardPin?: string) {
    const voucherCode = code.trim();
    await act(async (signal) => {
      const command: VoucherIntent =
        intent && intent.kind === 'conversion'
          ? intent
          : {
              kind: 'conversion',
              operatorId: user.id,
              operationId: crypto.randomUUID(),
              storeId: state.storeId,
              checkoutId: state.id,
              customerId: state.customerId!,
            };
      if (command.kind !== 'conversion') return;
      journal.current.save(command);
      setIntent(command);
      try {
        const result = await createVoucherConversion(
          user.id,
          command.storeId,
          command.checkoutId,
          {
            operationId: command.operationId,
            voucherCode,
            ...(giftCardPin ? { giftCardPin } : {}),
          },
          signal,
        );
        signal.throwIfAborted();
        journal.current.clear();
        setIntent(null);
        setPinStep(null);
        setPin('');
        setCode('');
        setDetails(null);
        setNotice(result.message);
        // Legacy reloads the page after a top-up (create_order.html:3968-3970).
        await onSaved();
      } catch (error) {
        // A definite rejection released the operation; an uncertain one keeps it for review.
        if (
          error instanceof ApiError &&
          error.status < 500 &&
          error.code !== 'VOUCHER_OPERATION_UNCONFIRMED' &&
          error.code !== 'IDEMPOTENCY_CONFLICT'
        ) {
          journal.current.clear();
          setIntent(error.code.startsWith('GIFT_CARD_PIN') ? command : null);
          if (error.code.startsWith('GIFT_CARD_PIN')) journal.current.save(command);
        }
        pinRequired(error, 'convert');
      }
    });
  }
  async function recover() {
    if (!intent || intent.kind !== 'conversion') return;
    await act(async (signal) => {
      try {
        const result = await readConversionOperation(user.id, intent.operationId, signal);
        signal.throwIfAborted();
        journal.current.clear();
        setIntent(null);
        if (result.status === 'succeeded') {
          setNotice(result.receipt.message);
          await onSaved();
        }
      } catch (error) {
        if (error instanceof ApiError && error.code === 'GLOBAL_VOUCHER_OPERATION_NOT_FOUND') {
          // The top-up never reached the server; nothing was transferred.
          journal.current.clear();
          setIntent(null);
          return;
        }
        throw error;
      }
    });
  }
  if (!enabled && !intent) return null;
  const inputDisabled = busy || disabled || !verified || !online;
  return (
    <section className="global-voucher-conversion" aria-label="Voucher top-up">
      <h3>Check and Top-up Gift Voucher/Gift Card to TSS Money</h3>
      {!online && <p role="status">Connect to check or top up a voucher.</p>}
      {problem && (
        <p className="inline-error" role="alert">
          {problem}
        </p>
      )}
      {problem && <RequestReference error={problemCause} />}
      {notice && <p role="status">{notice}</p>}
      {intent && !pinStep && (
        <>
          <p role="status">
            The last top-up was not confirmed. Check its status before trying again.
          </p>
          <div className="global-voucher-actions">
            <button
              className="button secondary"
              disabled={!online || busy}
              onClick={() => void recover()}
            >
              Check top-up status
            </button>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => {
                journal.current.clear();
                setIntent(null);
              }}
            >
              Dismiss
            </button>
          </div>
        </>
      )}
      <div className="global-voucher-actions">
        <label>
          Voucher code
          <input
            autoComplete="off"
            value={code}
            maxLength={25}
            onChange={(event) => {
              setCode(event.target.value);
              setDetails(null);
              setConfirming(false);
              setPinStep(null);
            }}
            disabled={inputDisabled}
          />
        </label>
        <button
          type="button"
          className="button secondary"
          disabled={inputDisabled || !code.trim()}
          onClick={() => void check()}
        >
          Check
        </button>
        <button
          type="button"
          className="button primary"
          disabled={inputDisabled || Boolean(intent)}
          onClick={() => {
            if (!code.trim()) {
              setProblem('Please enter a valid voucher code');
              return;
            }
            setProblem('');
            setConfirming(true);
          }}
        >
          Top-up
        </button>
      </div>
      {details && (
        <section className="global-voucher-receipt" aria-label="Gift Voucher/Card Details">
          <h4>Gift Voucher/Card Details</h4>
          <p>
            <b>Here is the datail of your Gift Voucher/Card</b>
          </p>
          <p>Your Voucher have -&gt; ₹{details.voucherValue}</p>
          <p>
            {details.nonExpiring
              ? 'This Coupon Won’t Expire'
              : `This voucher is valid till -> ${details.validity}`}
          </p>
          <button className="button secondary" onClick={() => setDetails(null)}>
            Back
          </button>
        </section>
      )}
      {confirming && (
        <section className="global-voucher-receipt" role="dialog" aria-label="Confirm">
          <p>
            <b>Are You Sure You Want To Top Up All Of This Gift Voucher/Card To TSS Money</b>
          </p>
          <p>
            Voucher Code -&gt; <b>{code.trim()}</b>
          </p>
          <div className="global-voucher-actions">
            <button
              className="button primary"
              disabled={busy || !online}
              onClick={() => {
                setConfirming(false);
                void convert();
              }}
            >
              Confirm
            </button>
            <button className="button secondary" onClick={() => setConfirming(false)}>
              Back
            </button>
          </div>
        </section>
      )}
      {pinStep && (
        <section className="global-voucher-receipt" role="dialog" aria-label="GC PIN">
          <p>
            <b>Please Enter the GIFT CARD PIN</b>
          </p>
          <label>
            Gift card PIN
            <input
              type="password"
              autoComplete="new-password"
              inputMode="numeric"
              placeholder="Enter 6 Digit PIN"
              maxLength={6}
              value={pin}
              onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
              disabled={busy}
            />
          </label>
          {pinStep.message && <small className="inline-error">{pinStep.message}</small>}
          <div className="global-voucher-actions">
            <button
              className="button primary"
              disabled={busy || !online}
              onClick={() => {
                if (!/^\d{6}$/.test(pin)) {
                  setPinStep({ ...pinStep, message: 'Please Provide a Valid PIN' });
                  return;
                }
                void (pinStep.action === 'check' ? check(pin) : convert(pin));
              }}
            >
              Submit
            </button>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => {
                setPinStep(null);
                setPin('');
                if (pinStep.action === 'convert') {
                  journal.current.clear();
                  setIntent(null);
                }
              }}
            >
              Back
            </button>
          </div>
        </section>
      )}
    </section>
  );
}
