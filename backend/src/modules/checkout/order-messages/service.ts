import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import { MUser, Order, OrderAddon, OrderStore } from '../../../db/legacy-schema.js';
import { AppError } from '../../../domain/errors.js';
import { createOtpTransport } from '../../../auth/delivery.js';
import { assertCheckoutProjection } from '../projection.js';
import { feedbackProofContract } from '../feedback-proof.js';
import {
  localOrderMessageContract,
  orderMessageOptions,
  type OrderMessageOptions,
} from './options.js';
import {
  orderFeedbackLink,
  orderMessageText,
  orderMessageIdentifier as identifier,
} from './policy.js';

export const orderMessageJobSchema = z
  .object({
    id: z.string().regex(/^order-sms:[1-9]\d{0,18}$/),
    orderId: identifier,
    storeId: identifier,
    operatorId: identifier,
    requestId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  })
  .strict()
  .refine((job) => job.id === `order-sms:${job.orderId}`);
export type OrderMessageJob = z.infer<typeof orderMessageJobSchema>;
export interface LocalOrderMessageDelivery {
  /** Called while the outbox row is locked, before publishing its first processing claim. */
  prepare(
    transaction: AdministrationTransaction,
    job: OrderMessageJob,
  ): Promise<{ send(signal?: AbortSignal): Promise<void> }>;
}
const unavailable = () =>
  new AppError(
    503,
    'ORDER_MESSAGE_DELIVERY_UNAVAILABLE',
    'Order messages require configured secure delivery.',
  );
/** Source-derived SMS delivery, callable only by the internal durable worker. No public endpoint/token minting. */
export function localOrderMessageDelivery(
  config: Pick<Config, 'DEMO_MODE'>,
  options: OrderMessageOptions = orderMessageOptions(),
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
  clock: () => number = Date.now,
): LocalOrderMessageDelivery | undefined {
  if (config.DEMO_MODE || options.ORDER_SMS_DELIVERY_MODE === 'disabled') return undefined;
  if (
    options.ORDER_SMS_DELIVERY_CONTRACT !== localOrderMessageContract ||
    options.POS_INVOICE_FEEDBACK_VERIFIER_CONTRACT !== feedbackProofContract ||
    !options.POS_INVOICE_FEEDBACK_URL ||
    !options.POS_INVOICE_FEEDBACK_KEY ||
    !options.POS_INVOICE_FEEDBACK_KEY_ID ||
    !options.POS_INVOICE_FEEDBACK_TTL_SECONDS ||
    !options.TSS_JWT_HS256_KEY ||
    !options.TSS_JWT_HS512_KEY
  )
    throw unavailable();
  const transport = createOtpTransport(env, fetcher),
    provider = transport.options;
  if (!provider.GUPSHUP_SMS_USER_ID || !provider.GUPSHUP_SMS_PASSWORD) throw unavailable();
  const feedback = orderFeedbackLink({
    publicUrl: options.POS_INVOICE_FEEDBACK_URL,
    signing: { id: options.POS_INVOICE_FEEDBACK_KEY_ID, key: options.POS_INVOICE_FEEDBACK_KEY },
    ttlSeconds: options.POS_INVOICE_FEEDBACK_TTL_SECONDS,
    forbiddenKeys: [
      options.TSS_JWT_HS256_KEY,
      options.TSS_JWT_HS512_KEY,
      ...[
        options.TSS_POS_INVOICE_KEY,
        options.TSS_POS_CHECKOUT_PROJECTION_KEY,
        options.TSS_POS_ORDER_SMS_KEY,
      ].filter((value): value is string => !!value),
    ],
  });
  return {
    async prepare(tx, raw) {
      const job = orderMessageJobSchema.parse(raw),
        [order] = await tx
          .select({ customerId: Order.user, paid: Order.payment_statuses })
          .from(Order)
          .where(eq(Order.id, BigInt(job.orderId)))
          .limit(1)
          .for('update');
      if (!order || order.paid !== 4n) throw unavailable();
      const mappings = await tx
        .select({ counterId: OrderStore.counter, storeId: OrderStore.store })
        .from(OrderStore)
        .where(eq(OrderStore.order, BigInt(job.orderId)))
        .limit(2)
        .for('share');
      if (
        mappings.length !== 1 ||
        String(mappings[0]!.storeId) !== job.storeId ||
        !mappings[0]!.counterId
      )
        throw unavailable();
      await assertCheckoutProjection(tx, {
        orderId: job.orderId,
        storeId: job.storeId,
        counterId: String(mappings[0]!.counterId),
        customerId: String(order.customerId),
      });
      const [customer] = await tx
        .select({
          telephone: MUser.telephone,
          firstName: MUser.firstname,
          lastName: MUser.lastname,
        })
        .from(MUser)
        .where(eq(MUser.id, order.customerId))
        .limit(1)
        .for('share');
      if (!customer || !/^\d{10,15}$/.test(customer.telephone)) throw unavailable();
      // Literal check_for_sms selection; multiple rows are ambiguous rather than silently choosing one.
      const addons = await tx
        .select({ nps: OrderAddon.is_nps_notification_checked })
        .from(OrderAddon)
        .where(eq(OrderAddon.order_id, BigInt(job.orderId)))
        .limit(2)
        .for('share');
      if (
        addons.length > 1 ||
        (addons[0]?.nps !== undefined && addons[0].nps !== null && ![0, 1].includes(addons[0].nps))
      )
        throw unavailable();
      const message = orderMessageText({
        orderId: job.orderId,
        firstName: customer.firstName,
        lastName: customer.lastName,
        feedbackUrl: addons[0]?.nps === 1 ? feedback(job.orderId, clock()) : null,
      });
      if (message.includes('\0')) throw unavailable();
      let dispatched = false;
      return {
        async send(signal) {
          if (dispatched)
            throw new AppError(
              409,
              'ORDER_MESSAGE_ALREADY_DISPATCHED',
              'This message was already dispatched. Check its recorded outcome.',
            );
          dispatched = true;
          await transport.formPost(
            'https://enterprise.smsgupshup.com/GatewayAPI/rest',
            {
              msg: message,
              v: '1.1',
              userid: provider.GUPSHUP_SMS_USER_ID!,
              password: provider.GUPSHUP_SMS_PASSWORD!,
              send_to: customer.telephone,
              msg_type: 'text',
              method: 'sendMessage',
              mask: 'TSSOUL',
            },
            signal,
          );
        },
      };
    },
  };
}
