import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { Check, RefreshCw, Undo2, ArrowLeftRight } from 'lucide-react';
import type { Principal } from '../../api/types';
import { ApiError, post, request } from '../../api/client';
import { Empty, ErrorState, Loading, PageTitle } from '../../components/common';
import { useOnline } from '../../hooks/use-pos';
import { currency } from '../../lib/format';
import {
  AutomaticInvoicePreview,
  createAutomaticExchangeInvoiceRequest,
  type AutomaticInvoiceRequest,
} from '../invoice-documents';
import { InvoiceActions } from '../checkout';
import {
  canContinue,
  continueReverse,
  lineSchema,
  loadRecovery,
  proofSchema,
  readProof,
  readReverse,
  retryExchange,
  reconcileExchange,
  exchangeReasonsSchema,
  exchangeSizesSchema,
  salespeopleSchema,
  returnBase,
  returnSchema,
  saveRecovery,
  type ReturnReceipt,
  type ReturnLine,
  type ReturnRecovery,
  type ReverseKind,
} from './client';
import './style.css';
import { SalespersonSelect } from './SalespersonSelect';

const reasonList = z.object({ data: z.array(z.object({ id: z.string(), reason: z.string() })) });
const subReasonList = z.object({
  data: z.array(z.object({ id: z.string(), sub_reason: z.string() })),
});
const refundPreview = z.object({
  pay_mode: z.enum(['prepaid', 'other']),
  pay_amt: z.number(),
  is_exchange_order: z.boolean(),
});
export function ReturnsPage({
  user,
  storeId,
  counterId,
}: {
  user: Principal;
  storeId: string;
  counterId: string;
}) {
  const client = useQueryClient(),
    online = useOnline(),
    lock = useRef(false);
  const [recovery, setRecovery] = useState<ReturnRecovery | null>(() =>
    loadRecovery(user.id, storeId, counterId),
  );
  const [orderId, setOrder] = useState(recovery?.orderId || ''),
    [mode, setMode] = useState<ReverseKind>(recovery?.kind || 'return'),
    [otp, setOtp] = useState(''),
    [line, setLine] = useState<ReturnLine | null>(null),
    [reasonId, setReason] = useState(''),
    [subReasonId, setSubReason] = useState(''),
    [comment, setComment] = useState(''),
    [quality, setQuality] = useState(false),
    [tag, setTag] = useState(false),
    [saleable, setSaleable] = useState(false),
    [refundMode, setRefundMode] = useState<'tss-money' | 'cash'>('tss-money'),
    [replacementId, setReplacement] = useState(''),
    [salespersonId, setSalesperson] = useState(''),
    [busy, setBusy] = useState(false),
    [problem, setProblem] = useState<unknown>(null),
    [automaticInvoice, setAutomaticInvoice] = useState<AutomaticInvoiceRequest | null>(null);
  const printedExchanges = useRef(new Set<string>());
  useEffect(() => setAutomaticInvoice(null), [user.id, storeId, counterId, recovery?.returnId]);
  function newExchangeInvoice(value: ReturnReceipt, operationId: string) {
    if (
      value.kind !== 'exchange' ||
      value.phase !== 'completed' ||
      !value.newOrderId ||
      value.id !== operationId ||
      value.storeId !== storeId ||
      value.orderId !== recovery?.orderId ||
      printedExchanges.current.has(value.id)
    )
      return;
    printedExchanges.current.add(value.id);
    // A document failure cannot change the completed financial operation.
    try {
      setAutomaticInvoice(
        createAutomaticExchangeInvoiceRequest(user, storeId, {
          source: 'exchange',
          exchangeId: value.id,
          orderId: value.newOrderId,
        }),
      );
    } catch {
      /* The protected manual invoice remains available. */
    }
  }
  const proofKey = [user.id, 'return-proof', storeId, recovery?.verificationId] as const;
  const proof = useQuery({
    queryKey: proofKey,
    enabled: !!recovery?.verificationId,
    queryFn: () => readProof(storeId, recovery!.verificationId!, user.id),
    retry: false,
  });
  const verified = Boolean(proof.data?.verifiedUntil && proof.data.verifiedUntil > Date.now());
  const lines = useInfiniteQuery({
    queryKey: [user.id, 'return-lines', storeId, recovery?.verificationId],
    enabled: verified,
    initialPageParam: '0',
    queryFn: ({ pageParam }) =>
      request(
        `${returnBase(storeId)}/return-verifications/${recovery!.verificationId}/line-items?after=${pageParam}`,
        { operatorId: user.id },
        z.object({ data: z.array(lineSchema), nextCursor: z.string().nullable() }),
      ),
    getNextPageParam: (page) => page.nextCursor || undefined,
  });
  const operationKind = recovery?.kind || mode;
  const operationKey = (id: string, kind: ReverseKind) =>
    [user.id, 'reverse-operation', storeId, kind, id] as const;
  const resultKey = operationKey(recovery?.returnId || '', operationKind);
  const result = useQuery({
    queryKey: resultKey,
    enabled: !!recovery?.returnId,
    queryFn: () => readReverse(storeId, recovery!.returnId!, operationKind, user.id),
    retry: false,
  });
  const reasons = useQuery({
    queryKey: [user.id, 'return-reasons', storeId],
    enabled: verified && mode === 'return',
    queryFn: () =>
      request(`${returnBase(storeId)}/return-reasons`, { operatorId: user.id }, reasonList),
  });
  const subReasons = useQuery({
    queryKey: [user.id, 'return-sub-reasons', storeId, line?.productId, reasonId],
    enabled: !!line && !!reasonId && mode === 'return',
    queryFn: () =>
      request(
        `${returnBase(storeId)}/products/${line!.productId}/return-reasons/${reasonId}/sub-reasons`,
        { operatorId: user.id },
        subReasonList,
      ),
  });
  const preview = useQuery({
    queryKey: [user.id, 'refund-preview', storeId, recovery?.orderId, line?.id],
    enabled: !!line && verified && mode === 'return',
    queryFn: () =>
      request(
        `${returnBase(storeId)}/orders/${recovery!.orderId}/line-items/${line!.id}/refund-preview`,
        { operatorId: user.id },
        refundPreview,
      ),
  });
  const exchangeReasons = useQuery({
    queryKey: [user.id, 'exchange-reasons', storeId, line?.productId],
    enabled: verified && mode === 'exchange' && !!line,
    queryFn: () =>
      request(
        `${returnBase(storeId)}/products/${line!.productId}/exchange-reasons`,
        { operatorId: user.id },
        exchangeReasonsSchema,
      ),
  });
  const exchangeSizes = useQuery({
    queryKey: [user.id, 'exchange-sizes', storeId, line?.parentId],
    enabled: verified && mode === 'exchange' && !!line && line.parentId !== '0',
    queryFn: () =>
      request(
        `${returnBase(storeId)}/products/${line!.parentId}/exchange-sizes`,
        { operatorId: user.id },
        exchangeSizesSchema,
      ),
  });
  const salespeople = useInfiniteQuery({
    queryKey: [user.id, 'reverse-salespeople', storeId],
    enabled:
      (mode === 'exchange' && verified) || (operationKind === 'exchange' && !!recovery?.returnId),
    initialPageParam: '0',
    queryFn: ({ pageParam }) =>
      request(
        `${returnBase(storeId)}/salespeople?purpose=checkout&active=true&limit=100&after=${pageParam}`,
        { operatorId: user.id },
        salespeopleSchema,
      ),
    getNextPageParam: (page) => page.nextCursor || undefined,
  });
  const people = salespeople.data?.pages.flatMap((page) => page.data) || [];
  const availableReasons =
    mode === 'exchange' ? exchangeReasons.data?.data || [] : reasons.data?.data || [];
  const availableSubReasons =
    mode === 'exchange'
      ? exchangeReasons.data?.data.find((reason) => reason.id === reasonId)?.sub_reason || []
      : subReasons.data?.data || [];
  const replacementAvailable = Boolean(
    line &&
    exchangeSizes.data?.data.some(
      (size) => size.prod_id === replacementId && BigInt(size.stock) >= BigInt(line.quantity),
    ),
  );
  const selectedSalesperson = salespersonId || result.data?.replacement?.salespersonId || '';
  const salespersonAvailable = people.some((person) => person.id === selectedSalesperson);
  function remember(value: ReturnRecovery | null) {
    const next = value ? { ...value, kind: value.kind || mode } : null;
    saveRecovery(user.id, storeId, counterId, next);
    setRecovery(next);
  }
  async function act(task: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setProblem(null);
    try {
      await task();
    } catch (error) {
      setProblem(error);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function verifyCustomer() {
    if (!recovery?.verificationId) return;
    const code = otp;
    setOtp('');
    try {
      const value = await post(
        `${returnBase(storeId)}/return-verifications/${recovery.verificationId}/confirmations`,
        { operationId: crypto.randomUUID(), otp: code },
        proofSchema,
        user.id,
      );
      client.setQueryData(proofKey, value);
    } finally {
      setOtp('');
      await client.invalidateQueries({ queryKey: proofKey });
    }
  }
  async function startProof() {
    setOtp('');
    const value = { orderId, verificationId: crypto.randomUUID(), returnId: null, kind: mode };
    remember(value);
    try {
      const response = await post(
        `${returnBase(storeId)}/orders/${orderId}/return-verifications`,
        { operationId: value.verificationId, counterId },
        proofSchema,
        user.id,
      );
      client.setQueryData([user.id, 'return-proof', storeId, value.verificationId], response);
    } catch (error) {
      await client.invalidateQueries({
        queryKey: [user.id, 'return-proof', storeId, value.verificationId],
      });
      throw error;
    }
  }
  async function processReturn() {
    if (!line || !recovery?.verificationId || !quality || !tag) return;
    const operationId = crypto.randomUUID();
    remember({ ...recovery, returnId: operationId });
    try {
      const response = await post(
        `${returnBase(storeId)}/orders/${recovery.orderId}/line-items/${line.id}/${mode === 'exchange' ? 'exchanges' : 'returns'}`,
        {
          operationId,
          counterId,
          verificationId: recovery.verificationId,
          reasonId,
          ...(subReasonId ? { subReasonId } : {}),
          comment,
          qualityConfirmed: true,
          tagConfirmed: true,
          saleable,
          ...(mode === 'exchange'
            ? { replacementProductId: replacementId, salespersonId }
            : { refundMode, overrideEligibility: false }),
        },
        returnSchema,
        user.id,
      );
      client.setQueryData(operationKey(operationId, mode), response);
      if (mode === 'exchange') newExchangeInvoice(response, operationId);
      await client.invalidateQueries({
        queryKey: [user.id, 'return-lines', storeId, recovery.verificationId],
      });
    } catch (error) {
      try {
        client.setQueryData(
          operationKey(operationId, mode),
          await readReverse(storeId, operationId, mode, user.id),
        );
      } catch (lookup) {
        if (
          lookup instanceof ApiError &&
          lookup.status === 404 &&
          error instanceof ApiError &&
          [400, 401, 403, 404, 409, 410, 422, 429].includes(error.status)
        )
          remember({ ...recovery, returnId: null });
        else await client.invalidateQueries({ queryKey: operationKey(operationId, mode) });
      }
      throw error;
    }
  }
  async function resume(retry = false) {
    if (!recovery?.returnId) return;
    try {
      const value = retry
        ? await retryExchange(storeId, recovery.returnId, selectedSalesperson, user.id)
        : await continueReverse(storeId, recovery.returnId, operationKind, user.id);
      client.setQueryData(resultKey, value);
      if (operationKind === 'exchange') newExchangeInvoice(value, recovery.returnId);
    } finally {
      await client.invalidateQueries({ queryKey: resultKey });
    }
  }
  if (!storeId || !counterId)
    return <Empty title="Select your store and counter to process a return" />;
  return (
    <>
      <PageTitle eyebrow="CUSTOMER CARE" title="Returns" />
      <p className="caption">
        Check into the selected store and counter before processing a return or exchange. Online and
        other-store purchases use the original customer’s verification code.
      </p>
      {!online && (
        <p role="status" className="inline-error">
          Reconnect to verify the customer and confirm refunds.
        </p>
      )}
      <div className="reverse-mode" role="group" aria-label="Return or exchange">
        {(['return', 'exchange'] as const).map((value) => (
          <button
            key={value}
            className={`button ${mode === value ? 'primary' : 'secondary'}`}
            disabled={busy || !!recovery?.returnId}
            aria-pressed={mode === value}
            onClick={() => {
              setMode(value);
              if (recovery) remember({ ...recovery, kind: value });
              setLine(null);
              setReason('');
              setSubReason('');
              setReplacement('');
              setSalesperson('');
              setProblem(null);
            }}
          >
            {value === 'return' ? 'Return' : 'Exchange'}
          </button>
        ))}
      </div>
      <section className="surface return-flow">
        <h2>Find the original order</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void act(startProof);
          }}
          className="return-order"
        >
          <label>
            Order ID
            <input
              aria-label="Return order ID"
              value={orderId}
              onChange={(event) => setOrder(event.target.value.replace(/\D/g, '').slice(0, 20))}
              disabled={!!recovery}
              pattern="[1-9][0-9]{0,19}"
              required
            />
          </label>
          <button className="button primary" disabled={!online || busy || !!recovery}>
            Send customer verification code
          </button>
        </form>
        {recovery && !recovery.returnId && (
          <>
            <button
              className="text-button"
              disabled={busy || !online}
              onClick={() => void proof.refetch()}
            >
              Refresh verification status
            </button>
            {proof.isPending ? (
              <Loading />
            ) : proof.isError ? (
              <ErrorState error={proof.error} />
            ) : verified ? (
              <p className="return-verified">
                <Check size={17} /> Customer verified until{' '}
                {new Date(proof.data!.verifiedUntil!).toLocaleTimeString()}
              </p>
            ) : proof.data?.pending ? (
              <div role="status">
                <p>
                  Customer verification is still being confirmed. Refresh its status before
                  continuing.
                </p>
                {proof.data.pendingOperationId && (
                  <button
                    className="button secondary"
                    disabled={busy || !online}
                    onClick={() =>
                      void act(async () => {
                        const value = await post(
                          `${returnBase(storeId)}/return-verifications/${recovery.verificationId}/reconciliations`,
                          { operationId: proof.data!.pendingOperationId },
                          proofSchema,
                          user.id,
                        );
                        client.setQueryData(proofKey, value);
                        if (value.errorCode)
                          throw new Error(
                            `Verification was rejected (${value.errorCode}). No additional attempt was made.`,
                          );
                      })
                    }
                  >
                    Check original verification action
                  </button>
                )}
              </div>
            ) : (
              <>
                {proof.data?.deliveryStatus === 'pending' && (
                  <p role="status">
                    The code is queued for delivery. Refresh verification status before continuing.
                  </p>
                )}
                {proof.data?.deliveryStatus === 'uncertain' && (
                  <p role="status">
                    Delivery is unconfirmed. An arrived code can be verified; no code is resent
                    automatically.
                  </p>
                )}
                {proof.data?.errorCode && (
                  <p role="status">Verification status: {proof.data.errorCode}.</p>
                )}
                <form
                  className="return-order"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void act(verifyCustomer);
                  }}
                >
                  <label>
                    Customer verification code
                    <input
                      aria-label="Return customer OTP"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      value={otp}
                      onChange={(event) =>
                        setOtp(event.target.value.replace(/\D/g, '').slice(0, 6))
                      }
                      pattern="[0-9]{6}"
                      maxLength={6}
                      required
                    />
                  </label>
                  <button
                    className="button primary"
                    disabled={
                      !online ||
                      busy ||
                      otp.length !== 6 ||
                      !(proof.data?.sent || proof.data?.deliveryStatus === 'uncertain')
                    }
                  >
                    Verify customer
                  </button>
                </form>
              </>
            )}
            <button
              className="text-button"
              disabled={busy || proof.data?.pending}
              onClick={() => {
                remember(null);
                setOtp('');
                setLine(null);
              }}
            >
              Use another order or request a new code
            </button>
          </>
        )}
      </section>
      {verified && !recovery?.returnId && (
        <section className="surface return-flow">
          <h2>Select an item</h2>
          {lines.isPending ? (
            <Loading />
          ) : lines.isError ? (
            <ErrorState error={lines.error} />
          ) : (
            <div className="return-lines">
              {lines.data?.pages
                .flatMap((page) => page.data)
                .map((item) => (
                  <button
                    key={item.id}
                    className={`button secondary ${line?.id === item.id ? 'selected' : ''}`}
                    disabled={
                      busy ||
                      item.returnStatus !== 0 ||
                      item.status !== 'DELIVERED' ||
                      (mode === 'exchange' && item.parentId === '0')
                    }
                    onClick={() => {
                      setLine(item);
                      setReason('');
                      setSubReason('');
                      setQuality(false);
                      setTag(false);
                      setSaleable(false);
                      setRefundMode('tss-money');
                      setReplacement('');
                      setSalesperson('');
                      setComment('');
                    }}
                  >
                    <span>
                      <strong>{item.name || `Product ${item.productId}`}</strong>
                      <small>
                        Line {item.id} · Quantity {item.quantity} · {item.status}
                      </small>
                    </span>
                  </button>
                ))}
            </div>
          )}
          {lines.hasNextPage && (
            <button
              className="button secondary"
              disabled={lines.isFetchingNextPage}
              onClick={() => void lines.fetchNextPage()}
            >
              Load more items
            </button>
          )}
          {line && (
            <form
              className="return-form"
              onSubmit={(event) => {
                event.preventDefault();
                void act(processReturn);
              }}
            >
              <h3>
                {mode === 'exchange' ? 'Exchange' : 'Return'} {line.name || `line ${line.id}`}
              </h3>
              {mode === 'exchange' && (
                <>
                  <fieldset className="replacement-sizes">
                    <legend>Replacement size</legend>
                    {exchangeSizes.isPending ? (
                      <Loading />
                    ) : exchangeSizes.isError ? (
                      <ErrorState error={exchangeSizes.error} />
                    ) : !exchangeSizes.data?.data.length ? (
                      <p>No replacement sizes are available at this store.</p>
                    ) : (
                      exchangeSizes.data.data.map((size) => (
                        <button
                          type="button"
                          key={size.prod_id}
                          className={`button ${replacementId === size.prod_id ? 'primary' : 'secondary'}`}
                          aria-pressed={replacementId === size.prod_id}
                          disabled={
                            busy || size.size === null || BigInt(size.stock) < BigInt(line.quantity)
                          }
                          onClick={() => setReplacement(size.prod_id)}
                        >
                          {size.size || 'Size unavailable'} · {size.stock} in stock
                          {size.prod_id === line.productId ? ' · Current size' : ''}
                        </button>
                      ))
                    )}
                  </fieldset>
                  <SalespersonSelect
                    people={people}
                    value={salespersonId}
                    onChange={setSalesperson}
                    disabled={busy}
                  />
                  {salespeople.isError && <ErrorState error={salespeople.error} />}{' '}
                  {salespeople.hasNextPage && (
                    <button
                      className="button secondary"
                      type="button"
                      disabled={salespeople.isFetchingNextPage}
                      onClick={() => void salespeople.fetchNextPage()}
                    >
                      Load more salespeople
                    </button>
                  )}
                </>
              )}
              <label>
                Reason
                <select
                  aria-label={mode === 'exchange' ? 'Exchange reason' : 'Return reason'}
                  value={reasonId}
                  onChange={(event) => {
                    setReason(event.target.value);
                    setSubReason('');
                  }}
                  required
                >
                  <option value="">Select a reason</option>
                  {availableReasons.map((reason) => (
                    <option key={reason.id} value={reason.id}>
                      {reason.reason}
                    </option>
                  ))}
                </select>
              </label>
              {(mode === 'exchange' ? exchangeReasons.isError : reasons.isError) && (
                <ErrorState error={mode === 'exchange' ? exchangeReasons.error : reasons.error} />
              )}
              <label>
                Additional reason
                <select
                  aria-label={mode === 'exchange' ? 'Exchange sub-reason' : 'Return sub-reason'}
                  value={subReasonId}
                  onChange={(event) => setSubReason(event.target.value)}
                  required={!!availableSubReasons.length}
                >
                  <option value="">Select if applicable</option>
                  {availableSubReasons.map((reason) => (
                    <option key={reason.id} value={reason.id}>
                      {reason.sub_reason}
                    </option>
                  ))}
                </select>
              </label>
              {mode === 'return' && subReasons.isError && <ErrorState error={subReasons.error} />}
              <label>
                Comment
                <textarea
                  maxLength={255}
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                />
              </label>
              <label className="return-check">
                <input
                  type="checkbox"
                  checked={quality}
                  onChange={(event) => setQuality(event.target.checked)}
                />
                I checked the item’s condition
              </label>
              <label className="return-check">
                <input
                  type="checkbox"
                  checked={tag}
                  onChange={(event) => setTag(event.target.checked)}
                />
                I checked the original tag
              </label>
              <label className="return-check">
                <input
                  type="checkbox"
                  checked={saleable}
                  onChange={(event) => setSaleable(event.target.checked)}
                />
                Return this item to saleable stock
              </label>
              {mode === 'return' && (
                <label>
                  Refund destination
                  <select
                    aria-label="Refund destination"
                    value={refundMode}
                    onChange={(event) =>
                      setRefundMode(event.target.value === 'cash' ? 'cash' : 'tss-money')
                    }
                  >
                    <option value="tss-money">TSS Money</option>
                    {preview.data?.pay_mode === 'other' && (
                      <option value="cash">Cash · up to {currency(preview.data.pay_amt)}</option>
                    )}
                  </select>
                </label>
              )}
              {mode === 'return' && preview.isError && <ErrorState error={preview.error} />}
              <p className="caption">
                {mode === 'exchange'
                  ? 'The server confirms replacement stock and eligibility. Hand over the replacement only after the exchange is completed.'
                  : 'Eligibility, refund value and inventory are verified by the server before this return completes.'}
              </p>
              <button
                className="button primary"
                disabled={
                  !online ||
                  busy ||
                  !quality ||
                  !tag ||
                  !reasonId ||
                  (mode === 'return'
                    ? !preview.data || subReasons.isPending || !!subReasons.error
                    : !replacementAvailable ||
                      !salespersonAvailable ||
                      !exchangeReasons.data ||
                      !!exchangeReasons.error ||
                      !!salespeople.error) ||
                  (availableSubReasons.length > 0 &&
                    !availableSubReasons.some((reason) => reason.id === subReasonId))
                }
              >
                {mode === 'exchange' ? <ArrowLeftRight size={16} /> : <Undo2 size={16} />}
                {mode === 'exchange' ? 'Confirm exchange' : 'Confirm return & refund'}
              </button>
            </form>
          )}
        </section>
      )}
      {recovery?.returnId && (
        <section className="surface return-flow">
          <h2>
            {result.data?.phase === 'completed'
              ? operationKind === 'exchange'
                ? 'Exchange completed'
                : 'Return completed'
              : operationKind === 'exchange'
                ? 'Exchange confirmation'
                : 'Return confirmation'}
          </h2>
          <p className="mono">Reference {recovery.returnId}</p>
          {result.isPending ? (
            <Loading />
          ) : result.isError ? (
            <>
              <ErrorState error={result.error} />
              <p>
                Confirmation is pending. Check this reference before starting another return for
                this item.
              </p>
            </>
          ) : (
            result.data && (
              <>
                <p role="status">
                  {result.data.phase === 'completed'
                    ? operationKind === 'exchange'
                      ? `Replacement order ${result.data.newOrderId} is confirmed. No new counter payment was collected.`
                      : `Refund confirmed${result.data.returnAmount ? ` · ${currency(result.data.returnAmount)}` : ''}`
                    : result.data.phase === 'uncertain'
                      ? operationKind === 'exchange'
                        ? 'The return or replacement outcome needs reconciliation. No replacement will be requested automatically.'
                        : 'The warehouse or refund outcome needs reconciliation. This action will not be repeated automatically.'
                      : result.data.phase === 'replacement-rejected'
                        ? 'The original item was returned. The replacement request was rejected. Review the stored replacement before retrying.'
                        : result.data.phase === 'rejected'
                          ? 'This return was rejected before completion.'
                          : `Current stage: ${result.data.phase.replaceAll('-', ' ')}`}
                </p>
                {result.data.creditNote && <p>Credit note {result.data.creditNote}</p>}
                {result.data.replacement && (
                  <p>
                    Stored replacement: size {result.data.replacement.size} · SKU{' '}
                    {result.data.replacement.productId}
                  </p>
                )}
                {result.data.errorCode && (
                  <p className="caption">Support code: {result.data.errorCode}</p>
                )}
                {operationKind === 'exchange' &&
                  (result.data.phase === 'replacement-rejected' ||
                    (result.data.phase === 'uncertain' &&
                      result.data.uncertainStage === 'replacement')) && (
                    <button
                      className="button secondary"
                      disabled={!online || busy}
                      onClick={() =>
                        void act(async () => {
                          const value = await reconcileExchange(
                            storeId,
                            recovery.returnId!,
                            user.id,
                          );
                          client.setQueryData(resultKey, value);
                          newExchangeInvoice(value, recovery.returnId!);
                        })
                      }
                    >
                      Find confirmed replacement
                    </button>
                  )}
                {canContinue(result.data, operationKind) && (
                  <button
                    className="button primary"
                    disabled={!online || busy}
                    onClick={() => void act(() => resume())}
                  >
                    {operationKind === 'exchange'
                      ? 'Continue confirmed exchange'
                      : 'Continue confirmed return'}
                  </button>
                )}
                {operationKind === 'exchange' && result.data.phase === 'replacement-rejected' && (
                  <div className="exchange-retry">
                    <SalespersonSelect
                      people={people}
                      value={selectedSalesperson}
                      onChange={setSalesperson}
                      disabled={busy}
                    />
                    {salespeople.isError && <ErrorState error={salespeople.error} />}
                    <button
                      className="button primary"
                      disabled={!online || busy || !salespersonAvailable}
                      onClick={() => void act(() => resume(true))}
                    >
                      Retry stored replacement
                    </button>
                  </div>
                )}
                {operationKind === 'exchange' &&
                  result.data.phase === 'completed' &&
                  result.data.newOrderId && (
                    <InvoiceActions
                      ownerId={user.id}
                      storeId={storeId}
                      orderId={result.data.newOrderId}
                    />
                  )}
                {['completed', 'rejected'].includes(result.data.phase) && (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => {
                      remember({ ...recovery, returnId: null });
                      setLine(null);
                      setComment('');
                      void client.invalidateQueries({
                        queryKey: [user.id, 'return-lines', storeId, recovery.verificationId],
                      });
                    }}
                  >
                    {operationKind === 'exchange' ? 'Exchange another item' : 'Return another item'}
                  </button>
                )}
              </>
            )
          )}
          <button
            className="button secondary"
            disabled={!online || busy || result.isFetching}
            onClick={() => void result.refetch()}
          >
            <RefreshCw size={16} />
            {operationKind === 'exchange' ? 'Check exchange status' : 'Check return status'}
          </button>
        </section>
      )}
      {problem !== null && <ErrorState error={problem} />}
      {automaticInvoice &&
        automaticInvoice.ownerId === user.id &&
        automaticInvoice.storeId === storeId &&
        automaticInvoice.receipt.orderId === result.data?.newOrderId && (
          <AutomaticInvoicePreview
            key={automaticInvoice.id}
            user={user}
            request={automaticInvoice}
            online={online}
            onClose={() => setAutomaticInvoice(null)}
          />
        )}
    </>
  );
}
