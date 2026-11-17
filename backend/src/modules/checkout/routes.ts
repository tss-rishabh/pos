import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { authenticated } from '../../auth/routes.js';
import { identifier } from '../../domain/validation.js';
import { checkInService } from '../administration/checkins.js';
import type { StockProcedure } from '../administration/stock-procedure.js';
import {
  amountSchema,
  mutationSchema,
  draftLineItemsSchema,
  orderNotificationsSchema,
  type CheckoutRepository,
} from './contracts.js';
import { checkoutRepository } from './repository.js';
import {
  checkoutEnvironment,
  checkoutGateway,
  type CheckoutEnvironment,
  type CheckoutGateway,
} from './gateway.js';
import {
  checkoutService,
  publicState,
  type CheckoutServiceOptions,
  type MutationReply,
} from './service.js';
import { orderFinalizer, prepaidSettlementReader } from './finalizer.js';
import { returnReadService } from './returns.js';
import { registerPayments } from './payments/routes.js';
import type { PaymentGateway } from './payments/contracts.js';
import { registerReturns } from './return-workflow/routes.js';
import type { ReturnGateway } from './return-workflow/contracts.js';
import type { ReturnEnvironment } from './return-workflow/gateway.js';
import { registerInvoices } from './invoices.js';
import { discountApprovals } from './discounts/repository.js';
import { discountPolicy, discountRemark, storeDiscountReasons } from './discounts/policy.js';
import { assertDiscountDeliveryReady, discountDeliveryEnvironment } from './discounts/delivery.js';
import type { DiscountApprovals } from './discounts/contracts.js';
import { assertCheckoutProjection } from './projection.js';
import { assertOrderRefundAllocations } from './refund-allocation.js';
import { phoneOtpDelivery } from '../../auth/delivery.js';
import { customerRegistrationService, registrationEnvironment } from './customers/service.js';
import { registrationDetailsSchema, type CustomerRegistrations } from './customers/contracts.js';
import { registerOfflineCash } from './offline-cash/routes.js';
import type { OfflineCashServiceOptions } from './offline-cash/service.js';
import { registerWalletAdjustments } from './benefit-adjustments/routes.js';
import { settlementMessageSchema } from './settlement-note.js';
import {
  customerOtpService,
  readCustomerOtpOptions,
  createCustomerOtpDelivery,
} from '../customer-otp/index.js';
import type { CustomerVerificationClient } from './customer-verification.js';
import { registerPendingOrderCancellations } from './cancellations/routes.js';
import { pendingCancellationOptions } from './cancellations/options.js';
import type { PendingCancellationOptions } from './cancellations/options.js';
import { registerOrderCopy, type OrderCopyOptions } from './order-copy/routes.js';
import type { PaymentCorrectionPort } from './payment-reversals/evidence.js';

