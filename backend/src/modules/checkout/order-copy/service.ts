import type { Config } from '../../../config.js';
import type { Principal } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import { currentRequestTrace } from '../../../observability/context.js';
import type { Cart, CheckoutState } from '../contracts.js';
import { operationHash } from '../crypto.js';
import {
  copyCommandSchema,
  copyFactsSchema,
  copyReviewSchema,
  type CopyCartPort,
  type CopyCommand,
  type CopyFactsPort,
  type CopyReview,
  type CopyScope,
  type CopySource,
} from './contracts.js';
import {
  assertCopiedStep,
  cartCopyHash,
  copyManifest,
  copySteps,
  draftOriginHash,
  OrderCopyPreflightError,
} from './domain.js';
import { orderCopyCommands, orderCopyReviews } from './schema.js';
import { copyCutoff } from './reader.js';
import type { OrderCopyRepository } from './repository.js';
import { orderCopyCancellations } from './schema.js';
import {
  copyCancellationInputSchema,
  copyCancellationReceiptSchema,
  type CopyCancellationInput,
} from './cancellation-contracts.js';
import { verifyCopyCancellation } from './cancellation-evidence.js';

const conflict = () =>
  new AppError(
    409,
    'ORDER_COPY_CONTEXT_CHANGED',
    'Reload the original copy reference before continuing.',
  );
