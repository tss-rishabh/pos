import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, setRequestOperator } from '../src/api/client';
import type { Principal } from '../src/api/types';
import { PosDatabase, type LocalDraft } from '../src/offline/database';
import {
  activeFastCash,
  completeFastCash,
  prepareFastCash,
  refreshFastCash,
  releaseFastCash,
  retireLocallyCompletedFastCash,
} from '../src/offline/fast-cash/commands';
import { completeSale } from '../src/offline/complete-sale';
import type { FastCashApi } from '../src/offline/fast-cash/client';
import type { CashPayment, FastCashCommand } from '../src/offline/fast-cash/contracts';
import { cashIntentAmounts } from '../src/offline/fast-cash/contracts';
import { checkoutSchema, type Checkout } from '../src/pages/checkout/client';
import { checkoutSalespersonLines, hasCashSalespeople } from '../src/pages/checkout/salespeople';

describe('durable owner-bound fast cash orchestration', () => {
  it('preserves original cash/default amounts across17 pinned helper cases and rejects cash for a zero-total prepaid sale', () => {
    const vectors = z
      .object({
        sourceCommit: z.literal('78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'),
        cases: z.array(
          z.object({
            payable: z.string(),
            received: z.string(),
            helperSuccess: z.boolean(),
            result: z.object({ status: z.number(), message: z.string() }),
            calls: z.array(
              z.object({
                cash: z.number(),
                cashReceived: z.number(),
                online: z.literal(0),
                orderId: z.literal('9007199254740993'),
                isTerminal: z.literal(false),
              }),
            ),
          }),
        ),
      })
      .parse(JSON.parse(readFileSync('tests/fast-cash-source-vectors.json', 'utf8')) as unknown);
    expect(vectors.cases).toHaveLength(17);
    for (const vector of vectors.cases) {
      const planned = cashIntentAmounts(vector.payable, vector.received);
      if (vector.payable === '0.00') {
        expect(vector.calls).toEqual([]);
        expect(vector.result.status).toBe(400);
        continue;
      }
      expect(Number(planned.payable)).toBe(vector.calls[0]!.cash);
      expect(Number(planned.cashReceived)).toBe(vector.calls[0]!.cashReceived);
      expect(vector.result.status).toBe(vector.helperSuccess ? 200 : 400);
    }
    expect(() => cashIntentAmounts('0.00', '10.00')).toThrow('requires no cash');
  });
  const user: Principal = {
      id: '44',
      name: 'Fixture cashier',
      email: 'fixture@example.test',
      role: 5,
      userType: 1,
      storeIds: ['1'],
    },
    storage = new Map<string, string>();
  let database: PosDatabase,
    peer: PosDatabase | undefined,
    draft: LocalDraft,
    checkout: Checkout,
    server: Checkout,
    payment: CashPayment | null,
    now: number,
    submissions: FastCashCommand[],
    payments: FastCashCommand[],
    api: FastCashApi;
  const options = () => ({ database, clock: () => now, api });
  const prepare = (received = '100.00') =>
    prepareFastCash(user, draft, checkout, received, options());
  async function submit(command: FastCashCommand) {
    submissions.push(command);
    expect((await database.fastCashCommands.get(command.id))?.state).toBe('submitting');
    server = {
      ...server,
      version: server.version + 1,
      phase: 'submitted',
      orderId: '9007199254740993',
      orderSubmissionOperationId: command.submissionId,
      confirmationPhase: 'acknowledged',
      settlement:
        command.payable === '0.00'
          ? {
              status: 'paid',
              source: 'prepaid',
              receiptId: command.submissionId,
              checkoutOperationId: command.submissionId,
              checkoutId: command.checkoutId,
              orderId: '9007199254740993',
              transactionId: 'FIXTURE-PREPAID',
              cashAmount: '0.00',
              onlineAmount: '0.00',
            }
          : null,
    };
    return { status: 'succeeded' as const, state: server, operationId: command.submissionId };
  }
  async function pay(command: FastCashCommand) {
    payments.push(command);
    expect((await database.fastCashCommands.get(command.id))?.state).toBe('paying');
    payment = {
      id: command.paymentId,
      operatorId: user.id,
      storeId: '1',
      counterId: '3',
      orderId: command.orderId!,
      channel: 'cash',
      cashAmount: command.payable,
      onlineAmount: '0.00',
      cashReceived: command.cashReceived,
      checkoutNote: command.noteHash
        ? { checkoutId: command.checkoutId, noteHash: command.noteHash }
        : null,
      status: 'paid',
      transactionId: 'FIXTURE-CASH',
      errorCode: null,
    };
    return payment;
  }
  beforeEach(async () => {
    storage.clear();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) || null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    setRequestOperator(user.id);
    now = Date.parse('2026-11-16T04:30:00Z');
    submissions = [];
    payments = [];
    payment = null;
    database = new PosDatabase('fast-cash-' + crypto.randomUUID());
    draft = {
      id: crypto.randomUUID(),
      ownerId: user.id,
      storeId: '1',
      counterId: '3',
      customerId: null,
      version: 0,
      updatedAt: 123,
      createdAt: 100,
      lines: [
        {
          productId: '10',
          quantity: 1,
          name: 'Fixture product',
          barcode: null,
          unitPrice: '99.95',
        },
      ],
    };
    checkout = checkoutSchema.parse({
      id: crypto.randomUUID(),
      operatorId: user.id,
      draftId: draft.id,
      draftVersion: draft.updatedAt,
      draftImport: {
        lineItems: [{ productId: '10', quantity: 1 }],
        completedProductIds: ['10'],
        status: 'complete',
      },
      storeId: '1',
      counterId: '3',
      version: 3,
      customerId: null,
      salespersonId: '5',
      lineSalespersons: {},
      settlementNote: { hash: 'a'.repeat(64), payable: '99.95', cashReceived: '100.00' },
      verifiedCustomerUntil: null,
      phase: 'quoted',
      orderId: null,
      cart: { products: { items: [{ prod_id: '10', quantity: 1 }] } },
      quote: { meta: { items: [{ name: 'calculations', total: '99.95' }] } },
      busyOperationId: null,
      giftCards: {},
    });
    server = structuredClone(checkout);
    await database.sessions.put({ id: 'current', user, expiresAt: now + 3600000 });
    await database.drafts.put(draft);
    await database.reviewSnapshots.put({
      ownerId: user.id,
      draftId: draft.id,
      snapshot: draft,
      createdAt: now,
      checkoutId: checkout.id,
    });
    api = {
      readCheckout: async () => structuredClone(server),
      readSubmission: async (command) => {
        if (server.phase !== 'submitted')
          throw new ApiError(404, 'OPERATION_NOT_FOUND', 'Controlled missing result');
        return {
          status: 'succeeded',
          state: structuredClone(server),
          operationId: command.submissionId,
        };
      },
      submit,
      readPayment: async () => {
        if (!payment)
          throw new ApiError(404, 'PAYMENT_ATTEMPT_NOT_FOUND', 'Controlled missing payment');
        return structuredClone(payment);
      },
      paymentOptions: async () => ({ payable: '99.95', options: [{ channel: 'cash' }] }),
      pay,
    };
  });
  afterEach(async () => {
    peer?.close();
    peer = undefined;
    database.close();
    await database.delete();
    setRequestOperator(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it('requires source cash salesperson assignments before persisting an intent or dispatching an order', async () => {
    checkout.salespersonId = null;
    await expect(prepare()).rejects.toThrow('salespeople');
    checkout.salespersonId = '2147483648';
    await expect(prepare()).rejects.toThrow('salespeople');
    expect(await database.fastCashCommands.count()).toBe(0);
    expect(submissions).toHaveLength(0);
    expect(payments).toHaveLength(0);
    checkout.salespersonId = '5';
    checkout.lineSalespersons = { '10': '6' };
    expect((await prepare()).state).toBe('prepared');
  });
  it('includes complementary products and exact large SKU IDs in salesperson overrides', () => {
    if (!checkout.cart) throw new Error('Fixture cart required');
    checkout.cart.complementary_products = {
      items: [{ prod_id: '9007199254740993', quantity: 1, product: 'Complimentary fixture' }],
    };
    expect(checkoutSalespersonLines(checkout)).toEqual([
      { id: '10', name: 'Product 10' },
      { id: '9007199254740993', name: 'Complimentary fixture' },
    ]);
    checkout.lineSalespersons = { '9007199254740993': '2147483648' };
    expect(hasCashSalespeople(checkout)).toBe(false);
    checkout.lineSalespersons['9007199254740993'] = '6';
    expect(hasCashSalespeople(checkout)).toBe(true);
  });
  it('binds the server-held note to the exact cash intent without persisting its text', async () => {
    checkout.settlementNote = null;
    await expect(prepare()).rejects.toThrow('payment note');
    checkout.settlementNote = { hash: 'a'.repeat(64), payable: '99.95', cashReceived: '99.95' };
    await expect(prepare()).rejects.toThrow('payment note');
    checkout.settlementNote.cashReceived = '100.00';
    server = structuredClone(checkout);
    const command = await prepare();
    expect(command.noteHash).toBe('a'.repeat(64));
    expect(Object.keys(command).some((key) => /message|text/i.test(key))).toBe(false);
    api.pay = async (value) => ({
      ...(await pay(value)),
      checkoutNote: { checkoutId: value.checkoutId, noteHash: 'b'.repeat(64) },
    });
    await expect(completeFastCash(user, command.id, options())).rejects.toThrow(
      'original cash intent',
    );
    expect((await database.fastCashCommands.get(command.id))?.receipt).toBeNull();
  });
  it('captures20 tabs once and dispatches one order/one cash settlement without changing the local draft', async () => {
    peer = new PosDatabase(database.name);
    const reordered = {
      ...checkout,
      quote: { meta: { items: [{ total: '99.95', name: 'calculations' }] } },
    };
    const commands = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        prepareFastCash(user, draft, index % 2 ? reordered : checkout, '100.00', {
          ...options(),
          database: index % 2 ? peer : database,
        }),
      ),
    );
    expect(new Set(commands.map((value) => value.id)).size).toBe(1);
    const id = commands[0]!.id;
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        completeFastCash(user, id, { ...options(), database: index % 2 ? peer : database }),
      ),
    );
    expect(submissions).toHaveLength(1);
    expect(payments).toHaveLength(1);
    expect((await database.fastCashCommands.get(id))?.receipt).toMatchObject({
      source: 'counter',
      receiptId: commands[0]!.paymentId,
      cashAmount: '99.95',
    });
    expect(await database.drafts.get([user.id, draft.id])).toEqual(draft);
  });
  it('recovers a lost committed order by GET only until an explicit cash continuation', async () => {
    const command = await prepare();
    api.submit = async (value) => {
      await submit(value);
      throw new Error('controlled lost order reply');
    };
    await expect(completeFastCash(user, command.id, options())).rejects.toThrow('lost order reply');
    const name = database.name;
    database.close();
    database = new PosDatabase(name);
    for (let count = 0; count < 30; count++) await refreshFastCash(user, command.id, options());
    expect(submissions).toHaveLength(1);
    expect(payments).toHaveLength(0);
    expect((await completeFastCash(user, command.id, options(), true)).command.state).toBe('paid');
    expect(submissions).toHaveLength(1);
    expect(payments).toHaveLength(1);
  });
  it('uses the exact saved submission UUID/version after a lost never-committed response', async () => {
    const command = await prepare();
    api.submit = async (value) => {
      submissions.push(value);
      throw new Error('controlled no response');
    };
    await expect(completeFastCash(user, command.id, options())).rejects.toThrow();
    for (let count = 0; count < 30; count++) await refreshFastCash(user, command.id, options());
    expect(submissions).toHaveLength(1);
    now += 31000;
    api.submit = submit;
    expect((await completeFastCash(user, command.id, options(), true)).command.state).toBe('paid');
    expect(submissions).toHaveLength(2);
    expect(new Set(submissions.map((value) => value.submissionId)).size).toBe(1);
    expect(new Set(submissions.map((value) => value.checkoutVersion)).size).toBe(1);
  });
  it('recovers a lost committed payment across reopen without collecting cash again', async () => {
    const command = await prepare();
    api.pay = async (value) => {
      await pay(value);
      throw new Error('controlled lost paid reply');
    };
    await expect(completeFastCash(user, command.id, options())).rejects.toThrow();
    const name = database.name;
    database.close();
    database = new PosDatabase(name);
    expect((await refreshFastCash(user, command.id, options())).command.state).toBe('paid');
    await completeFastCash(user, command.id, options(), true);
    expect(submissions).toHaveLength(1);
    expect(payments).toHaveLength(1);
  });
  it('retries only the original payment body after an explicit GET404', async () => {
    const command = await prepare();
    api.pay = async (value) => {
      payments.push(value);
      throw new Error('controlled missing paid result');
    };
    await expect(completeFastCash(user, command.id, options())).rejects.toThrow();
    for (let count = 0; count < 20; count++) await refreshFastCash(user, command.id, options());
    expect(payments).toHaveLength(1);
    api.pay = pay;
    now += 31000;
    expect((await completeFastCash(user, command.id, options(), true)).command.state).toBe('paid');
    expect(payments).toHaveLength(2);
    expect(payments[1]).toMatchObject({
      paymentId: payments[0]!.paymentId,
      payable: '99.95',
      cashReceived: '100.00',
    });
    expect(submissions).toHaveLength(1);
  });
  it('uses canonical prepaid evidence for a zero total without a cash attempt', async () => {
    checkout.quote = { meta: { items: [{ name: 'calculations', total: 0 }] } };
    server = structuredClone(checkout);
    const command = await prepare('0');
    const result = await completeFastCash(user, command.id, options());
    expect(result.command.state).toBe('paid');
    expect(result.command.receipt).toMatchObject({
      source: 'prepaid',
      receiptId: command.submissionId,
      cashAmount: '0.00',
    });
    expect(payments).toHaveLength(0);
  });
  it('rejects changed money, scope and absent snapshot before publishing a paid receipt', async () => {
    const command = await prepare();
    api.pay = async (value) => ({ ...(await pay(value)), cashReceived: '999.00' });
    await expect(completeFastCash(user, command.id, options())).rejects.toThrow('does not match');
    expect((await database.fastCashCommands.get(command.id))?.receipt).toBeNull();
    checkout.settlementNote = { hash: 'b'.repeat(64), payable: '99.95', cashReceived: '101.00' };
    await expect(prepare('101.00')).rejects.toThrow('saved cash intent');
    await expect(
      prepareFastCash(user, draft, { ...checkout, counterId: '4' }, '100.00', options()),
    ).rejects.toThrow();
    checkout.settlementNote = { hash: 'a'.repeat(64), payable: '99.95', cashReceived: '100.00' };
    await database.reviewSnapshots.delete([user.id, draft.id]);
    await expect(prepare()).rejects.toThrow('original reviewed');
  });
  it('stops before cash dispatch after an actor or cached-role change during order creation', async () => {
    const command = await prepare();
    api.submit = async (value) => {
      const result = await submit(value);
      setRequestOperator('99');
      return result;
    };
    await expect(completeFastCash(user, command.id, options())).rejects.toThrow();
    expect(payments).toHaveLength(0);
    expect((await database.fastCashCommands.get(command.id))?.receipt).toBeNull();
    setRequestOperator(user.id);
    await database.sessions.put({
      id: 'current',
      user: { ...user, storeIds: [] },
      expiresAt: now + 3600000,
    });
    await expect(refreshFastCash(user, command.id, options())).rejects.toThrow(
      'authorized operator',
    );
  });
  it('requires the durable local claim and recovers a failed local paid checkpoint by GET', async () => {
    const add = vi
      .spyOn(database.fastCashCommands, 'add')
      .mockRejectedValueOnce(new Error('controlled local prepare failure'));
    await expect(prepare()).rejects.toThrow('local prepare');
    expect(submissions).toHaveLength(0);
    expect(await activeFastCash(user, '1', '3', options())).toBeNull();
    add.mockRestore();
    const command = await prepare(),
      original = database.fastCashCommands.put.bind(database.fastCashCommands);
    vi.spyOn(database.fastCashCommands, 'put').mockImplementation((value, ...args) => {
      if (value.state === 'paid') throw new Error('controlled local paid failure');
      return original(value, ...args);
    });
    await expect(completeFastCash(user, command.id, options())).rejects.toThrow('local paid');
    vi.restoreAllMocks();
    expect((await refreshFastCash(user, command.id, options())).command.state).toBe('paid');
    expect(payments).toHaveLength(1);
  });
  it('keeps its lane until completeSale conserves newer cart content, then retires only the matched receipt', async () => {
    const command = await prepare(),
      result = await completeFastCash(user, command.id, options());
    expect(await retireLocallyCompletedFastCash(user, command.id, options())).toBe(false);
    await database.drafts.put({
      ...draft,
      updatedAt: draft.updatedAt + 1,
      lines: draft.lines.map((line) => ({ ...line, quantity: 2 })),
    });
    if (!result.command.receipt) throw new Error('Expected writer-confirmed cash evidence');
    await completeSale(draft, result.command.receipt, database);
    expect(await retireLocallyCompletedFastCash(user, command.id, options())).toBe(true);
    expect(await database.fastCashOwners.get([user.id, '1', '3'])).toBeUndefined();
    expect(await database.fastCashCommands.get(command.id)).toMatchObject({
      state: 'paid',
      receipt: result.command.receipt,
    });
    const preserved = await database.drafts.toArray();
    expect(preserved).toHaveLength(1);
    expect(preserved[0]!.id).not.toBe(draft.id);
    expect(preserved[0]!.lines[0]!.quantity).toBe(2);
  });
  it('does not let a stale GET overwrite a newer payment claim or reset attempt counts', async () => {
    const command = await prepare();
    let releaseOrder!: () => void,
      orderCommitted!: () => void,
      releaseRead!: () => void,
      readStarted!: () => void,
      releasePayment!: () => void,
      paymentStarted!: () => void;
    const orderGate = new Promise<void>((resolve) => {
        releaseOrder = resolve;
      }),
      orderReady = new Promise<void>((resolve) => {
        orderCommitted = resolve;
      }),
      readGate = new Promise<void>((resolve) => {
        releaseRead = resolve;
      }),
      readReady = new Promise<void>((resolve) => {
        readStarted = resolve;
      }),
      paymentGate = new Promise<void>((resolve) => {
        releasePayment = resolve;
      }),
      paymentReady = new Promise<void>((resolve) => {
        paymentStarted = resolve;
      });
    api.submit = async (value) => {
      const result = await submit(value);
      orderCommitted();
      await orderGate;
      return result;
    };
    const completion = completeFastCash(user, command.id, options());
    await orderReady;
    api.readCheckout = async () => {
      readStarted();
      await readGate;
      return structuredClone(server);
    };
    const recovery = refreshFastCash(user, command.id, options());
    await readReady;
    api.pay = async (value) => {
      paymentStarted();
      await paymentGate;
      return pay(value);
    };
    releaseOrder();
    await paymentReady;
    const current = await database.fastCashCommands.get(command.id);
    expect(current?.state).toBe('paying');
    releaseRead();
    await recovery;
    const later = await database.fastCashCommands.get(command.id);
    expect(later?.claimId).toBe(current?.claimId);
    expect(later?.paymentAttempts).toBe(1);
    expect(later?.state).toBe('paying');
    releasePayment();
    expect((await completion).command.state).toBe('paid');
    expect(payments).toHaveLength(1);
  });
  it('retains immutable paid evidence when its lane is released and old callbacks cannot remove a newer pointer', async () => {
    const command = await prepare();
    await completeFastCash(user, command.id, options());
    await releaseFastCash(user, command.id, options());
    const newer = crypto.randomUUID();
    await database.fastCashOwners.put({
      ownerId: user.id,
      storeId: '1',
      counterId: '3',
      commandId: newer,
    });
    await releaseFastCash(user, command.id, options());
    expect((await database.fastCashOwners.get([user.id, '1', '3']))?.commandId).toBe(newer);
    expect((await database.fastCashCommands.get(command.id))?.state).toBe('paid');
  });
});
