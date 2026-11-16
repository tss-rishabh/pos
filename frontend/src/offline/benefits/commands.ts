import { ApiError, captureOperatorScope } from '../../api/client';
import type { Principal } from '../../api/types';
import { db, type PosDatabase } from '../database';
import { readWalletAdjustment, sendWalletAdjustment } from './client';
import {
  walletAdjustmentReceiptSchema,
  walletAdjustmentSchema,
  type WalletAdjustmentInput,
  type WalletAdjustmentReceipt,
} from './contracts';
import { walletCommandSchema, type WalletCommand } from './storage';

export interface WalletCommandOptions {
  database?: PosDatabase;
  signal?: AbortSignal;
  clock?: () => number;
  read?: typeof readWalletAdjustment;
  send?: typeof sendWalletAdjustment;
}
interface WalletContext {
  database: PosDatabase;
  signal: AbortSignal;
  clock: () => number;
}
function context(user: Principal, options: WalletCommandOptions): WalletContext {
  return {
    database: options.database || db,
    signal: options.signal || captureOperatorScope(user.id),
    clock: options.clock || Date.now,
  };
}
export function walletSessionMatches(
  user: Principal,
  session: { user: Principal; expiresAt: number } | undefined,
  now: number,
  pendingLogout = false,
) {
  return (
    !!session &&
    !pendingLogout &&
    session.expiresAt > now &&
    [1, 2, 3].includes(user.role) &&
    user.userType === 1 &&
    session.user.id === user.id &&
    session.user.role === user.role &&
    session.user.userType === user.userType &&
    JSON.stringify([...session.user.storeIds].sort()) === JSON.stringify([...user.storeIds].sort())
  );
}
async function active(user: Principal, scope: WalletContext) {
  scope.signal.throwIfAborted();
  return walletSessionMatches(
    user,
    await scope.database.sessions.get('current'),
    scope.clock(),
    !!localStorage.getItem('pos-pending-logout'),
  );
}
async function digest(request: WalletAdjustmentInput) {
  const raw = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify({ customerId: request.customerId, adjustment: request.adjustment }),
    ),
  );
  return [...new Uint8Array(raw)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
function checked(command: WalletCommand, ownerId: string) {
  const value = walletCommandSchema.parse(command);
  if (value.ownerId !== ownerId || value.id !== value.request.operationId)
    throw new Error('The saved wallet command requires reconciliation.');
  return value;
}
function assertReceipt(command: WalletCommand, supplied: WalletAdjustmentReceipt) {
  const result = walletAdjustmentReceiptSchema.parse(supplied),
    request = command.request;
  if (
    result.operationId !== command.id ||
    result.operatorId !== command.ownerId ||
    result.customerId !== request.customerId ||
    result.asset !== request.adjustment.asset ||
    result.direction !== request.adjustment.direction ||
    result.amount !== Number(request.adjustment.amount).toFixed(2)
  )
    throw new Error('The wallet receipt does not match the saved adjustment.');
  return result;
}
async function complete(
  user: Principal,
  commandId: string,
  result: WalletAdjustmentReceipt,
  scope: WalletContext,
) {
  const { database, signal, clock } = scope;
  return database.transaction('rw', [database.sessions, database.walletCommands], async () => {
    if (!(await active(user, scope))) return;
    const stored = await database.walletCommands.get(commandId);
    if (!stored) return;
    const command = checked(stored, user.id),
      receipt = assertReceipt(command, result);
    if (command.receipt && JSON.stringify(command.receipt) !== JSON.stringify(receipt))
      throw new Error('The original wallet receipt changed.');
    const value: WalletCommand = {
      ...command,
      state: 'completed',
      receipt,
      attemptId: null,
      claimedAt: null,
      updatedAt: clock(),
    };
    await database.walletCommands.put(value);
    signal.throwIfAborted();
    return value;
  });
}
export async function activeWalletCommand(user: Principal, options: WalletCommandOptions = {}) {
  const scope = context(user, options);
  if (!(await active(user, scope))) return null;
  const pointer = await scope.database.walletCommandOwners.get(user.id),
    command = pointer ? await scope.database.walletCommands.get(pointer.commandId) : undefined;
  if (!pointer) return null;
  if (!command) throw new Error('The active wallet command requires reconciliation.');
  if (!(await active(user, scope))) return null;
  scope.signal.throwIfAborted();
  return checked(command, user.id);
}
/** Captures one immutable command across simultaneous tabs, before any network dispatch. */
export async function prepareWalletAdjustment(
  user: Principal,
  supplied: Omit<WalletAdjustmentInput, 'operationId'>,
  options: WalletCommandOptions = {},
) {
  const scope = context(user, options),
    { database, signal, clock } = scope,
    request = walletAdjustmentSchema.parse({ ...supplied, operationId: crypto.randomUUID() }),
    requestHash = await digest(request);
  signal.throwIfAborted();
  return database.transaction(
    'rw',
    [database.sessions, database.walletCommands, database.walletCommandOwners],
    async () => {
      if (!(await active(user, scope)))
        throw new Error('Sign in with a current internal administrator session.');
      const pointer = await database.walletCommandOwners.get(user.id);
      if (pointer) {
        const stored = await database.walletCommands.get(pointer.commandId);
        if (!stored) throw new Error('The active wallet command requires reconciliation.');
        const original = checked(stored, user.id);
        if (original.requestHash !== requestHash)
          throw new Error('Finish the saved wallet adjustment before starting another.');
        return original;
      }
      const command: WalletCommand = {
        id: request.operationId,
        ownerId: user.id,
        request,
        requestHash,
        state: 'prepared',
        attemptId: null,
        claimedAt: null,
        receipt: null,
        createdAt: clock(),
        updatedAt: clock(),
      };
      await database.walletCommands.add(command);
      await database.walletCommandOwners.add({ ownerId: user.id, commandId: command.id });
      signal.throwIfAborted();
      return command;
    },
  );
}
/** Read-only recovery; a404 never means that another adjustment identity may be created. */
export async function refreshWalletAdjustment(
  user: Principal,
  commandId: string,
  options: WalletCommandOptions = {},
) {
  const scope = context(user, options);
  if (!(await active(user, scope))) return;
  const stored = await scope.database.walletCommands.get(commandId);
  if (!stored) return;
  const command = checked(stored, user.id);
  try {
    const result = await (options.read || readWalletAdjustment)(user.id, command.id);
    scope.signal.throwIfAborted();
    return await complete(user, command.id, assertReceipt(command, result), scope);
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status === 404 &&
      error.code === 'WALLET_ADJUSTMENT_NOT_FOUND'
    )
      return;
    throw error;
  }
}
/** A new first dispatch is automatic only for the explicit submit that prepared it. */
export async function dispatchWalletAdjustment(
  user: Principal,
  commandId: string,
  options: WalletCommandOptions = {},
  retry = false,
) {
  const scope = context(user, options),
    { database, signal, clock } = scope;
  if (retry) {
    const proved = await refreshWalletAdjustment(user, commandId, { ...options, ...scope });
    if (proved) return proved;
  }
  if (!(await active(user, scope))) return;
  const previewRow = await database.walletCommands.get(commandId);
  if (!previewRow) return;
  const preview = checked(previewRow, user.id),
    previewHash = await digest(preview.request);
  signal.throwIfAborted();
  const command = await database.transaction(
    'rw',
    [database.sessions, database.walletCommands, database.walletCommandOwners],
    async () => {
      if (!(await active(user, scope))) return;
      const pointer = await database.walletCommandOwners.get(user.id),
        stored = await database.walletCommands.get(commandId);
      if (!stored || pointer?.commandId !== commandId) return;
      const current = checked(stored, user.id);
      if (current.state === 'completed') return;
      if (!retry && current.state !== 'prepared') return;
      if (retry && current.state === 'dispatching' && (current.claimedAt || 0) + 30000 > clock())
        throw new Error('The wallet adjustment is still in progress. Check its status shortly.');
      if (
        previewHash !== current.requestHash ||
        JSON.stringify(current.request) !== JSON.stringify(preview.request)
      )
        throw new Error('The saved wallet command changed.');
      const next: WalletCommand = {
        ...current,
        state: 'dispatching',
        attemptId: crypto.randomUUID(),
        claimedAt: clock(),
        updatedAt: clock(),
      };
      await database.walletCommands.put(next);
      signal.throwIfAborted();
      return next;
    },
  );
  if (!command) return;
  try {
    if (!(await active(user, scope))) return;
    const result = await (options.send || sendWalletAdjustment)(user.id, command.request);
    signal.throwIfAborted();
    return await complete(user, command.id, assertReceipt(command, result), scope);
  } catch (error) {
    if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return;
    await database.transaction('rw', [database.sessions, database.walletCommands], async () => {
      if (!(await active(user, scope))) return;
      const current = await database.walletCommands.get(command.id);
      if (
        current?.ownerId !== user.id ||
        current.attemptId !== command.attemptId ||
        current.state !== 'dispatching'
      )
        return;
      await database.walletCommands.update(command.id, {
        state: 'uncertain',
        attemptId: null,
        claimedAt: null,
        updatedAt: clock(),
      });
      signal.throwIfAborted();
    });
    throw error;
  }
}
/** Clears only a proved completed active pointer; the financial command and receipt remain. */
export async function beginNewWalletAdjustment(
  user: Principal,
  completedId: string,
  options: WalletCommandOptions = {},
) {
  const scope = context(user, options),
    { database, signal } = scope;
  return database.transaction(
    'rw',
    [database.sessions, database.walletCommands, database.walletCommandOwners],
    async () => {
      if (!(await active(user, scope))) return false;
      const pointer = await database.walletCommandOwners.get(user.id),
        stored = await database.walletCommands.get(completedId);
      if (pointer?.commandId !== completedId || !stored) return false;
      const command = checked(stored, user.id);
      if (command.state !== 'completed' || !command.receipt)
        throw new Error('Confirm the saved wallet adjustment before starting another.');
      assertReceipt(command, command.receipt);
      await database.walletCommandOwners.delete(user.id);
      signal.throwIfAborted();
      return true;
    },
  );
}