function publicReview(review: CopyReview) {
  const { customerAuthority: _customerAuthority, ...value } = review;
  return value;
}
function editable(state: CheckoutState) {
  if (
    state.busyOperationId ||
    state.phase === 'uncertain' ||
    state.orderId ||
    !['open', 'quoted'].includes(state.phase) ||
    (state.orderCopy && state.orderCopy.status !== 'acknowledged')
  )
    throw conflict();
}
export function orderCopyService(
  config: Config,
  repository: OrderCopyRepository,
  facts: CopyFactsPort,
  cart: CopyCartPort,
  clock = Date.now,
) {
  const secret = config.SESSION_SECRET;
  const hash = (kind: string, value: unknown) =>
    operationHash('order-copy.' + kind + '.v1', value, secret);
  const reviewHash = (value: Omit<CopyReview, 'hash'>) => hash('review', value);
  function stopped(
    row: NonNullable<Awaited<ReturnType<OrderCopyRepository['cancellation']>>>,
    state: CheckoutState,
    user: Principal,
  ) {
    if (user.id !== state.operatorId) throw conflict();
    return verifyCopyCancellation(row, state, secret);
  }
  async function cancellation(user: Principal, scope: CopyScope, id: string) {
    return repository.ownerScope(user, scope, async (tx, state) => {
      const row = await repository.cancellation(tx, id);
      return row ? stopped(row, state, user) : null;
    });
  }
  function validReview(review: CopyReview) {
    const { hash: expected, ...body } = review;
    if (reviewHash(body) !== expected) throw conflict();
  }
  function bound(command: CopyCommand, state: CheckoutState, user: Principal) {
    if (
      command.review.operatorId !== user.id ||
      command.review.checkoutId !== state.id ||
      command.review.storeId !== state.storeId ||
      command.review.counterId !== state.counterId ||
      command.review.customerId !== state.customerId ||
      command.review.originHash !== draftOriginHash(state, secret)
    )
      throw conflict();
    validReview(command.review);
    const intent = (steps: CopyCommand['steps']) =>
      steps.map(({ id, productId, sourceLineIds, beforeQuantity, targetQuantity }) => ({
        id,
        productId,
        sourceLineIds,
        beforeQuantity,
        targetQuantity,
      }));
    if (hash('steps', intent(command.steps)) !== hash('steps', intent(command.review.steps)))
      throw conflict();
    if (
      ['review-required', 'acknowledged'].includes(command.status) &&
      (!command.result ||
        !command.resultHash ||
        command.resultHash !==
          hash('result', {
            commandId: command.id,
            originHash: command.review.originHash,
            result: command.result,
            steps: command.steps,
          }) ||
        command.steps.some((step) => step.status === 'dispatched'))
    )
      throw conflict();
  }
  function view(command: CopyCommand, state: CheckoutState) {
    if (command.status === 'cancelled-unsent') throw conflict();
    const uncertain =
      command.status === 'pending' &&
      command.steps.some((step) => step.status === 'dispatched') &&
      command.leaseUntil <= clock();
    return {
      id: command.id,
      reviewId: command.review.id,
      source: command.review.source,
      status: uncertain ? 'uncertain' : command.status,
      steps: command.steps,
      result: command.result,
      resultHash: command.resultHash,
      partial: command.partial,
      errorCode: command.errorCode,
      originHash: command.review.originHash,
      checkoutVersion: state.version,
      acknowledgementId: command.acknowledgementId,
      canContinue:
        command.status === 'pending' &&
        command.leaseUntil <= clock() &&
        !command.steps.some((step) => step.status === 'dispatched'),
    };
  }
  async function read(user: Principal, scope: CopyScope, id: string) {
    return repository.ownerScope(user, scope, async (tx, owned) => {
      const row = await repository.cancellation(tx, id);
      if (row) return stopped(row, owned, user);
      const state = await repository.activeState(tx, owned, true);
      const command = await repository.command(tx, id);
      if (!command) throw new AppError(404, 'ORDER_COPY_NOT_FOUND', 'Copy operation not found.');
      bound(command, state, user);
      await repository.source(tx, user, command.review.source, {
        state,
        kind: 'command',
        authority: command.review.customerAuthority,
      });
      return view(command, state);
    });
  }
  async function update(
    user: Principal,
    scope: CopyScope,
    id: string,
    leaseId: string,
    action: (
      command: CopyCommand,
      state: CheckoutState,
    ) => Promise<{ command: CopyCommand; state: CheckoutState }>,
  ) {
    return repository.scope(user, scope, async (tx, state) => {
      const command = await repository.command(tx, id);
      if (!command) throw conflict();
      bound(command, state, user);
      await repository.source(tx, user, command.review.source, {
        state,
        kind: 'command',
        authority: command.review.customerAuthority,
      });
      if (
        command.leaseId !== leaseId ||
        command.status !== 'pending' ||
        state.busyOperationId !== id ||
        state.orderCopy?.commandId !== id
      )
        throw conflict();
      const next = await action(command, state);
      copyCommandSchema.parse(next.command);
      await repository.save(tx, next.command);
      await repository.state(tx, next.state);
      return next;
    });
  }
  async function complete(
    user: Principal,
    scope: CopyScope,
    id: string,
    leaseId: string,
    currentCart: Cart,
    partial: boolean,
    errorCode: string | null,
  ) {
    return update(user, scope, id, leaseId, async (command, state) => {
      if (
        command.steps.some((step) => step.status === 'dispatched') ||
        (!partial && command.steps.some((step) => step.status !== 'confirmed'))
      )
        throw conflict();
      const result = copyManifest(currentCart),
        resultHash = hash('result', {
          commandId: id,
          originHash: command.review.originHash,
          result,
          steps: command.steps,
        });
      return {
        command: {
          ...command,
          status: 'review-required',
          result,
          resultHash,
          currentHash: cartCopyHash(currentCart, secret),
          partial,
          errorCode,
        },
        state: {
          ...state,
          cart: currentCart,
          quote: null,
          phase: 'open',
          busyOperationId: id,
          version: state.version + 1,
          updatedAt: clock(),
          orderCopy: {
            commandId: id,
            reviewId: command.review.id,
            originHash: command.review.originHash,
            status: 'review-required',
            resultHash,
          },
        },
      };
    });
  }
  async function execute(user: Principal, scope: CopyScope, id: string, leaseId: string) {
    try {
      for (;;) {
        const loaded = await update(user, scope, id, leaseId, async (command, state) => ({
          command,
          state,
        }));
        const index = loaded.command.steps.findIndex((step) => step.status === 'not-dispatched');
        const before = await cart.read(loaded.state);
        if (cartCopyHash(before, secret) !== loaded.command.currentHash) {
          await complete(user, scope, id, leaseId, before, true, 'ORDER_COPY_BASE_CART_CHANGED');
          break;
        }
        if (index < 0) {
          await complete(user, scope, id, leaseId, before, false, null);
          break;
        }
        const step = loaded.command.steps[index]!;
        if (!(await repository.available(step.productId, scope.storeId, step.targetQuantity))) {
          await update(user, scope, id, leaseId, async (command, state) => ({
            command: {
              ...command,
              steps: command.steps.map((value, i) =>
                i === index
                  ? { ...value, status: 'unavailable', errorCode: 'ORDER_COPY_PRODUCT_UNAVAILABLE' }
                  : value,
              ),
            },
            state,
          }));
          await complete(user, scope, id, leaseId, before, true, 'ORDER_COPY_PRODUCT_UNAVAILABLE');
          break;
        }
        await update(user, scope, id, leaseId, async (command, state) => {
          if (command.steps[index]?.status !== 'not-dispatched') throw conflict();
          return {
            command: {
              ...command,
              steps: command.steps.map((value, i) =>
                i === index ? { ...value, status: 'dispatched' } : value,
              ),
            },
            state,
          };
        });
        // Every error after this checkpoint is uncertain unless the local
        // before-write guard proves no mutation was sent. Never infer failure
        // or causal success from the cart's resulting quantities.
        let changed: CheckoutState;
        try {
          changed = await cart.setLine(
            loaded.state,
            step.id,
            step.productId,
            step.targetQuantity,
            loaded.command.currentHash,
          );
        } catch (error) {
          if (error instanceof OrderCopyPreflightError) {
            const current = await cart.read(loaded.state);
            await update(user, scope, id, leaseId, async (command, state) => ({
              command: {
                ...command,
                steps: command.steps.map((value, i) =>
                  i === index ? { ...value, status: 'unavailable', errorCode: error.code } : value,
                ),
              },
              state,
            }));
            await complete(user, scope, id, leaseId, current, true, error.code);
            break;
          }
          throw error;
        }
        if (!changed.cart) throw conflict();
        assertCopiedStep(before, changed.cart, step.productId, step.targetQuantity);
        const currentHash = cartCopyHash(changed.cart, secret);
        await update(user, scope, id, leaseId, async (command, state) => {
          if (command.steps[index]?.status !== 'dispatched') throw conflict();
          return {
            command: {
              ...command,
              currentHash,
              steps: command.steps.map((value, i) =>
                i === index ? { ...value, status: 'confirmed' } : value,
              ),
            },
            state: {
              ...state,
              cart: changed.cart,
              giftCards: changed.giftCards,
              giftCardDates: changed.giftCardDates,
              giftCardValues: changed.giftCardValues,
              quote: null,
              phase: 'open',
            },
          };
        });
      }
    } catch {
      // Preserve original error only as a static event code. Raw responses,
      // cart bodies, contacts, tokens and SQL errors never enter logs/DTOs.
      try {
        await update(user, scope, id, leaseId, async (command, state) => ({
          command: { ...command, status: 'uncertain', errorCode: 'ORDER_COPY_OUTCOME_UNCERTAIN' },
          state: {
            ...state,
            phase: 'uncertain',
            orderCopy:
              state.orderCopy && state.orderCopy.status !== 'cancelled-unsent'
                ? { ...state.orderCopy, status: 'uncertain' }
                : state.orderCopy,
          },
        }));
      } catch {
        /* original durable dispatch remains authoritative */
      }
    }
    return read(user, scope, id);
  }
  return {
    read,
    async cancelUnsent(user: Principal, scope: CopyScope, id: string, raw: CopyCancellationInput) {
      const input = copyCancellationInputSchema.parse(raw);
      if (input.original.operationId !== id) throw conflict();
      return repository.ownerScope(user, scope, async (tx, state) => {
        const requestHash = hash('request', input.original),
          prior = await repository.cancellation(tx, id);
        if (prior) {
          const receipt = stopped(prior, state, user);
          if (receipt.originalRequestHash !== requestHash) throw conflict();
          return receipt;
        }
        const command = await repository.command(tx, id);
        if (command) {
          bound(command, state, user);
          if (
            command.requestHash !== requestHash ||
            command.status !== 'pending' ||
            command.result !== null ||
            command.partial ||
            command.errorCode !== null ||
            command.steps.some((step) => step.status !== 'not-dispatched')
          )
            throw new AppError(
              409,
              'ORDER_COPY_ALREADY_DISPATCHED',
              'This copy has dispatched or uncertain work. Reconcile its original outcome.',
            );
        }
        if (
          state.busyOperationId &&
          (state.busyOperationId !== id || !command || state.orderCopy?.commandId !== id)
        )
          throw conflict();
        if (
          state.orderCopy &&
          state.orderCopy.commandId !== id &&
          state.orderCopy.status !== 'acknowledged'
        )
          throw conflict();
        const review = await repository.review(tx, input.original.reviewId);
        if (
          review &&
          (review.operatorId !== user.id ||
            review.checkoutId !== state.id ||
            review.storeId !== state.storeId ||
            review.counterId !== state.counterId)
        )
          throw conflict();
        const byReview = await repository.occupiedReview(tx, input.original.reviewId);
        if (byReview && byReview.id !== id) throw conflict();
        const bind =
            !state.orderId &&
            (['open', 'quoted'].includes(state.phase) ||
              (state.phase === 'uncertain' &&
                command !== null &&
                state.orderCopy?.commandId === id)),
          version = state.version + (bind ? 1 : 0);
        const receipt = copyCancellationReceiptSchema.parse({
          status: 'cancelled-unsent',
          id,
          reviewId: input.original.reviewId,
          cancellationId: input.operationId,
          checkoutId: state.id,
          operatorId: user.id,
          storeId: state.storeId,
          counterId: state.counterId,
          originalRequestHash: requestHash,
          cancelledAt: clock(),
          checkoutVersion: version,
          requiresOnlineClear: true,
          markerRequired: true,
          source: null,
          steps: [],
          result: null,
          resultHash: null,
          originHash: null,
          partial: false,
          errorCode: null,
          acknowledgementId: null,
          canContinue: false,
        });
        await tx.insert(orderCopyCancellations).values({
          copyId: id,
          cancellationId: receipt.cancellationId,
          checkoutId: state.id,
          operatorId: user.id,
          requestHash,
          receiptHash: hash('cancellation', { receipt, originalCommand: command }),
          receipt,
          originalCommand: command,
        });
        if (command)
          await repository.save(tx, {
            ...command,
            status: 'cancelled-unsent',
            leaseId: crypto.randomUUID(),
            leaseUntil: 0,
          });
        else
          await tx.insert(orderCopyCommands).values({
            id,
            reviewId: input.original.reviewId,
            checkoutId: state.id,
            operatorId: user.id,
            data: receipt,
          });
        if (bind)
          await repository.state(tx, {
            ...state,
            version,
            quote: null,
            phase: 'open',
            busyOperationId: state.busyOperationId === id ? null : state.busyOperationId,
            orderCopy: {
              status: 'cancelled-unsent',
              commandId: id,
              reviewId: receipt.reviewId,
              cancellationId: receipt.cancellationId,
            },
            updatedAt: clock(),
          });
        return receipt;
      });
    },
    async cancellation(user: Principal, scope: CopyScope, id: string, cancellationId: string) {
      const receipt = await cancellation(user, scope, id);
      if (!receipt || receipt.cancellationId !== cancellationId)
        throw new AppError(
          404,
          'ORDER_COPY_CANCELLATION_NOT_FOUND',
          'The original unsent cancellation was not found.',
        );
      return receipt;
    },
    async review(user: Principal, scope: CopyScope, id: string) {
      return repository.scope(
        user,
        scope,
        async (tx, state) => {
          const review = await repository.review(tx, id);
          if (
            !review ||
            review.operatorId !== user.id ||
            review.checkoutId !== state.id ||
            review.customerId !== state.customerId
          )
            throw new AppError(404, 'ORDER_COPY_REVIEW_NOT_FOUND', 'Copy review not found.');
          validReview(review);
          const command = await repository.commandForReview(tx, review.id);
          if (command) {
            bound(command, state, user);
            if (command.review.hash !== review.hash) throw conflict();
          }
          await repository.source(tx, user, review.source, {
            state,
            kind: command ? 'command' : 'review',
            authority: command?.review.customerAuthority ?? review.customerAuthority,
          });
          return publicReview(review);
        },
        true,
      );
    },
    async current(user: Principal, scope: CopyScope) {
      return repository.ownerScope(user, scope, async (tx, owned) => {
        if (owned.orderCopy?.status === 'cancelled-unsent') {
          const row = await repository.cancellation(tx, owned.orderCopy.commandId);
          if (!row || row.cancellationId !== owned.orderCopy.cancellationId) throw conflict();
          return stopped(row, owned, user);
        }
        const state = await repository.activeState(tx, owned, true);
        if (!state.orderCopy) return null;
        const command = await repository.command(tx, state.orderCopy.commandId);
        if (!command) throw conflict();
        bound(command, state, user);
        await repository.source(tx, user, command.review.source, {
          state,
          kind: 'command',
          authority: command.review.customerAuthority,
        });
        return view(command, state);
      });
    },
    async prepare(
      user: Principal,
      scope: CopyScope,
      input: { reviewId: string; expectedVersion: number; source: CopySource },
    ) {
      const initial = await repository.scope(user, scope, async (tx, state) => {
        const existing = await repository.review(tx, input.reviewId);
        if (existing) {
          validReview(existing);
          if (
            existing.operatorId !== user.id ||
            existing.checkoutId !== state.id ||
            existing.customerId !== state.customerId ||
            hash('source', existing.source) !== hash('source', input.source)
          )
            throw conflict();
          await repository.source(tx, user, input.source, {
            state,
            kind: 'review',
            authority: existing.customerAuthority,
          });
          return { existing, state, customerAuthority: existing.customerAuthority };
        }
        editable(state);
        if (state.version !== input.expectedVersion) throw conflict();
        draftOriginHash(state, secret);
        const customerAuthority = await repository.source(tx, user, input.source, {
          state,
          kind: 'new',
        });
        return { existing: null, state, customerAuthority };
      });
      if (initial.existing) return publicReview(initial.existing);
      const sourceFacts = copyFactsSchema.parse(
        await facts.read({
          source: input.source,
          targetCustomerId: initial.state.customerId,
          cutoff: copyCutoff(config, clock()),
        }),
      );
      if (
        sourceFacts.orderId !== input.source.orderId ||
        (input.source.kind === 'customer'
          ? sourceFacts.sourceCustomerId !== initial.state.customerId
          : sourceFacts.sourceStoreId !== input.source.storeId)
      )
        throw conflict();
      const current = await cart.read(initial.state),
        before = copyManifest(current),
        body = {
          id: input.reviewId,
          checkoutId: scope.checkoutId,
          operatorId: user.id,
          storeId: scope.storeId,
          counterId: initial.state.counterId,
          customerId: initial.state.customerId,
          checkoutVersion: initial.state.version,
          originHash: draftOriginHash(initial.state, secret),
          beforeHash: cartCopyHash(current, secret),
          source: input.source,
          ...(initial.customerAuthority ? { customerAuthority: initial.customerAuthority } : {}),
          facts: sourceFacts,
          before,
          steps: copySteps(sourceFacts, before),
          expiresAt: clock() + 5 * 60_000,
        };
      const review = copyReviewSchema.parse({ ...body, hash: reviewHash(body) });
      return repository.scope(user, scope, async (tx, state) => {
        editable(state);
        await repository.source(tx, user, input.source, {
          state,
          kind: 'review',
          authority: review.customerAuthority,
        });
        if (
          state.version !== initial.state.version ||
          state.customerId !== review.customerId ||
          draftOriginHash(state, secret) !== review.originHash
        )
          throw conflict();
        await tx
          .insert(orderCopyReviews)
          .values({ id: review.id, checkoutId: state.id, operatorId: user.id, data: review })
          .onDuplicateKeyUpdate({ set: { id: review.id } });
        const saved = await repository.review(tx, review.id);
        if (
          !saved ||
          saved.operatorId !== user.id ||
          saved.checkoutId !== state.id ||
          saved.customerId !== review.customerId ||
          saved.checkoutVersion !== input.expectedVersion ||
          saved.originHash !== review.originHash ||
          hash('source', saved.source) !== hash('source', input.source)
        )
          throw conflict();
        validReview(saved);
        return publicReview(saved);
      });
    },
    async start(
      user: Principal,
      scope: CopyScope,
      input: {
        operationId: string;
        reviewId: string;
        manifestHash: string;
        expectedVersion: number;
      },
    ) {
      const reserved = await repository.ownerScope(user, scope, async (tx, owned) => {
        const prior = await repository.cancellation(tx, input.operationId);
        if (prior) {
          const receipt = stopped(prior, owned, user);
          if (receipt.originalRequestHash !== hash('request', input)) throw conflict();
          return { kind: 'cancelled' as const, cancellation: receipt };
        }
        const state = await repository.activeState(tx, owned);
        const existing = await repository.command(tx, input.operationId);
        const requestHash = hash('request', input);
        if (existing) {
          bound(existing, state, user);
          await repository.source(tx, user, existing.review.source, {
            state,
            kind: 'command',
            authority: existing.review.customerAuthority,
          });
          if (existing.requestHash !== requestHash) throw conflict();
          return { kind: 'reserved' as const, command: existing, replay: true };
        }
        editable(state);
        const review = await repository.review(tx, input.reviewId);
        if (!review) throw conflict();
        validReview(review);
        await repository.source(tx, user, review.source, {
          state,
          kind: 'review',
          authority: review.customerAuthority,
        });
        if (
          review.hash !== input.manifestHash ||
          review.expiresAt <= clock() ||
          review.operatorId !== user.id ||
          review.checkoutId !== state.id ||
          review.customerId !== state.customerId ||
          review.counterId !== state.counterId ||
          review.checkoutVersion !== state.version ||
          input.expectedVersion !== state.version ||
          review.originHash !== draftOriginHash(state, secret)
        )
          throw conflict();
        const command = copyCommandSchema.parse({
          id: input.operationId,
          review,
          requestHash,
          status: 'pending',
          steps: review.steps,
          currentHash: review.beforeHash,
          result: null,
          resultHash: null,
          partial: false,
          leaseId: crypto.randomUUID(),
          leaseUntil: clock() + 60_000,
          continuations: [],
          errorCode: null,
          requestId: currentRequestTrace()?.requestId ?? null,
          acknowledgementId: null,
        });
        await tx.insert(orderCopyCommands).values({
          id: command.id,
          reviewId: review.id,
          checkoutId: state.id,
          operatorId: user.id,
          data: command,
        });
        await repository.state(tx, {
          ...state,
          quote: null,
          phase: 'open',
          busyOperationId: command.id,
          orderCopy: {
            commandId: command.id,
            reviewId: review.id,
            originHash: review.originHash,
            status: 'pending',
            resultHash: null,
          },
        });
        return { kind: 'reserved' as const, command, replay: false };
      });
      if (reserved.kind === 'cancelled') return reserved.cancellation;
      return reserved.replay
        ? read(user, scope, input.operationId)
        : execute(user, scope, input.operationId, reserved.command.leaseId);
    },
    async continue(
      user: Principal,
      scope: CopyScope,
      id: string,
      input: { operationId: string; expectedVersion: number },
    ) {
      const cancelled = await cancellation(user, scope, id);
      if (cancelled) return cancelled;
      const claimed = await repository.scope(user, scope, async (tx, state) => {
        const command = await repository.command(tx, id);
        if (!command) throw conflict();
        bound(command, state, user);
        await repository.source(tx, user, command.review.source, {
          state,
          kind: 'command',
          authority: command.review.customerAuthority,
        });
        if (command.continuations.includes(input.operationId)) return null;
        if (
          command.status !== 'pending' ||
          command.leaseUntil > clock() ||
          command.steps.some((step) => step.status === 'dispatched') ||
          state.version !== input.expectedVersion ||
          command.continuations.length >= 100 ||
          state.busyOperationId !== id
        )
          throw conflict();
        const next = {
          ...command,
          leaseId: crypto.randomUUID(),
          leaseUntil: clock() + 60_000,
          continuations: [...command.continuations, input.operationId],
        };
        await repository.save(tx, next);
        return next;
      });
      return claimed ? execute(user, scope, id, claimed.leaseId) : read(user, scope, id);
    },
    async acknowledge(
      user: Principal,
      scope: CopyScope,
      id: string,
      input: { operationId: string; expectedVersion: number; resultHash: string },
    ) {
      const cancelled = await cancellation(user, scope, id);
      if (cancelled) return cancelled;
      return repository.scope(user, scope, async (tx, state) => {
        const command = await repository.command(tx, id);
        if (!command) throw conflict();
        bound(command, state, user);
        await repository.source(tx, user, command.review.source, {
          state,
          kind: 'command',
          authority: command.review.customerAuthority,
        });
        if (command.status === 'acknowledged') {
          if (
            command.acknowledgementId !== input.operationId ||
            command.resultHash !== input.resultHash
          )
            throw conflict();
          return view(command, state);
        }
        if (
          command.status !== 'review-required' ||
          !command.resultHash ||
          command.resultHash !== input.resultHash ||
          !command.result ||
          state.orderCopy?.commandId !== id ||
          state.orderCopy.status !== 'review-required' ||
          state.orderCopy.resultHash !== input.resultHash ||
          state.busyOperationId !== id ||
          state.version !== input.expectedVersion
        )
          throw conflict();
        const next: CopyCommand = {
          ...command,
          status: 'acknowledged',
          acknowledgementId: input.operationId,
        };
        const changed: CheckoutState = {
          ...state,
          busyOperationId: null,
          version: state.version + 1,
          updatedAt: clock(),
          orderCopy: { ...state.orderCopy, status: 'acknowledged' },
        };
        await repository.save(tx, next);
        await repository.state(tx, changed);
        return view(next, changed);
      });
    },
  };
}
export type OrderCopyService = ReturnType<typeof orderCopyService>;
