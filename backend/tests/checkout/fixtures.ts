import { AppError } from '../../src/domain/errors.js';
import { createHash } from 'node:crypto';
import type { Principal } from '../../src/domain/access.js';
import type {
  Cart,
  CheckoutRepository,
  CheckoutState,
  CustomerIdentity,
  MutationInput,
  MutationResult,
  OperationReceipt,
} from '../../src/modules/checkout/contracts.js';
import type { CheckoutGateway } from '../../src/modules/checkout/gateway.js';
import {
  currentCheckoutOperation,
  recoveryReplay,
  reserveConfirmationRecovery,
  type ConfirmationRecoveryLease,
} from '../../src/modules/checkout/confirmation-recovery.js';
import { reserveRegistrationRequestRecovery } from '../../src/modules/checkout/customers/request-recovery.js';
import {
  customerVerificationOperation,
  reconcileCustomerVerificationState,
} from '../../src/modules/checkout/customer-verification.js';
import type { CustomerVerificationEvidence } from '../../src/modules/checkout/customer-verification.js';

export const operator: Principal = {
  id: '44',
  name: 'Fixture operator',
  email: 'fixture@example.test',
  role: 4,
  userType: 1,
  storeIds: ['1'],
};
export const signingEnvironment = {
  hs256: 'checkout-fixture-signing-key-'.repeat(3),
  hs512: 'checkout-fixture-hs512-key-'.repeat(3),
  giftCardSalt: 'fixture-gift-card-salt',
  exchangeStockContract: 'pos-exchange-stock-v1',
  giftCardContract: 'pos-gift-card-v2',
  checkoutProjectionContract: 'pos-checkout-projection-v1',
  checkoutProjectionKey: 'fixture-pos-projection-key-'.repeat(3),
  customerConsentContract: 'pos-customer-contact-consent-v1',
  refundAllocationContract: 'pos-refund-per-hp-v1',
  refundSourcePatchHash: 'e156c0c281cf5d846b6ae88cd7824959babe2069ed409ca9dff31b7882945f11',
};
export const orderMessageFixtureEnvironment = {
  ORDER_SMS_DELIVERY_MODE: 'local',
  ORDER_SMS_DELIVERY_CONTRACT: 'pos-order-sms-security-v1',
  POS_INVOICE_FEEDBACK_VERIFIER_CONTRACT: 'pos-feedback-proof-v1',
  POS_INVOICE_FEEDBACK_KEY_ID: 'fixture-feedback',
  POS_INVOICE_FEEDBACK_KEY: 'independent-feedback-fixture-key-0123456789',
  POS_INVOICE_FEEDBACK_URL: 'https://feedback.example.test/invoice-feedback',
  POS_INVOICE_FEEDBACK_TTL_SECONDS: '600',
  TSS_JWT_HS256_KEY: 'independent-customer-fixture-key-0123456789',
  TSS_JWT_HS512_KEY: 'independent-customer-fixture-key-0123456789-512',
  GUPSHUP_SMS_USER_ID: 'fixture-sms-user',
  GUPSHUP_SMS_PASSWORD: 'fixture-sms-password',
};
export const identity = (id: string): CustomerIdentity => ({
  id,
  email: `customer-${id}@example.test`,
  firstName: 'Fixture',
  lastName: 'Customer',
  telephone: '9000000000',
  twoFactor: false,
  exclusive: false,
  active: true,
});
export class MemoryCheckoutRepository implements CheckoutRepository {
  states = new Map<string, CheckoutState>();
  receipts = new Map<string, OperationReceipt>();
  customers = new Map<string, CustomerIdentity>([
    ['777', identity('777')],
    ['1001', identity('1001')],
  ]);
  customerLeases = new Map<string, string>();
  giftLeases = new Map<string, string>();
  contactRevisions = new Map<string, string>();
  async customerContact(customerId: string) {
    const customer = this.customers.get(customerId);
    if (!customer?.active)
      throw new AppError(409, 'CHECKOUT_CUSTOMER_UNAVAILABLE', 'Fixture customer unavailable.');
    return {
      revision: this.contactRevisions.get(customerId) ?? '0',
      digest: createHash('sha256')
        .update(
          JSON.stringify({ id: customer.id, email: customer.email, telephone: customer.telephone }),
        )
        .digest('hex'),
    };
  }
  async counter(storeId: string, counterId: string) {
    return storeId === '1' && counterId === '3';
  }
  async operatorIdentity(operatorId: string) {
    return operatorId === '44' ? identity('777') : null;
  }
  async storefrontIdentity(operatorId: string) {
    return operatorId === '44' ? identity('777') : null;
  }
  async customer(customerId: string) {
    return this.customers.get(customerId) || null;
  }
  async findCustomer(query: string) {
    return [...this.customers.values()].filter((c) => c.email === query || c.telephone === query);
  }
  async cartProduct(productId: string) {
    return productId === '10' || productId === '11'
      ? { barcode: productId === '10' ? '8900000000010' : '8900000000011', type: 1 }
      : productId === '80'
        ? { barcode: '8900000000080', type: 8 }
        : null;
  }
  async isEmployeeCoupon(code: string) {
    return code === 'EMPLOYEE';
  }
  async giftCardCollection(id: string) {
    return id === '1' ? { size: 10, blocked: false, printed: true } : null;
  }
  async giftCardAvailable(_code: string) {
    return true;
  }
  async salesperson(storeId: string, salespersonId: string) {
    return storeId === '1' && salespersonId === '5';
  }
  async acquireCustomer(checkoutId: string, customerId: string) {
    const owner = this.customerLeases.get(customerId);
    if (owner && owner !== checkoutId)
      throw new AppError(409, 'CUSTOMER_CART_BUSY', 'Customer cart is busy.');
    this.customerLeases.set(customerId, checkoutId);
  }
  async releaseCustomer(checkoutId: string, customerId: string) {
    if (this.customerLeases.get(customerId) === checkoutId) this.customerLeases.delete(customerId);
  }
  async acquireGiftCard(checkoutId: string, serial: string) {
    const owner = this.giftLeases.get(serial);
    if (owner && owner !== checkoutId)
      throw new AppError(409, 'GIFT_CARD_RESERVED', 'Gift card is reserved.');
    this.giftLeases.set(serial, checkoutId);
  }
  async releaseGiftCard(checkoutId: string, serial: string) {
    if (this.giftLeases.get(serial) === checkoutId) this.giftLeases.delete(serial);
  }
  async create(state: CheckoutState) {
    const existing = [...this.states.values()].find(
      (row) => row.operatorId === state.operatorId && row.draftId === state.draftId,
    );
    if (existing) {
      if (existing.storeId !== state.storeId || existing.counterId !== state.counterId)
        throw new AppError(409, 'CHECKOUT_DRAFT_SCOPE_CONFLICT', 'Saved sale scope differs.');
      if (
        existing.draftVersion !== state.draftVersion ||
        JSON.stringify(existing.draftImport?.lineItems ?? null) !==
          JSON.stringify(state.draftImport?.lineItems ?? null)
      )
        throw new AppError(409, 'CHECKOUT_DRAFT_CONTENT_CONFLICT', 'Saved sale contents differ.');
      return structuredClone(existing);
    }
    this.states.set(state.id, structuredClone(state));
    return structuredClone(state);
  }
  async get(operatorId: string, storeId: string, id: string) {
    const state = this.states.get(id);
    return state && state.operatorId === operatorId && state.storeId === storeId
      ? structuredClone(state)
      : null;
  }
  async begin(
    operatorId: string,
    storeId: string,
    id: string,
    input: MutationInput,
    hash: string,
    recovery?: ConfirmationRecoveryLease,
  ) {
    const state = await this.get(operatorId, storeId, id);
    if (!state) throw new AppError(404, 'CHECKOUT_NOT_FOUND', 'Checkout not found.');
    const key = `${id}:${input.operationId}`,
      existing = this.receipts.get(key);
    if (existing) {
      if (existing.requestHash !== hash)
        throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'Operation changed.');
      if (!recovery || recoveryReplay(state, existing, recovery))
        return { state, receipt: structuredClone(existing), replay: true };
    }
    if (state.version !== input.expectedVersion)
      throw new AppError(409, 'CHECKOUT_VERSION_CONFLICT', 'Version changed.');
    if (state.phase === 'cleared')
      throw new AppError(409, 'CHECKOUT_CLEARED', 'Checkout was cleared.');
    if (!recovery && (state.busyOperationId || state.phase === 'uncertain'))
      throw new AppError(409, 'CHECKOUT_REVIEW_REQUIRED', 'Review required.');
    const next = recovery
      ? recovery.purpose === 'registration-request'
        ? reserveRegistrationRequestRecovery(
            state,
            input.operationId,
            recovery,
            state.registrationId
              ? (this.receipts.get(`${id}:${state.registrationId}`) ?? null)
              : null,
          )
        : reserveConfirmationRecovery(state, input.operationId, recovery)
      : { ...state, busyOperationId: input.operationId };
    if (recovery && state.busyOperationId && state.busyOperationId !== input.operationId) {
      const previous = this.receipts.get(`${id}:${state.busyOperationId}`);
      if (previous) {
        previous.status = 'uncertain';
        previous.errorCode = 'CHECKOUT_CONFIRMATION_RECONCILING';
      }
    }
    this.states.set(id, next);
    const receipt: OperationReceipt = {
      id: input.operationId,
      checkoutId: id,
      status: 'inflight',
      requestHash: hash,
      result: null,
      errorCode: null,
    };
    this.receipts.set(key, receipt);
    return { state: structuredClone(next), receipt: structuredClone(receipt), replay: false };
  }
  async checkpoint(state: CheckoutState, operationId: string) {
    const current = this.states.get(state.id);
    if (!current || !currentCheckoutOperation(current, state, operationId))
      throw new AppError(409, 'CHECKOUT_OPERATION_CHANGED', 'Lost operation reservation');
    this.states.set(state.id, structuredClone(state));
    if (state.phase === 'cleared') {
      for (const [id, owner] of this.customerLeases)
        if (owner === state.id) this.customerLeases.delete(id);
      for (const [id, owner] of this.giftLeases) if (owner === state.id) this.giftLeases.delete(id);
    }
  }
  async finish(state: CheckoutState, operationId: string, result: Record<string, unknown>) {
    const current = this.states.get(state.id);
    if (!current || !currentCheckoutOperation(current, state, operationId))
      throw new AppError(409, 'CHECKOUT_OPERATION_CHANGED', 'Lost operation reservation');
    const next = {
      ...state,
      version: state.version + 1,
      busyOperationId: null,
      confirmationRecovery: null,
      registrationRecovery: null,
    };
    const response: MutationResult = {
      state: structuredClone(next),
      result: structuredClone(result),
    };
    this.states.set(state.id, next);
    const receipt = this.receipts.get(`${state.id}:${operationId}`)!;
    receipt.status = 'succeeded';
    receipt.result = response;
    const originalOperationId = state.confirmationRecovery
      ? state.orderSubmissionOperationId
      : state.registrationRecovery
        ? state.registrationId
        : null;
    if (originalOperationId) {
      const original = this.receipts.get(`${state.id}:${originalOperationId}`);
      if (original) {
        original.status = 'succeeded';
        original.result = structuredClone(response);
        original.errorCode = null;
      }
    }
    return structuredClone(response);
  }
  async fail(state: CheckoutState, operationId: string, uncertain: boolean, errorCode: string) {
    const current = this.states.get(state.id)!;
    if (!current || !currentCheckoutOperation(current, state, operationId)) return;
    this.states.set(state.id, {
      ...current,
      busyOperationId: null,
      confirmationRecovery: null,
      registrationRecovery: null,
      phase:
        current.phase === 'cleared'
          ? 'cleared'
          : uncertain && !customerVerificationOperation(current, operationId)
            ? 'uncertain'
            : current.phase,
    });
    const receipt = this.receipts.get(`${state.id}:${operationId}`)!;
    receipt.status = uncertain ? 'uncertain' : 'rejected';
    receipt.errorCode = errorCode;
  }
  async operation(operatorId: string, storeId: string, id: string, operationId: string) {
    if (!(await this.get(operatorId, storeId, id))) return null;
    const value = this.receipts.get(`${id}:${operationId}`);
    return value ? structuredClone(value) : null;
  }
  async reconcileCustomerVerification(
    operatorId: string,
    storeId: string,
    id: string,
    input: MutationInput,
    evidence: CustomerVerificationEvidence,
  ) {
    const state = await this.get(operatorId, storeId, id),
      receipt = this.receipts.get(`${id}:${input.operationId}`);
    if (!state || !receipt)
      throw new AppError(
        404,
        'CHECKOUT_OPERATION_NOT_FOUND',
        'The original verification action was not found.',
      );
    const repaired = reconcileCustomerVerificationState(
      state,
      receipt,
      input,
      evidence,
      evidence.kind === 'revoked' ? null : await this.customerContact(state.customerId!),
      Date.now(),
    );
    this.states.set(id, structuredClone(repaired.state));
    this.receipts.set(`${id}:${input.operationId}`, structuredClone(repaired.receipt));
    return structuredClone(repaired);
  }
}
export class FixtureGateway implements CheckoutGateway {
  calls: { path: string; payload: Record<string, unknown> }[] = [];
  carts = new Map<string, Cart>();
  intercept?: (path: string, payload: Record<string, unknown>) => Promise<unknown | undefined>;
  key(token: string | undefined, payload: Record<string, unknown>) {
    const raw = (token || '').replace(/^2f\./, '').split('.')[1];
    const decoded: unknown = raw ? JSON.parse(Buffer.from(raw, 'base64url').toString()) : {};
    const sub =
      typeof decoded === 'object' && decoded !== null && 'sub' in decoded
        ? String(decoded.sub)
        : 'anonymous';
    return `${sub}:${String(payload.tab_id || 'customer')}`;
  }
  empty(): Cart {
    return {
      products: { items: [] },
      giftvouchers: { items: [] },
      auth_token: 'private-api-token',
      meta: { items: [{ name: 'calculations', total: 99 }] },
    };
  }
  async api(path: string, payload: Record<string, unknown>, token?: string): Promise<unknown> {
    this.calls.push({ path, payload: structuredClone(payload) });
    if (this.intercept) {
      const result = await this.intercept(path, payload);
      if (result !== undefined) return result;
    }
    const key = this.key(token, payload),
      cart = structuredClone(this.carts.get(key) || this.empty());
    const rawOperation = payload.payload;
    const operation =
      typeof rawOperation === 'object' && rawOperation !== null
        ? (rawOperation as Record<string, unknown>)
        : {};
    if (path === 'omnichannel-sendotp') return { mobile: true, email: false };
    if (path === 'omnichannel-verifyotp')
      return { message: payload.otp === 123456 ? 'OTP verified successfully!' : 'Wrong OTP' };
    if (path === 'validatecheckout') return { valid: true };
    if (path === 'pos/order') return { order: 5001, method: 'coc', isValid: true, name: 'Fixture' };
    if (path === 'syncart') {
      const target = this.key(String(payload.token), {});
      this.carts.set(target, structuredClone(payload.pos_localcart as Cart));
      return { synced: true };
    }
    if (path === 'pos/product') {
      if (payload.barcode === '8900000000080') {
        const custom = payload.custom_data,
          details =
            typeof custom === 'object' && custom !== null
              ? (custom as Record<string, unknown>)
              : {},
          value = details.gvprice === undefined ? 500 : Number(details.gvprice);
        cart.giftvouchers ||= { items: [] };
        cart.giftvouchers.items.push({
          gv_id: String(details.pos_gift_id || '8001'),
          prod_id: 80,
          prod_type: 8,
          quantity: 1,
          price: value,
          gvamount: value,
          custom_price: details.gvprice !== undefined,
          product: 'Fixture gift card',
        });
      } else
        cart.products.items.push({
          prod_id: payload.barcode === '8900000000011' ? 11 : 10,
          quantity: 1,
          prod_type: 1,
        });
      this.carts.set(key, cart);
      return cart;
    }
    if (operation.operation === 'set') {
      const data = operation.data as { prod_id: number; quantity: number };
      cart.products.items = cart.products.items.map((line) =>
        String(line.prod_id) === String(data.prod_id) ? { ...line, quantity: data.quantity } : line,
      );
    }
    if (operation.operation === 'delete') {
      const data = operation.data as {
        prod_id: number | bigint;
        gv_id?: number | bigint;
        name?: string;
      };
      if (operation.type === 'giftvouchers')
        cart.giftvouchers = {
          items: (cart.giftvouchers?.items || []).filter(
            (line) => String(line.gv_id) !== String(data.gv_id),
          ),
        };
      else if (operation.type === 'products')
        cart.products.items = cart.products.items.filter(
          (line) => String(line.prod_id) !== String(data.prod_id),
        );
    }
    if (operation.operation === 'clear') {
      cart.products.items = [];
      cart.giftvouchers = { items: [] };
    }
    this.carts.set(key, cart);
    return cart;
  }
  async confirm(payload: Record<string, unknown>, _token: string) {
    this.calls.push({ path: 'payment-confirm', payload });
    if (this.intercept) {
      const value = await this.intercept('payment-confirm', payload);
      if (value !== undefined) return value;
    }
    return { confirmed: true };
  }
  async exchangeReasons(_categoryId: string): Promise<unknown> {
    return [];
  }
}
