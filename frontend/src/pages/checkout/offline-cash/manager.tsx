import { useEffect, useRef, useState } from 'react';
import Dexie, { liveQuery } from 'dexie';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, X } from 'lucide-react';
import { z } from 'zod';
import { ApiError, captureOperatorScope } from '../../../api/client';
import type { Principal } from '../../../api/types';
import { Empty, ErrorState, Loading } from '../../../components/common';
import { db, type PosDatabase } from '../../../offline/database';
import {
  acknowledgeCashReceipt,
  approveCashReceiptImport,
  importCashReceiptOrder,
  listCashReceipts,
  readCashReceipt,
} from '../../../offline/cash/client';
import {
  cashIdentifier,
  cashReceiptAcceptanceSchema,
  signedCashReceiptSchema,
  type CashConflict,
  type CashReceiptAcceptance,
} from '../../../offline/cash/contracts';
import { refreshOfflineCashReceipt, replayOfflineCash } from '../../../offline/cash/sync';
import { verifyCashDeviceReceipt } from '../../../offline/cash/crypto';
import type { LocalCashReceipt } from '../../../offline/cash/storage-types';
import { CashReceiptDialog, cashCurrency } from './receipt';

type Status = CashReceiptAcceptance['status'];
type Cursor = { acceptedAt: number; receiptId: string } | null;
type Detail = Awaited<ReturnType<typeof readCashReceipt>>;
type ReceiptView = Pick<LocalCashReceipt, 'envelope' | 'syncState' | 'acceptance'>;
const statuses: Record<Status, string> = {
  accepted: 'Recorded; awaiting import',
  conflicted: 'Needs manager review',
  importing: 'Importing',
  imported: 'Order synchronized',
};
const conflicts: Record<CashConflict, string> = {
  'authorization-expired': 'Authorization expired',
  'clock-outside-authorization': 'Device time needs attribution',
  'authorization-revoked': 'Authorization revoked',
  'operator-access-changed': 'Original operator access changed',
  'stock-shortage': 'Stock shortage',
  'price-changed': 'Current price changed',
  'price-snapshot-expired': 'Saved prices expired',
  'source-import-unavailable': 'Order import unavailable',
  'import-outcome-unknown': 'Import outcome needs confirmation',
};
const fingerprint = (user: Principal) =>
  JSON.stringify([user.id, user.role, user.userType, [...new Set(user.storeIds)].sort()]);
