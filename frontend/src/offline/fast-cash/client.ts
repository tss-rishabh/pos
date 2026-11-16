import { z } from 'zod';
import { post, request } from '../../api/client';
import { checkoutBase, checkoutSchema, type Checkout } from '../../pages/checkout/client';
import { cashPaymentSchema, type FastCashCommand } from './contracts';
export const fastReplySchema = z.object({
  status: z.enum(['succeeded', 'inflight', 'uncertain', 'rejected']),
  state: checkoutSchema.optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  operationId: z.string().optional(),
  errorCode: z.string().nullable().optional(),
});
export type FastReply = z.infer<typeof fastReplySchema>;
const sessionPath = (command: FastCashCommand) =>
  `${checkoutBase(command.storeId)}/${command.checkoutId}`;
const orderPath = (command: FastCashCommand) => {
  if (!command.orderId) throw new Error('The original order has not been proved.');
  return `/api/v1/stores/${command.storeId}/orders/${command.orderId}`;
};
export interface FastCashApi {
  readCheckout(command: FastCashCommand): Promise<Checkout>;
  readSubmission(command: FastCashCommand): Promise<FastReply>;
  submit(command: FastCashCommand): Promise<FastReply>;
  readPayment(command: FastCashCommand): Promise<z.infer<typeof cashPaymentSchema>>;
  paymentOptions(
    command: FastCashCommand,
  ): Promise<{ payable: string; options: { channel: string }[] }>;
  pay(command: FastCashCommand): Promise<z.infer<typeof cashPaymentSchema>>;
}
export const fastCashApi: FastCashApi = {
  readCheckout: (command) =>
    request(sessionPath(command), { operatorId: command.ownerId }, checkoutSchema),
  readSubmission: (command) =>
    request(
      sessionPath(command) + '/operations/' + command.submissionId,
      { operatorId: command.ownerId },
      fastReplySchema,
    ),
  submit: (command) =>
    post(
      sessionPath(command) + '/order-submissions',
      { operationId: command.submissionId, expectedVersion: command.checkoutVersion },
      fastReplySchema,
      command.ownerId,
    ),
  readPayment: (command) =>
    request(
      orderPath(command) + '/payment-attempts/' + command.paymentId,
      { operatorId: command.ownerId },
      cashPaymentSchema,
    ),
  paymentOptions: (command) =>
    request(
      orderPath(command) + '/payment-options',
      { operatorId: command.ownerId },
      z.object({ payable: z.string(), options: z.array(z.object({ channel: z.string() })) }),
    ),
  pay: (command) =>
    post(
      orderPath(command) + '/payment-attempts',
      {
        operationId: command.paymentId,
        channel: 'cash',
        cashAmount: command.payable,
        cashReceived: command.cashReceived,
        onlineAmount: '0.00',
        ...(command.noteHash
          ? { checkoutNote: { checkoutId: command.checkoutId, noteHash: command.noteHash } }
          : {}),
      },
      cashPaymentSchema,
      command.ownerId,
    ),
};