const storeScope = z.object({ storeId: identifier });
const sessionScope = storeScope.extend({ checkoutId: z.uuid() });
const base = '/api/v1/stores/:storeId/checkout-sessions';
const session = base + '/:checkoutId';
const trace = (resource: string, action: string) => ({
  config: { trace: { module: 'checkout', resource, action } },
});
export interface CheckoutRegistrationOptions {
  paymentCorrections?: PaymentCorrectionPort;
  orderCopy?: OrderCopyOptions;
  repository?: CheckoutRepository;
  gateway?: CheckoutGateway;
  environment?: CheckoutEnvironment;
  assertCheckIn?: CheckoutServiceOptions['assertCheckIn'];
  finalizeOrder?: CheckoutServiceOptions['finalizeOrder'];
  prepaidSettlement?: CheckoutServiceOptions['prepaidSettlement'];
  verifyProjection?: CheckoutServiceOptions['verifyProjection'];
  verifyRefundAllocations?: CheckoutServiceOptions['verifyRefundAllocations'];
  paymentGateway?: PaymentGateway;
  returnGateway?: ReturnGateway;
  returnEnvironment?: ReturnEnvironment;
  inventoryProcedureVerified?: boolean;
  stockProcedure?: StockProcedure;
  discounts?: DiscountApprovals;
  registrations?: CustomerRegistrations;
  offlineCash?: OfflineCashServiceOptions;
  customerOtp?: CustomerVerificationClient;
  pendingCancellations?: PendingCancellationOptions;
}
export function registerCheckout(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  overrides: CheckoutRegistrationOptions = {},
) {
  const environment = overrides.environment || checkoutEnvironment();
  const repository = overrides.repository || checkoutRepository(db),
    gateway = overrides.gateway || checkoutGateway(config, environment);
  const checkIns = checkInService(db, config);
  const otpOptions = readCustomerOtpOptions(),
    customerOtp =
      overrides.customerOtp ||
      customerOtpService(config, db, otpOptions, createCustomerOtpDelivery(config, otpOptions));
  const assertCheckIn =
    overrides.assertCheckIn ||
    ((...args: Parameters<CheckoutServiceOptions['assertCheckIn']>) =>
      checkIns.assertCheckIn(...args));
  const service = checkoutService(repository, gateway, environment, {
    orderCopyHashSecret: config.SESSION_SECRET,
    migrationV2: config.TSS_API_MIGRATION_V2,
    businessTimezone: config.BUSINESS_TIMEZONE,
    assertCheckIn,
    customerOtp,
    registrations:
      overrides.registrations ||
      customerRegistrationService(
        db,
        gateway,
        registrationEnvironment(),
        phoneOtpDelivery(),
        config.BUSINESS_TIMEZONE,
      ),
    finalizeOrder: overrides.finalizeOrder || orderFinalizer(db, config),
    prepaidSettlement: overrides.prepaidSettlement || prepaidSettlementReader(db),
    verifyProjection:
      overrides.verifyProjection ||
      ((state, orderId) =>
        db.get('writer').transaction((tx) =>
          assertCheckoutProjection(tx, {
            orderId,
            storeId: state.storeId,
            counterId: state.counterId,
            customerId: state.customerId || state.operatorCustomerId,
          }),
        )),
    verifyRefundAllocations:
      overrides.verifyRefundAllocations ||
      ((state, orderId) =>
        db.get('writer').transaction((tx) =>
          assertOrderRefundAllocations(tx, {
            orderId,
            storeId: state.storeId,
            counterId: state.counterId,
            customerId: state.customerId || state.operatorCustomerId,
          }),
        )),
    discounts:
      overrides.discounts ||
      discountApprovals(db, config, {
        signingSecret: environment.hs256 || environment.hs512 || '',
        approvalSecret: discountDeliveryEnvironment().approvalSecret,
        policy: discountPolicy(),
        assertDeliveryReady: () => assertDiscountDeliveryReady(discountDeliveryEnvironment()),
      }),
  });
  const returns = returnReadService(db, gateway, assertCheckIn);
  function response(result: MutationReply) {
    return { ...result, state: publicState(result.state) };
  }
  app.post(base, trace('checkout-session', 'create'), async (request, reply) => {
    const user = authenticated(request),
      { storeId } = storeScope.parse(request.params),
      body = z
        .object({
          counterId: identifier,
          draftId: z.uuid(),
          draftVersion: z.number().int().nonnegative(),
          lineItems: draftLineItemsSchema,
        })
        .strict()
        .parse(request.body);
    const created = await service.create(user, storeId, body.counterId, body.draftId, {
      version: body.draftVersion,
      lineItems: body.lineItems,
    });
    return reply.code(201).send(created);
  });
  app.get(session, trace('checkout-session', 'read'), async (request) => {
    const user = authenticated(request),
      p = sessionScope.parse(request.params);
    return service.read(user, p.storeId, p.checkoutId);
  });
  app.post(
    session + '/confirmation-reconciliations',
    trace('checkout-confirmation', 'reconcile'),
    async (request) => {
      const user = authenticated(request),
        p = sessionScope.parse(request.params),
        body = mutationSchema.strict().parse(request.body);
      return response(await service.reconcileConfirmation(user, p.storeId, p.checkoutId, body));
    },
  );
  app.put(
    session + '/order-notifications',
    trace('order-notification', 'configure'),
    async (request) => {
      const user = authenticated(request),
        p = sessionScope.parse(request.params),
        body = mutationSchema
          .extend({ sendSms: z.boolean(), npsFeedback: z.boolean() })
          .strict()
          .parse(request.body);
      const preferences = orderNotificationsSchema.parse({
        sendSms: body.sendSms,
        npsFeedback: body.npsFeedback,
      });
      return response(
        await service.orderNotifications(user, p.storeId, p.checkoutId, body, preferences),
      );
    },
  );
  app.post(
    session + '/draft-initializations',
    trace('checkout-draft', 'initialize'),
    async (request) => {
      const user = authenticated(request),
        p = sessionScope.parse(request.params),
        body = mutationSchema.strict().parse(request.body);
      return response(await service.initializeDraft(user, p.storeId, p.checkoutId, body));
    },
  );
  app.post(
    '/api/v1/stores/:storeId/customer-lookups',
    trace('customer-lookup', 'create'),
    async (request) => {
      const user = authenticated(request),
        p = storeScope.parse(request.params),
        body = z
          .object({
            query: z.union([z.email().max(254), z.string().regex(/^\d{10,15}$/)]),
            counterId: identifier,
          })
          .strict()
          .parse(request.body);
      return { data: await service.lookup(user, p.storeId, body.counterId, body.query) };
    },
  );
  app.put(session + '/customer', trace('checkout-customer', 'attach'), async (request) => {
    const user = authenticated(request),
      p = sessionScope.parse(request.params),
      body = mutationSchema.extend({ customerId: identifier }).strict().parse(request.body);
    return response(
      await service.attachCustomer(user, p.storeId, p.checkoutId, body, body.customerId),
    );
  });
  app.post(
    session + '/customer-detachments',
    trace('checkout-customer', 'detach'),
    async (request) => {
      const user = authenticated(request),
        p = sessionScope.parse(request.params),
        body = mutationSchema.strict().parse(request.body);
      return response(await service.detachCustomer(user, p.storeId, p.checkoutId, body));
    },
  );
  app.post(
    session + '/customer-registration-challenges',
    trace('customer-registration-challenge', 'create'),
    async (request) => {
      const user = authenticated(request),
        p = sessionScope.parse(request.params),
        body = mutationSchema
          .extend({ details: registrationDetailsSchema })
          .strict()
          .parse(request.body);
      return response(
        await service.requestRegistration(user, p.storeId, p.checkoutId, body, body.details),
      );
    },
  );
  app.post(
    session + '/customer-registration-challenges/verifications',
    trace('customer-registration-challenge', 'verify'),
    async (request) => {
      const user = authenticated(request),
        p = sessionScope.parse(request.params),
        body = mutationSchema
          .extend({ code: z.string().regex(/^\d{6}$/) })
          .strict()
          .parse(request.body);
      return response(
        await service.verifyRegistration(user, p.storeId, p.checkoutId, body, body.code),
      );
    },
  );
  app.post(
    session + '/customer-registration-challenges/resends',
    trace('customer-registration-challenge', 'resend'),
    async (request) => {
      const user = authenticated(request),
        p = sessionScope.parse(request.params),
        body = mutationSchema.strict().parse(request.body);
      return response(await service.resendRegistration(user, p.storeId, p.checkoutId, body));
    },
  );
  app.post(
    session + '/customer-registrations',
    trace('customer-registration', 'create'),
    async (request) => {
      const user = authenticated(request),
        p = sessionScope.parse(request.params),
        body = mutationSchema.strict().parse(request.body);
      return response(await service.registerCustomer(user, p.storeId, p.checkoutId, body));
    },
  );
  app.post(
    session + '/customer-registration-reconciliations',
    trace('customer-registration', 'reconcile'),
    async (request) => {
      const user = authenticated(request),
        p = sessionScope.parse(request.params),
        body = mutationSchema.strict().parse(request.body);
      return response(await service.reconcileRegistration(user, p.storeId, p.checkoutId, body));
    },
  );
  app.post(
    session + '/customer-registration-cancellations',
    trace('customer-registration', 'cancel'),
    async (request) => {
      const user = authenticated(request),
        p = sessionScope.parse(request.params),
        body = mutationSchema.strict().parse(request.body);
      return response(await service.cancelRegistration(user, p.storeId, p.checkoutId, body));
    },
  );
  app.post(
    session + '/customer-registration-request-reconciliations',
    trace('customer-registration-request', 'reconcile'),
    async (request) => {
      const user = authenticated(request),
        p = sessionScope.parse(request.params),
        body = mutationSchema.strict().parse(request.body);
      return response(
        await service.recoverRegistrationRequest(user, p.storeId, p.checkoutId, body),
      );
    },
  );
  app.put(session + '/line-items/:productId', trace('cart-line', 'set'), async (request) => {
    const user = authenticated(request),
      p = sessionScope.extend({ productId: identifier }).parse(request.params),
      body = mutationSchema
        .extend({ quantity: z.number().int().min(0).max(999) })
        .strict()
        .parse(request.body);
    return response(
      await service.setLine(user, p.storeId, p.checkoutId, body, p.productId, body.quantity),
    );
  });
  app.post(session + '/clear', trace('checkout-cart', 'clear'), async (request) => {
    const user = authenticated(request),
      p = sessionScope.parse(request.params),
      body = mutationSchema.strict().parse(request.body);
    return response(await service.clear(user, p.storeId, p.checkoutId, body));
  });
  app.put(session + '/coupon', trace('checkout-coupon', 'apply'), async (request) => {
    const user = authenticated(request),
      p = sessionScope.parse(request.params),
      body = mutationSchema
        .extend({ code: z.string().min(1).max(100) })
        .strict()
        .parse(request.body);
    return response(await service.coupon(user, p.storeId, p.checkoutId, body, body.code));
  });
  for (const kind of ['coupon', 'gift-voucher'] as const)
    app.post(
      session + (kind === 'coupon' ? '/coupon/removals' : '/gift-vouchers/removals'),
      trace(kind === 'coupon' ? 'checkout-coupon' : 'checkout-gift-voucher', 'remove'),
      async (request) => {
        const user = authenticated(request),
          p = sessionScope.parse(request.params),
          body = mutationSchema.strict().parse(request.body);
        return response(await service.removeBenefit(user, p.storeId, p.checkoutId, body, kind));
      },
    );
  app.put(session + '/wallet', trace('checkout-wallet', 'update'), async (request) => {
    const user = authenticated(request),
      p = sessionScope.parse(request.params),
      body = mutationSchema
        .extend({
          money: z.boolean(),
          points: z.boolean(),
          appliedMoney: amountSchema,
          custom: z.boolean(),
        })
        .strict()
        .parse(request.body);
    return response(await service.wallet(user, p.storeId, p.checkoutId, body, body));
  });
  app.post(session + '/gift-vouchers', trace('checkout-gift-voucher', 'apply'), async (request) => {
    const user = authenticated(request),
      p = sessionScope.parse(request.params),
      body = mutationSchema
        .extend({ code: z.string().min(1).max(100), pin: z.string().regex(/^[\d_]{4,20}$/) })
        .strict()
        .parse(request.body);
    return response(
      await service.giftVoucher(user, p.storeId, p.checkoutId, body, body.code, body.pin),
    );
  });
  app.put(
    session + '/membership-benefits',
    trace('checkout-membership', 'update'),
    async (request) => {
      const user = authenticated(request),
        p = sessionScope.parse(request.params),
        body = mutationSchema.extend({ enabled: z.boolean() }).strict().parse(request.body);
      return response(await service.exclusive(user, p.storeId, p.checkoutId, body, body.enabled));
    },
  );
  app.put(
    session + '/gift-card-items/:giftId',
    trace('checkout-gift-card', 'save'),
    async (request) => {
      const user = authenticated(request),
        p = sessionScope.extend({ giftId: identifier }).parse(request.params),
        body = mutationSchema
          .extend({
            number: z.string().regex(/^[\d_]{6,40}$/),
            startDate: z.iso.date(),
            endDate: z.iso.date(),
          })
          .strict()
          .parse(request.body);
      return response(
        await service.giftCardMetadata(user, p.storeId, p.checkoutId, body, p.giftId, body),
      );
    },
  );
  app.post(
    session + '/gift-card-items/:giftId/removals',
    trace('checkout-gift-card', 'remove'),
    async (request) => {
      const user = authenticated(request),
        p = sessionScope.extend({ giftId: identifier }).parse(request.params),
        body = mutationSchema.strict().parse(request.body);
      return response(await service.removeGiftCard(user, p.storeId, p.checkoutId, body, p.giftId));
    },
  );
  app.post(session + '/gift-card-items', trace('checkout-gift-card', 'add'), async (request) => {
    const user = authenticated(request),
      p = sessionScope.parse(request.params),
      body = mutationSchema
        .extend({
          productId: identifier,
          customValue: z.number().int().min(1).max(10000).optional(),
        })
        .strict()
        .parse(request.body);
    return response(
      await service.addGiftCard(
        user,
        p.storeId,
        p.checkoutId,
        body,
        body.productId,
        body.customValue,
      ),
    );
  });
  app.put(
    session + '/gift-card-items/:giftId/value',
    trace('checkout-gift-card', 'value'),
    async (request) => {
      const user = authenticated(request),
        p = sessionScope.extend({ giftId: identifier }).parse(request.params),
        body = mutationSchema
          .extend({ customValue: z.number().int().min(1).max(10000).nullable() })
          .strict()
          .parse(request.body);
      return response(
        await service.giftCardValue(
          user,
          p.storeId,
          p.checkoutId,
          body,
          p.giftId,
          body.customValue,
        ),
      );
    },
  );
  app.put(session + '/discount', trace('checkout-discount', 'update'), async (request) => {
    const user = authenticated(request),
      p = sessionScope.parse(request.params),
      body = mutationSchema
        .extend({
          kind: z.enum(['pg', 'store']),
          amount: amountSchema,
          apply: z.boolean(),
          remark: discountRemark.optional(),
          reason: z.enum(storeDiscountReasons).optional(),
        })
        .strict()
        .refine(
          (value) => !value.apply || Boolean(value.remark && (value.kind === 'pg' || value.reason)),
          { message: 'A discount remark and store discount reason are required.' },
        )
        .parse(request.body);
    return response(await service.discount(user, p.storeId, p.checkoutId, body, body));
  });
  app.get(session + '/discount-approval', trace('discount-approval', 'read'), async (request) => {
    const user = authenticated(request),
      p = sessionScope.parse(request.params);
    return service.discountApproval(user, p.storeId, p.checkoutId);
  });
  app.post(
    session + '/discount-approval/challenges',
    trace('discount-approval', 'request'),
    async (request) => {
      const user = authenticated(request),
        p = sessionScope.parse(request.params),
        body = mutationSchema.strict().parse(request.body);
      return response(await service.requestDiscountApproval(user, p.storeId, p.checkoutId, body));
    },
  );
  app.post(
    session + '/discount-approval/confirmations',
    trace('discount-approval', 'confirm'),
    async (request) => {
      const user = authenticated(request),
        p = sessionScope.parse(request.params),
        body = mutationSchema
          .extend({ code: z.string().regex(/^[1-9]{6}$/) })
          .strict()
          .parse(request.body);
      return response(
        await service.confirmDiscountApproval(user, p.storeId, p.checkoutId, body, body.code),
      );
    },
  );
  app.put(session + '/salesperson', trace('checkout-salesperson', 'assign'), async (request) => {
    const user = authenticated(request),
      p = sessionScope.parse(request.params),
      body = mutationSchema
        .extend({ salespersonId: identifier, productId: identifier.optional() })
        .strict()
        .parse(request.body);
    return response(
      await service.salesperson(
        user,
        p.storeId,
        p.checkoutId,
        body,
        body.salespersonId,
        body.productId,
      ),
    );
  });
  app.get(
    session + '/settlement-note',
    trace('checkout-settlement-note', 'read'),
    async (request) => {
      const user = authenticated(request),
        p = sessionScope.parse(request.params);
      return service.readSettlementNote(user, p.storeId, p.checkoutId);
    },
  );
  app.put(
    session + '/settlement-note',
    trace('checkout-settlement-note', 'update'),
    async (request) => {
      const user = authenticated(request),
        p = sessionScope.parse(request.params),
        body = mutationSchema
          .extend({ message: settlementMessageSchema, cashReceived: amountSchema })
          .strict()
          .parse(request.body);
      return response(
        await service.settlementNote(
          user,
          p.storeId,
          p.checkoutId,
          body,
          body.message,
          body.cashReceived,
        ),
      );
    },
  );
  app.post(
    session + '/customer-verification/challenges',
    trace('customer-verification', 'send'),
    async (request) => {
      const user = authenticated(request),
        p = sessionScope.parse(request.params),
        body = mutationSchema.strict().parse(request.body);
      return response(await service.sendVerification(user, p.storeId, p.checkoutId, body));
    },
  );
  app.post(
    session + '/customer-verification/confirmations',
    trace('customer-verification', 'confirm'),
    async (request) => {
      const user = authenticated(request),
        p = sessionScope.parse(request.params),
        body = mutationSchema
          .extend({ otp: z.string().regex(/^\d{6}$/) })
          .strict()
          .parse(request.body);
      return response(await service.verify(user, p.storeId, p.checkoutId, body, body.otp));
    },
  );
  app.post(
    session + '/customer-verification/reconciliations',
    trace('customer-verification', 'reconcile'),
    async (request) => {
      const user = authenticated(request),
        p = sessionScope.parse(request.params),
        body = mutationSchema.strict().parse(request.body);
      return response(await service.reconcileVerification(user, p.storeId, p.checkoutId, body));
    },
  );
  app.post(session + '/quotes', trace('checkout-quote', 'create'), async (request) => {
    const user = authenticated(request),
      p = sessionScope.parse(request.params),
      body = mutationSchema.strict().parse(request.body);
    return response(await service.quote(user, p.storeId, p.checkoutId, body));
  });
  app.post(
    session + '/order-submissions',
    trace('checkout-order', 'create'),
    async (request, reply) => {
      const user = authenticated(request),
        p = sessionScope.parse(request.params),
        body = mutationSchema.strict().parse(request.body);
      const result = await service.submit(user, p.storeId, p.checkoutId, body);
      return reply.code(result.status === 'succeeded' ? 201 : 202).send(response(result));
    },
  );
  app.get(
    session + '/operations/:operationId',
    trace('checkout-operation', 'read'),
    async (request) => {
      const user = authenticated(request),
        p = sessionScope.extend({ operationId: z.uuid() }).parse(request.params);
      return service.operation(user, p.storeId, p.checkoutId, p.operationId);
    },
  );
  app.post(
    session + '/order-finalizations',
    trace('checkout-order', 'finalize'),
    async (request, reply) => {
      const user = authenticated(request),
        p = sessionScope.parse(request.params),
        body = mutationSchema.strict().parse(request.body),
        result = await service.finalize(user, p.storeId, p.checkoutId, body);
      return reply.code(result.status === 'succeeded' ? 200 : 202).send(response(result));
    },
  );
  app.get(
    '/api/v1/stores/:storeId/return-reasons',
    trace('return-reason', 'list'),
    async (request) => {
      const user = authenticated(request),
        p = storeScope.parse(request.params);
      return { data: await returns.reasons(user, p.storeId) };
    },
  );
  app.get(
    '/api/v1/stores/:storeId/products/:productId/return-reasons/:reasonId/sub-reasons',
    trace('return-sub-reason', 'list'),
    async (request) => {
      const user = authenticated(request),
        p = storeScope
          .extend({ productId: identifier, reasonId: identifier })
          .parse(request.params);
      return { data: await returns.subReasons(user, p.storeId, p.productId, p.reasonId) };
    },
  );
  app.get(
    '/api/v1/stores/:storeId/products/:productId/exchange-reasons',
    trace('exchange-reason', 'list'),
    async (request) => {
      const user = authenticated(request),
        p = storeScope.extend({ productId: identifier }).parse(request.params);
      return { data: await returns.exchangeReasons(user, p.storeId, p.productId) };
    },
  );
  app.get(
    '/api/v1/stores/:storeId/products/:parentId/exchange-sizes',
    trace('exchange-size', 'list'),
    async (request) => {
      const user = authenticated(request),
        p = storeScope.extend({ parentId: identifier }).parse(request.params);
      return { data: await returns.sizes(user, p.storeId, p.parentId) };
    },
  );
  app.get(
    '/api/v1/stores/:storeId/orders/:orderId/line-items/:lineId/refund-preview',
    trace('refund-preview', 'read'),
    async (request) => {
      const user = authenticated(request),
        p = storeScope.extend({ orderId: identifier, lineId: identifier }).parse(request.params);
      return returns.refund(user, p.storeId, p.orderId, p.lineId);
    },
  );
  registerPayments(app, config, db, {
    corrections: overrides.paymentCorrections,
    hashSecret: environment.hs256 || environment.hs512 || '',
    projection: environment,
    gateway: overrides.paymentGateway,
    assertCheckIn: overrides.assertCheckIn
      ? (userId, storeId, counterId) => overrides.assertCheckIn!(userId, storeId, counterId)
      : undefined,
  });
  registerPendingOrderCancellations(app, config, db, {
    ...(overrides.pendingCancellations || pendingCancellationOptions()),
    hashSecret: environment.hs256 || environment.hs512 || '',
    projection: environment,
    stockProcedure: overrides.stockProcedure,
  });
  registerReturns(app, config, db, {
    customerOtp,
    customers: repository,
    signing: environment,
    orderGateway: gateway,
    gateway: overrides.returnGateway,
    environment: overrides.returnEnvironment,
    inventoryProcedureVerified: overrides.inventoryProcedureVerified,
    stockProcedure: overrides.stockProcedure,
    assertCheckIn: overrides.assertCheckIn
      ? (userId, storeId, counterId) => overrides.assertCheckIn!(userId, storeId, counterId)
      : undefined,
  });
  registerInvoices(app, config, db);
  registerOrderCopy(app, config, db, service.orderCopyCart, overrides.orderCopy);
  registerWalletAdjustments(app, config, db);
  registerOfflineCash(app, config, db, {
    stockProcedure: overrides.stockProcedure,
    ...overrides.offlineCash,
  });
  return service;
}