export function cashManagerAllowed(user: Principal, storeId: string) {
  return (
    [1, 2, 3, 4].includes(user.role) &&
    cashIdentifier.safeParse(user.id).success &&
    cashIdentifier.safeParse(storeId).success &&
    ((user.role === 1 && user.userType === 1) || user.storeIds.includes(storeId))
  );
}
const managerPrincipalSchema = z.object({
  id: cashIdentifier,
  name: z.string(),
  email: z.string(),
  role: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  userType: z.union([z.literal(1), z.literal(2)]),
  storeIds: z.array(cashIdentifier),
});
const sessionSchema = z.object({
  id: z.literal('current'),
  user: managerPrincipalSchema,
  expiresAt: z.number().int().safe().positive(),
});
export function cashManagerSessionMatches(
  user: Principal,
  storeId: string,
  value: unknown,
  now = Date.now(),
  pendingLogout = false,
) {
  const parsed = sessionSchema.safeParse(value);
  return (
    !pendingLogout &&
    cashManagerAllowed(user, storeId) &&
    parsed.success &&
    parsed.data.expiresAt > now &&
    fingerprint(parsed.data.user) === fingerprint(user) &&
    cashManagerAllowed(parsed.data.user, storeId)
  );
}
const localSchema = z.object({
  ownerId: cashIdentifier,
  receiptId: z.uuid(),
  storeId: cashIdentifier,
  counterId: cashIdentifier,
  envelope: signedCashReceiptSchema,
  completedAt: z.number().int().safe().positive(),
  acceptance: cashReceiptAcceptanceSchema.nullable(),
  syncState: z.enum(['pending', 'accepted', 'conflicted', 'imported']),
});
export type ManagerLocalReceipt = z.infer<typeof localSchema>;
interface LocalPage {
  authorized: boolean;
  expiresAt: number;
  rows: ManagerLocalReceipt[];
  hasNext: boolean;
  unreadable: number;
}
const emptyLocal = (): LocalPage => ({
  authorized: false,
  expiresAt: 0,
  rows: [],
  hasNext: false,
  unreadable: 0,
});
const immutable = [
  'operatorId',
  'storeId',
  'counterId',
  'businessDate',
  'receiptNumber',
  'completedAt',
  'payableCents',
  'cashReceivedCents',
  'changeCents',
] as const;
function checkAcceptance(
  value: CashReceiptAcceptance,
  original: ReceiptView['envelope']['receipt'],
) {
  if (
    value.receiptId !== original.id ||
    immutable.some((field) => value[field] !== original[field]) ||
    (value.status === 'imported'
      ? !value.orderId || !value.importedAt
      : value.orderId !== null || value.importedAt !== null)
  )
    throw new Error(
      'The server receipt evidence could not be confirmed. Refresh before continuing.',
    );
}
function checkDetail(value: Detail, storeId: string) {
  if (value.storeId !== storeId) throw new Error('This receipt belongs to another store.');
  checkAcceptance(value, value.envelope.receipt);
  if (
    value.authorizationWindow.businessDate !== value.businessDate ||
    value.authorizationWindow.expiresAt <= value.authorizationWindow.issuedAt
  )
    throw new Error('The receipt authorization date could not be confirmed.');
  try {
    new Intl.DateTimeFormat('en', { timeZone: value.authorizationWindow.timeZone }).format(
      value.authorizationWindow.issuedAt,
    );
  } catch {
    throw new Error('The receipt authorization time zone could not be confirmed.');
  }
  return value;
}
export async function loadCashManagerLocalPage(
  user: Principal,
  storeId: string,
  page: number,
  options: {
    database?: PosDatabase;
    signal?: AbortSignal;
    clock?: () => number;
    pendingLogout?: () => boolean;
  } = {},
): Promise<LocalPage> {
  if (!cashManagerAllowed(user, storeId)) return emptyLocal();
  if (!Number.isSafeInteger(page) || page < 0 || !Number.isSafeInteger(page * 25))
    throw new Error('Use a valid saved-receipt page.');
  const database = options.database || db,
    signal = options.signal || captureOperatorScope(user.id),
    clock = options.clock || Date.now,
    pendingLogout = options.pendingLogout || (() => !!localStorage.getItem('pos-pending-logout'));
  signal.throwIfAborted();
  return database.transaction(
    'r',
    [database.sessions, database.offlineCashReceipts, database.offlineCashDevices],
    async () => {
      const session = await database.sessions.get('current');
      signal.throwIfAborted();
      if (!cashManagerSessionMatches(user, storeId, session, clock(), pendingLogout()))
        return emptyLocal();
      const saved = await database.offlineCashReceipts
        .where('storeId')
        .equals(storeId)
        .filter((row) => row.syncState === 'pending')
        .offset(page * 25)
        .limit(26)
        .toArray();
      signal.throwIfAborted();
      if (!cashManagerSessionMatches(user, storeId, session, clock(), pendingLogout()))
        return emptyLocal();
      const rows: ManagerLocalReceipt[] = [];
      let unreadable = 0;
      for (const source of saved.slice(0, 25)) {
        const parsed = localSchema.safeParse(source);
        if (!parsed.success) {
          unreadable++;
          continue;
        }
        const value = parsed.data,
          receipt = value.envelope.receipt;
        if (
          value.ownerId !== receipt.operatorId ||
          value.receiptId !== receipt.id ||
          value.storeId !== receipt.storeId ||
          value.counterId !== receipt.counterId ||
          value.completedAt !== receipt.completedAt
        ) {
          unreadable++;
          continue;
        }
        const device = await database.offlineCashDevices.get([value.ownerId, receipt.deviceId]);
        signal.throwIfAborted();
        if (
          !device ||
          device.storeId !== storeId ||
          device.counterId !== receipt.counterId ||
          !(await Dexie.waitFor(verifyCashDeviceReceipt(value.envelope, device.publicKey)))
        ) {
          unreadable++;
          continue;
        }
        signal.throwIfAborted();
        rows.push(value);
      }
      if (!cashManagerSessionMatches(user, storeId, session, clock(), pendingLogout()))
        return emptyLocal();
      return {
        authorized: true,
        expiresAt: session!.expiresAt,
        rows,
        hasNext: saved.length > 25,
        unreadable,
      };
    },
  );
}

