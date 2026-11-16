import { useEffect, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { ApiError, captureOperatorScope, request } from '../../api/client';
import type { Checkout } from '../checkout/client';
import {
  cancelVoucherIntent,
  createVoucherConversion,
  readVoucherOperation,
  type VoucherReceipt,
} from './api';
import { voucherJournal, type VoucherIntent } from './journal';
import { GlobalVoucherReceipt } from './receipt';
import './style.css';

export interface GlobalVoucherConversionProps {
  user: { id: string };
  state: Checkout;
  online: boolean;
  disabled?: boolean;
  onPending: (pending: boolean) => void;
  onSaved: () => Promise<void>;
}
export function GlobalVoucherConversion(props: GlobalVoucherConversionProps) {
  const { user, state } = props;
  return (
    <ScopedVoucherConversion
      key={`${user.id}:${state.storeId}:${state.counterId}:${state.id}:${state.customerId}`}
      {...props}
    />
  );
}
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
    [intent, setIntent] = useState<VoucherIntent | null>(null),
    [receipt, setReceipt] = useState<VoucherReceipt | null>(null),
    [busy, setBusy] = useState(false),
    [absent, setAbsent] = useState(false),
    [needsRefresh, setNeedsRefresh] = useState(false),
    [problem, setProblem] = useState('');
  const journal = useRef(
      voucherJournal(
        `pos-voucher-conversion:${user.id}:${state.storeId}:${state.counterId}:${state.id}:${state.customerId}`,
      ),
    ),
    lifetime = useRef(new AbortController()),
    active = useRef(false);
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
      setProblem('The saved voucher reference requires review.');
    }
    return () => {
      controller.abort();
      onPending(false);
    };
  }, [user.id, state.id, state.storeId, state.counterId, state.customerId]);
  useEffect(() => {
    onPending(busy || Boolean(intent && !receipt) || needsRefresh);
  }, [busy, intent, receipt, needsRefresh, onPending]);
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
      .catch((error: unknown) => {
        if (!signal.aborted)
          setProblem(error instanceof Error ? error.message : 'Voucher conversion is unavailable.');
      });
  }, [user.id, state.storeId, state.id, online]);
  async function act(task: (signal: AbortSignal) => Promise<void>) {
    if (!online || active.current) return;
    const signal = AbortSignal.any([captureOperatorScope(user.id), lifetime.current.signal]);
    active.current = true;
    setBusy(true);
    onPending(true);
    setProblem('');
    try {
      await task(signal);
    } catch (error) {
      if (!signal.aborted)
        setProblem(
          error instanceof Error ? error.message : 'The original conversion needs confirmation.',
        );
    } finally {
      active.current = false;
      if (!signal.aborted) setBusy(false);
    }
  }
  async function adopt(value: VoucherReceipt, signal: AbortSignal) {
    signal.throwIfAborted();
    setReceipt(value);
    setCode('');
    setPin('');
    setAbsent(false);
    setNeedsRefresh(true);
    await onSaved();
    signal.throwIfAborted();
    setNeedsRefresh(false);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      (!intent &&
        (disabled ||
          !enabled ||
          !state.customerId ||
          !state.verifiedCustomerUntil ||
          state.verifiedCustomerUntil <= Date.now())) ||
      (intent && !absent)
    )
      return;
    await act(async (signal) => {
      let command = intent;
      if (!command) {
        if (!state.customerId) throw new Error('Connect and verify a customer first.');
        command = {
          kind: 'conversion',
          operatorId: user.id,
          operationId: crypto.randomUUID(),
          storeId: state.storeId,
          checkoutId: state.id,
          customerId: state.customerId,
          expectedVersion: state.version,
        };
        signal.throwIfAborted();
        journal.current.save(command);
        setIntent(command);
      }
      if (command.kind !== 'conversion')
        throw new Error('The saved conversion reference does not match.');
      const body = {
        operationId: command.operationId,
        expectedVersion: command.expectedVersion,
        voucherCode: code,
        ...(pin ? { giftCardPin: pin } : {}),
      };
      setAbsent(false);
      setPin('');
      const result = await createVoucherConversion(
        user.id,
        command.storeId,
        command.checkoutId,
        body,
        signal,
      );
      await adopt(result, signal);
    });
  }
  async function recover() {
    if (!intent) return;
    await act(async (signal) => {
      try {
        const result = await readVoucherOperation(user.id, intent.operationId, signal);
        signal.throwIfAborted();
        if (result.status === 'succeeded') await adopt(result.receipt, signal);
        else {
          journal.current.clear();
          setIntent(null);
          setCode('');
          setPin('');
          setAbsent(false);
          if (result.status === 'rejected')
            setProblem('The original PIN attempt was rejected. You can start a new attempt.');
        }
      } catch (error) {
        if (error instanceof ApiError && error.code === 'GLOBAL_VOUCHER_OPERATION_NOT_FOUND') {
          setAbsent(true);
          return;
        }
        throw error;
      }
    });
  }
  async function stop() {
    if (!intent || intent.kind !== 'conversion') return;
    await act(async (signal) => {
      const result = await cancelVoucherIntent(
        user.id,
        intent.operationId,
        { kind: 'conversion', storeId: intent.storeId, checkoutId: intent.checkoutId },
        signal,
      );
      signal.throwIfAborted();
      if (result.status === 'succeeded') await adopt(result.receipt, signal);
      else {
        journal.current.clear();
        setIntent(null);
        setCode('');
        setPin('');
        setAbsent(false);
      }
    });
  }
  if (!enabled && !intent && !receipt && !problem) return null;
  return (
    <section className="global-voucher-conversion" aria-label="Voucher conversion">
      <h3>Convert a voucher to TSS Money</h3>
      <p>
        Convert its available balance for this verified customer. Remove any applied voucher first.
      </p>
      {!online && <p role="status">Connect to check or convert a voucher.</p>}
      {!enabled && <p role="status">Conversion is awaiting compatibility configuration.</p>}
      {problem && (
        <p className="inline-error" role="alert">
          {problem}
        </p>
      )}
      {receipt && <GlobalVoucherReceipt receipt={receipt} />}
      {intent && !receipt && (
        <>
          <p role="status">
            The original conversion is awaiting confirmation. Checking does not transfer value.
          </p>
          <p>
            Operation <code>{intent.operationId}</code>
          </p>
        </>
      )}
      {intent && !receipt && (
        <div className="global-voucher-actions">
          <button
            className="button secondary"
            disabled={!online || busy}
            onClick={() => void recover()}
          >
            Check conversion status
          </button>
          <button
            className="button secondary"
            disabled={!online || busy}
            onClick={() => void stop()}
          >
            Stop original conversion
          </button>
        </div>
      )}
      {needsRefresh && (
        <>
          <p role="status">Conversion is confirmed. Refresh this sale before continuing.</p>
          <button
            className="button secondary"
            disabled={!online || busy}
            onClick={() =>
              void act(async (signal) => {
                await onSaved();
                signal.throwIfAborted();
                setNeedsRefresh(false);
              })
            }
          >
            Refresh sale after conversion
          </button>
        </>
      )}
      {!receipt && (!intent || absent) && (
        <form onSubmit={(event) => void submit(event)}>
          {absent && <p>Re-enter the original voucher and PIN to retry the same operation.</p>}
          <label>
            Voucher code
            <input
              autoComplete="off"
              value={code}
              maxLength={25}
              pattern="[A-Za-z0-9]+"
              required
              onChange={(event) => setCode(event.target.value)}
              disabled={busy || (!intent && disabled)}
            />
          </label>
          <label>
            Gift card PIN, if required
            <input
              type="password"
              autoComplete="new-password"
              inputMode="numeric"
              pattern="[0-9]{6}"
              value={pin}
              maxLength={6}
              onChange={(event) => setPin(event.target.value)}
              disabled={busy || (!intent && disabled)}
            />
          </label>
          <button
            type="submit"
            className="button secondary"
            disabled={
              !online ||
              !enabled ||
              busy ||
              (!intent &&
                (disabled ||
                  !state.customerId ||
                  !state.verifiedCustomerUntil ||
                  state.verifiedCustomerUntil <= Date.now()))
            }
          >
            {intent ? 'Retry original conversion' : 'Convert voucher balance'}
          </button>
        </form>
      )}
      {receipt && !needsRefresh && (
        <button
          className="button secondary"
          disabled={busy || disabled}
          onClick={() => {
            journal.current.clear();
            setIntent(null);
            setReceipt(null);
          }}
        >
          Convert another voucher
        </button>
      )}
    </section>
  );
}