type OperationKind = 'review' | 'approval' | 'import';
const operationSchema = z
  .object({
    id: z.uuid(),
    expectedVersion: z.number().int().positive(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    approvalId: z.uuid().optional(),
  })
  .strict();
type SavedOperation = z.infer<typeof operationSchema>;
const operationKey = (actor: string, store: string, receipt: string, kind: OperationKind) =>
  `pos:cash-manager-command:${actor}:${store}:${receipt}:${kind}`;
function pendingOperation(actor: string, store: string, receipt: string, kind: OperationKind) {
  const value = localStorage.getItem(operationKey(actor, store, receipt, kind));
  if (!value) return null;
  try {
    return operationSchema.parse(JSON.parse(value) as unknown);
  } catch {
    throw new Error(
      'The saved manager request cannot be read. Refresh the receipt and review its audit history.',
    );
  }
}
function clearOperation(actor: string, store: string, receipt: string, kind: OperationKind) {
  localStorage.removeItem(operationKey(actor, store, receipt, kind));
}
async function operationFor(
  actor: string,
  store: string,
  receipt: string,
  kind: OperationKind,
  version: number,
  body: Record<string, string | number>,
  signal: AbortSignal,
) {
  const old = pendingOperation(actor, store, receipt, kind),
    expectedVersion = old?.expectedVersion ?? version,
    bytes = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify({ kind, expectedVersion, ...body })),
    );
  signal.throwIfAborted();
  const hash = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
  if (old && old.hash !== hash)
    throw new Error(
      'An earlier request needs confirmation. Retry its original inputs or refresh the receipt audit first.',
    );
  const value: SavedOperation = old || {
    id: crypto.randomUUID(),
    expectedVersion,
    hash,
    ...(typeof body.approvalId === 'string' ? { approvalId: body.approvalId } : {}),
  };
  signal.throwIfAborted();
  localStorage.setItem(operationKey(actor, store, receipt, kind), JSON.stringify(value));
  return value;
}
function localTimestamp(value: number, zone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(value),
    part = (name: string) => parts.find((item) => item.type === name)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}`;
}
function attributionBounds(value: Detail) {
  return {
    min: localTimestamp(
      Math.ceil(value.authorizationWindow.issuedAt / 1000) * 1000,
      value.authorizationWindow.timeZone,
    ),
    max: localTimestamp(
      Math.floor((value.authorizationWindow.expiresAt - 1) / 1000) * 1000,
      value.authorizationWindow.timeZone,
    ),
  };
}
export function cashManagerAttribution(value: string, window: Detail['authorizationWindow']) {
  const normalized = value.length === 16 ? `${value}:00` : value;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(normalized))
    throw new Error('Choose an attribution time inside the authorization window.');
  const calendar = new Date(normalized + 'Z');
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 19) !== normalized)
    throw new Error('Choose a valid sale date and time.');
  const min = localTimestamp(Math.ceil(window.issuedAt / 1000) * 1000, window.timeZone),
    max = localTimestamp(Math.floor((window.expiresAt - 1) / 1000) * 1000, window.timeZone);
  if (normalized < min || normalized > max || normalized.slice(0, 10) !== window.businessDate)
    throw new Error('Choose an attribution time inside the authorization window.');
  return normalized.replace('T', ' ');
}
function receiptView(detail: Detail): ReceiptView {
  return {
    envelope: detail.envelope,
    acceptance: detail,
    syncState:
      detail.status === 'imported'
        ? 'imported'
        : detail.status === 'conflicted'
          ? 'conflicted'
          : 'accepted',
  };
}

export function CashManagerDialog(props: {
  user: Principal;
  storeId: string;
  online: boolean;
  onClose: () => void;
}) {
  if (!cashManagerAllowed(props.user, props.storeId))
    return (
      <div className="modal-backdrop">
        <section
          className="modal"
          role="dialog"
          aria-modal="true"
          aria-label="Cash receipt manager"
        >
          <button
            className="icon-button modal-close"
            aria-label="Close cash manager"
            onClick={props.onClose}
          >
            <X />
          </button>
          <ErrorState
            error={new Error('A current store manager is required to review cash receipts.')}
          />
        </section>
      </div>
    );
  return <CashManagerWorkspace key={fingerprint(props.user) + ':' + props.storeId} {...props} />;
}
function CashManagerWorkspace({
  user,
  storeId,
  online,
  onClose,
}: {
  user: Principal;
  storeId: string;
  online: boolean;
  onClose: () => void;
}) {
  const client = useQueryClient(),
    controller = useRef<AbortController | null>(null),
    [scopeSignal, setScopeSignal] = useState<AbortSignal | null>(null),
    [local, setLocal] = useState<LocalPage>(emptyLocal),
    [scopeRevision, setScopeRevision] = useState(0),
    [localPage, setLocalPage] = useState(0),
    [status, setStatus] = useState<Status>('conflicted'),
    [cursors, setCursors] = useState<Cursor[]>([null]),
    [selected, setSelected] = useState<string | null>(null),
    [printed, setPrinted] = useState<ReceiptView | null>(null),
    [reason, setReason] = useState(''),
    [attributedAt, setAttributedAt] = useState(''),
    [notice, setNotice] = useState(''),
    [scopeError, setScopeError] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  const scope = fingerprint(user) + ':' + storeId;
  useEffect(() => {
    const current = new AbortController();
    controller.current = current;
    let owner: AbortSignal;
    let live = true;
    const revoke = () => {
      current.abort();
      if (live) {
        setLocal(emptyLocal());
        setPrinted(null);
        setSelected(null);
        setScopeError('Sign in with a current manager session for this store.');
      }
    };
    try {
      owner = captureOperatorScope(user.id);
    } catch {
      revoke();
      return () => {
        live = false;
        current.abort();
      };
    }
    const signal = AbortSignal.any([owner, current.signal]);
    setScopeSignal(signal);
    owner.addEventListener('abort', revoke, { once: true });
    const storage = (event: StorageEvent) => {
      if (event.key === 'pos-pending-logout' && event.newValue) revoke();
    };
    window.addEventListener('storage', storage);
    return () => {
      live = false;
      owner.removeEventListener('abort', revoke);
      window.removeEventListener('storage', storage);
      current.abort();
    };
  }, [scope, scopeRevision, user.id]);
  useEffect(() => {
    if (!scopeSignal || scopeSignal.aborted) return;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const subscription = liveQuery(() =>
      loadCashManagerLocalPage(user, storeId, localPage, { signal: scopeSignal }),
    ).subscribe({
      next: (value) => {
        if (scopeSignal.aborted) return;
        setLocal(value);
        if (expiry) clearTimeout(expiry);
        if (!value.authorized) {
          controller.current?.abort();
          setPrinted(null);
          setSelected(null);
          setScopeError('Sign in with a current manager session for this store.');
          return;
        }
        setScopeError('');
        expiry = setTimeout(
          () => {
            controller.current?.abort();
            setLocal(emptyLocal());
            setPrinted(null);
            setSelected(null);
            setScopeError('Your cached manager session expired. Sign in again.');
          },
          Math.max(0, Math.min(2147483647, value.expiresAt - Date.now())),
        );
      },
      error: () => {
        if (!scopeSignal.aborted) {
          setLocal(emptyLocal());
          setScopeError('The saved manager workspace could not be verified.');
        }
      },
    });
    return () => {
      subscription.unsubscribe();
      if (expiry) clearTimeout(expiry);
    };
  }, [scopeSignal, scope, user, storeId, localPage]);
  async function guard(signal?: AbortSignal) {
    const owner = captureOperatorScope(user.id),
      combined = AbortSignal.any([
        owner,
        ...(scopeSignal ? [scopeSignal] : []),
        ...(signal ? [signal] : []),
      ]);
    combined.throwIfAborted();
    const session = await db.sessions.get('current');
    combined.throwIfAborted();
    if (
      !cashManagerSessionMatches(
        user,
        storeId,
        session,
        Date.now(),
        !!localStorage.getItem('pos-pending-logout'),
      )
    )
      throw new Error('Sign in with a current manager session for this store.');
    return combined;
  }
  const listKey = [user.id, 'cash-manager-list', scope],
    detailKey = [user.id, 'cash-manager-detail', scope, selected],
    page = useQuery({
      queryKey: [...listKey, status, cursors.at(-1)],
      enabled: local.authorized && online,
      queryFn: async ({ signal }) => {
        const captured = await guard(signal),
          value = await listCashReceipts(user.id, storeId, status, cursors.at(-1) || null);
        captured.throwIfAborted();
        await guard(captured);
        return value;
      },
      retry: false,
    }),
    detail = useQuery({
      queryKey: detailKey,
      enabled: local.authorized && online && !!selected,
      queryFn: async ({ signal }) => {
        const captured = await guard(signal),
          value = checkDetail(await readCashReceipt(user.id, storeId, selected!), storeId);
        captured.throwIfAborted();
        await guard(captured);
        return value;
      },
      retry: false,
    });
  useEffect(() => {
    if (!detail.data || !local.authorized) return;
    try {
      for (const kind of ['review', 'approval', 'import'] as const) {
        const saved = pendingOperation(user.id, storeId, detail.data.receiptId, kind);
        if (!saved) continue;
        const expected = kind === 'review' ? 'manager-reviewed' : 'import-approved';
        if (
          kind === 'import'
            ? detail.data.status === 'imported' && !!detail.data.orderId && !!detail.data.importedAt
            : detail.data.auditEvents.some(
                (event) =>
                  event.operationId === saved.id &&
                  event.actorId === user.id &&
                  event.kind === expected,
              )
        ) {
          clearOperation(user.id, storeId, detail.data.receiptId, kind);
          setNotice(
            kind === 'review'
              ? 'Earlier manager review confirmed in the receipt audit. Cash and conflict state are unchanged.'
              : kind === 'approval'
                ? 'Earlier import approval confirmed in the receipt audit. Cash remains unchanged.'
                : 'The authoritative order link is confirmed. Cash remains recorded once.',
          );
        }
      }
    } catch {
      setNotice(
        'A saved request needs review. Check this receipt audit before submitting another action.',
      );
    }
  }, [detail.data, local.authorized, user.id, storeId]);
  const synchronize = useMutation({
    mutationFn: async () => {
      const signal = await guard();
      await replayOfflineCash(user, storeId, { signal });
      signal.throwIfAborted();
      await guard(signal);
    },
    onSuccess: async () => {
      setNotice('Synchronization checked. Unconfirmed receipts remain saved and queued.');
      await client.invalidateQueries({ queryKey: listKey });
      if (selected) await client.invalidateQueries({ queryKey: detailKey });
    },
  });
  const action = useMutation({
    mutationFn: async (kind: OperationKind) => {
      const signal = await guard(),
        value = detail.data;
      if (!online || !value)
        throw new Error('Reconnect and refresh this receipt before continuing.');
      const note = reason.trim();
      if (kind !== 'import' && (!note || note.length > 500))
        throw new Error('Enter a manager note of 1–500 characters.');
      const previous = pendingOperation(user.id, storeId, value.receiptId, kind),
        needsTime = value.conflicts.includes('clock-outside-authorization'),
        approval =
          previous && kind === 'import'
            ? previous.approvalId
            : value.activeApproval?.actorId === user.id &&
                value.activeApproval.receiptVersion === value.version
              ? value.activeApproval.operationId
              : undefined;
      const orderCreatedAt =
        kind === 'approval' && needsTime
          ? cashManagerAttribution(attributedAt, value.authorizationWindow)
          : undefined;
      const body: Record<string, string | number> =
        kind === 'import'
          ? approval
            ? { approvalId: approval }
            : {}
          : { reason: note, ...(orderCreatedAt ? { orderCreatedAt } : {}) };
      const operation = await operationFor(
        user.id,
        storeId,
        value.receiptId,
        kind,
        value.version,
        body,
        signal,
      );
      signal.throwIfAborted();
      await guard(signal);
      let result: CashReceiptAcceptance;
      try {
        result =
          kind === 'review'
            ? await acknowledgeCashReceipt(
                user.id,
                storeId,
                value.receiptId,
                operation.id,
                operation.expectedVersion,
                note,
              )
            : kind === 'approval'
              ? await approveCashReceiptImport(user.id, storeId, value.receiptId, {
                  operationId: operation.id,
                  expectedVersion: operation.expectedVersion,
                  reason: note,
                  ...(orderCreatedAt ? { orderCreatedAt } : {}),
                })
              : await importCashReceiptOrder(user.id, storeId, value.receiptId, {
                  operationId: operation.id,
                  expectedVersion: operation.expectedVersion,
                  ...(operation.approvalId ? { approvalId: operation.approvalId } : {}),
                });
      } catch (error) {
        if (
          !previous &&
          error instanceof ApiError &&
          [400, 403, 404, 409, 422].includes(error.status) &&
          error.code !== 'IDEMPOTENCY_CONFLICT'
        )
          clearOperation(user.id, storeId, value.receiptId, kind);
        throw error;
      }
      signal.throwIfAborted();
      await guard(signal);
      checkAcceptance(result, value.envelope.receipt);
      clearOperation(user.id, storeId, value.receiptId, kind);
      let localRefreshed = true;
      try {
        await refreshOfflineCashReceipt(user, storeId, value.receiptId, { signal });
      } catch {
        signal.throwIfAborted();
        localRefreshed = false;
      }
      await guard(signal);
      return { kind, result, localRefreshed };
    },
    onSuccess: async ({ kind, result, localRefreshed }) => {
      setConfirmed(false);
      setNotice(
        (kind === 'review'
          ? 'Manager review recorded. Cash and conflict state are unchanged.'
          : kind === 'approval'
            ? 'Import approval recorded for this receipt version. Cash remains unchanged.'
            : result.status === 'imported'
              ? 'Order synchronized and linked to the original cash receipt.'
              : 'Cash remains recorded. Review the current import state.') +
          (localRefreshed
            ? ''
            : ' Refresh this device receipt after reconnecting; the server action is recorded.'),
      );
      await client.invalidateQueries({ queryKey: listKey });
      await client.invalidateQueries({ queryKey: detailKey });
    },
    onError: () => {
      void client.invalidateQueries({ queryKey: detailKey });
    },
  });
  const value = detail.data,
    approvalCurrent =
      !!value?.activeApproval &&
      value.activeApproval.actorId === user.id &&
      value.activeApproval.receiptVersion === value.version,
    busy = action.isPending || synchronize.isPending;
  let savedImport = false;
  try {
    savedImport = !!value && !!pendingOperation(user.id, storeId, value.receiptId, 'import');
  } catch {
    /* Unreadable markers require receipt audit reconciliation before a new dispatch. */
  }
  const canImport =
    !!value &&
    value.status !== 'imported' &&
    (savedImport ||
      (value.status !== 'importing' && (value.conflicts.length === 0 || approvalCurrent)));
  if (printed && local.authorized)
    return (
      <CashReceiptDialog
        value={printed}
        operatorId={user.id}
        online={online}
        onClose={() => setPrinted(null)}
      />
    );
  return (
    <div className="modal-backdrop">
      <section
        className="modal"
        style={{
          width: 'min(96vw,72rem)',
          maxWidth: '72rem',
          maxHeight: '90dvh',
          overflow: 'auto',
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cash-manager-title"
      >
        <button
          className="icon-button modal-close"
          aria-label="Close cash manager"
          onClick={onClose}
        >
          <X size={20} />
        </button>
        <div className="eyebrow">STORE CASH RECONCILIATION</div>
        <h2 id="cash-manager-title">Cash receipt manager</h2>
        <p>Store {storeId}. Original receipt amounts and signatures remain intact.</p>
        {scopeError ? (
          <ErrorState
            error={new Error(scopeError)}
            retry={() => setScopeRevision((revision) => revision + 1)}
          />
        ) : !local.authorized ? (
          <Loading />
        ) : (
          <>
            {!online && (
              <p role="status">
                Offline. Saved receipts are available; reconnect to synchronize or record a manager
                action.
              </p>
            )}
            {notice && <p role="status">{notice}</p>}
            {synchronize.isError && <ErrorState error={synchronize.error} />}
            <section className="surface" style={{ padding: '1rem', marginBlock: '1rem' }}>
              <div className="cash-actions">
                <h3>Saved receipts awaiting handoff</h3>
                <button
                  className="button secondary"
                  disabled={!online || busy}
                  onClick={() => synchronize.mutate()}
                >
                  <RefreshCw size={16} />
                  {synchronize.isPending ? 'Synchronizing…' : 'Synchronize saved store receipts'}
                </button>
              </div>
              <p className="cash-status">
                A current checked-in manager can send receipts saved by an operator who has logged
                out. The original operator and signed payment are preserved.
              </p>
              {local.unreadable > 0 && (
                <p role="alert">
                  {local.unreadable} saved entry could not be verified. It remains on this device
                  for reconciliation.
                </p>
              )}
              {local.rows.length ? (
                <div className="table-wrap">
                  <table aria-label="Saved pending cash receipts">
                    <thead>
                      <tr>
                        <th>Receipt</th>
                        <th>Original operator</th>
                        <th>Date</th>
                        <th>Cash</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {local.rows.map((row) => (
                        <tr key={row.ownerId + ':' + row.receiptId}>
                          <td>{row.envelope.receipt.receiptNumber}</td>
                          <td>{row.ownerId}</td>
                          <td>{row.envelope.receipt.businessDate}</td>
                          <td>{cashCurrency(row.envelope.receipt.payableCents)}</td>
                          <td>
                            <button
                              className="button secondary"
                              disabled={busy}
                              onClick={() => setPrinted(row)}
                            >
                              View saved receipt
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty title="No pending receipts on this page">
                  Synchronized receipts remain available in the server list.
                </Empty>
              )}
              <div className="cash-actions">
                <button
                  className="button secondary"
                  disabled={localPage === 0 || busy}
                  onClick={() => setLocalPage((page) => Math.max(0, page - 1))}
                >
                  Previous saved receipts
                </button>
                <button
                  className="button secondary"
                  disabled={!local.hasNext || busy}
                  onClick={() => setLocalPage((page) => page + 1)}
                >
                  Next saved receipts
                </button>
              </div>
            </section>
            <section className="surface" style={{ padding: '1rem', marginBlock: '1rem' }}>
              <div className="cash-actions">
                <h3>Server receipts</h3>
                <label>
                  Status
                  <select
                    aria-label="Cash receipt status"
                    value={status}
                    disabled={busy}
                    onChange={(event) => {
                      setStatus(event.target.value as Status);
                      setCursors([null]);
                      setSelected(null);
                      setReason('');
                      setNotice('');
                      action.reset();
                    }}
                  >
                    {(Object.keys(statuses) as Status[]).map((state) => (
                      <option key={state} value={state}>
                        {statuses[state]}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="button secondary"
                  disabled={!online || page.isFetching || busy}
                  onClick={() => void page.refetch()}
                >
                  Refresh server receipts
                </button>
              </div>
              {page.isError ? (
                <ErrorState error={page.error} retry={() => void page.refetch()} />
              ) : page.isPending ? (
                online ? (
                  <Loading />
                ) : (
                  <p>Reconnect to load the server list.</p>
                )
              ) : page.data.data.length ? (
                <div className="table-wrap">
                  <table aria-label="Server cash receipts">
                    <thead>
                      <tr>
                        <th>Receipt</th>
                        <th>Original operator</th>
                        <th>Business date</th>
                        <th>Cash</th>
                        <th>State</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {page.data.data.map((row) => (
                        <tr key={row.receiptId}>
                          <td>{row.receiptNumber}</td>
                          <td>{row.operatorId}</td>
                          <td>{row.businessDate}</td>
                          <td>{cashCurrency(row.payableCents)}</td>
                          <td>{statuses[row.status]}</td>
                          <td>
                            <button
                              className="button secondary"
                              disabled={!online || busy}
                              onClick={() => {
                                setSelected(row.receiptId);
                                setReason('');
                                setAttributedAt('');
                                setNotice('');
                                setConfirmed(false);
                                action.reset();
                              }}
                            >
                              Review receipt
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty title="No receipts in this state">
                  Choose another state or refresh after synchronization.
                </Empty>
              )}
              <div className="cash-actions">
                <button
                  className="button secondary"
                  disabled={cursors.length === 1 || busy}
                  onClick={() => {
                    setCursors((value) => value.slice(0, -1));
                    setSelected(null);
                  }}
                >
                  Previous server receipts
                </button>
                <button
                  className="button secondary"
                  disabled={!page.data?.nextCursor || busy}
                  onClick={() => {
                    if (page.data?.nextCursor)
                      setCursors((value) => [...value, page.data.nextCursor]);
                    setSelected(null);
                  }}
                >
                  Next server receipts
                </button>
              </div>
            </section>
            {selected && (
              <section
                className="surface"
                style={{ padding: '1rem', marginBlock: '1rem' }}
                aria-label="Selected cash receipt"
              >
                <div className="cash-actions">
                  <h3>Receipt review</h3>
                  <button
                    className="button secondary"
                    disabled={!online || detail.isFetching || busy}
                    onClick={() => void detail.refetch()}
                  >
                    Refresh receipt status
                  </button>
                </div>
                {detail.isError ? (
                  <ErrorState error={detail.error} retry={() => void detail.refetch()} />
                ) : detail.isPending ? (
                  <Loading />
                ) : (
                  value && (
                    <>
                      <p>
                        {value.receiptNumber} · Original operator {value.operatorId} · Version{' '}
                        {value.version}
                      </p>
                      <p>
                        <strong>{statuses[value.status]}</strong> · Paid{' '}
                        {cashCurrency(value.payableCents)} · Received{' '}
                        {cashCurrency(value.cashReceivedCents)} · Change{' '}
                        {cashCurrency(value.changeCents)}
                      </p>
                      <p>
                        Business date {value.businessDate}
                        {value.orderId ? ` · Order ${value.orderId}` : ''}
                        {value.importedAt
                          ? ` · Imported ${new Date(value.importedAt).toLocaleString()}`
                          : ''}
                      </p>
                      {value.conflicts.length > 0 && (
                        <ul>
                          {value.conflicts.map((conflict) => (
                            <li key={conflict}>{conflicts[conflict]}</li>
                          ))}
                        </ul>
                      )}
                      <button
                        className="button secondary"
                        disabled={busy}
                        onClick={() => setPrinted(receiptView(value))}
                      >
                        View receipt / invoice
                      </button>
                      {value.status !== 'imported' && (
                        <>
                          <label>
                            Manager review note
                            <textarea
                              aria-label="Manager review note"
                              maxLength={500}
                              rows={3}
                              value={reason}
                              disabled={busy}
                              onChange={(event) => setReason(event.target.value)}
                            />
                          </label>
                          <p className="cash-status">
                            Recording a review adds an audit entry. It does not clear a conflict,
                            change a payment or import an order.
                          </p>
                          {value.conflicts.includes('clock-outside-authorization') && (
                            <label>
                              Authorized sale time ({value.authorizationWindow.timeZone})
                              <input
                                aria-label="Cash attribution time"
                                type="datetime-local"
                                step="1"
                                min={attributionBounds(value).min}
                                max={attributionBounds(value).max}
                                value={attributedAt}
                                onChange={(event) => setAttributedAt(event.target.value)}
                                disabled={busy}
                              />
                              <small>
                                Choose a time inside the original authorization window on{' '}
                                {value.authorizationWindow.businessDate}.
                              </small>
                            </label>
                          )}
                          <label>
                            <input
                              type="checkbox"
                              checked={confirmed}
                              disabled={busy}
                              onChange={(event) => setConfirmed(event.target.checked)}
                            />
                            I checked the original cash receipt and its current conflicts.
                          </label>
                          <div className="cash-actions">
                            <button
                              className="button secondary"
                              disabled={!online || busy || !reason.trim()}
                              onClick={() => action.mutate('review')}
                            >
                              Record manager review
                            </button>
                            <button
                              className="button secondary"
                              disabled={
                                !online ||
                                busy ||
                                !reason.trim() ||
                                !confirmed ||
                                value.status === 'importing'
                              }
                              onClick={() => action.mutate('approval')}
                            >
                              Approve this import
                            </button>
                            <button
                              className="button primary"
                              disabled={!online || busy || !canImport || !confirmed}
                              onClick={() => action.mutate('import')}
                            >
                              {action.isPending && action.variables === 'import'
                                ? 'Recording action…'
                                : savedImport
                                  ? 'Retry saved import request'
                                  : 'Import authoritative order'}
                            </button>
                          </div>
                          {approvalCurrent && (
                            <p role="status">
                              Your approval is bound to this receipt version. Import still requires
                              current stock and financial checks.
                            </p>
                          )}
                        </>
                      )}
                      {action.isError && <ErrorState error={action.error} />}
                      <details>
                        <summary>Receipt audit ({value.auditEvents.length})</summary>
                        <ul>
                          {value.auditEvents.map((event) => (
                            <li key={event.operationId}>
                              {event.kind.replaceAll('-', ' ')} · Operator {event.actorId} ·{' '}
                              {new Date(event.createdAt).toLocaleString()} ·{' '}
                              <code>{event.operationId}</code>
                            </li>
                          ))}
                        </ul>
                      </details>
                    </>
                  )
                )}
              </section>
            )}
          </>
        )}
      </section>
    </div>
  );
}
