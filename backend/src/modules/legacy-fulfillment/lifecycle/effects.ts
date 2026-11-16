import { asc, eq } from 'drizzle-orm';
import { HyperlocalFdLog, Store } from '../../../db/legacy-schema.js';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import type { ProviderRequest } from './contracts.js';
import { hash, reconciliation } from './domain.js';
import type { DeliveryCommand, LifecycleRuntime } from './runtime.js';

/** Freeze the destination hash, never a webhook credential, in the durable descriptor. */
export async function addStoreSlack(
  runtime: LifecycleRuntime,
  tx: AdministrationTransaction,
  command: DeliveryCommand,
  sequence: number,
  storeId: string,
  description: string,
) {
  const [store] = await tx
    .select({ url: Store.slack_group_url })
    .from(Store)
    .where(eq(Store.id, BigInt(storeId)))
    .limit(1)
    .for('share');
  if (!store) throw reconciliation();
  const target = store.url || runtime.options.SLACK_URL;
  await runtime.addCall(tx, command, 'slack', sequence, {
    storeId,
    description,
    slackDestination: store.url ? 'store' : 'common',
    slackDestinationHash: target ? hash(target) : null,
  });
  if (store.url && runtime.options.COMMON_GROUP_ALERT_ON && store.url !== runtime.options.SLACK_URL)
    await runtime.addCall(tx, command, 'slack', sequence + 1, {
      storeId,
      description,
      slackDestination: 'common',
      slackDestinationHash: runtime.options.SLACK_URL ? hash(runtime.options.SLACK_URL) : null,
    });
}
export async function slackDestination(
  runtime: LifecycleRuntime,
  tx: AdministrationTransaction,
  request: ProviderRequest,
) {
  if (request.kind !== 'slack') return undefined;
  let target = runtime.options.SLACK_URL;
  if (request.slackDestination === 'store') {
    const [store] = await tx
      .select({ url: Store.slack_group_url })
      .from(Store)
      .where(eq(Store.id, BigInt(request.storeId)))
      .limit(1)
      .for('share');
    target = store?.url || undefined;
  }
  if (request.slackDestinationHash && (!target || hash(target) !== request.slackDestinationHash))
    throw reconciliation();
  return target;
}
/** Source create_od_ticket posts its summary only after the ticket operation is acknowledged. */
export async function ticketAcknowledged(
  runtime: LifecycleRuntime,
  tx: AdministrationTransaction,
  command: DeliveryCommand,
  request: ProviderRequest,
) {
  if (request.kind !== 'support-ticket') return;
  const [ticket] = await tx
    .select({ ticketId: HyperlocalFdLog.fd_ticket_id })
    .from(HyperlocalFdLog)
    .where(eq(HyperlocalFdLog.order_id, BigInt(command.state.orderId)))
    .orderBy(asc(HyperlocalFdLog.id))
    .limit(1)
    .for('share');
  const reason = command.input.reason ? ` Reason : ${command.input.reason} |` : '',
    head = request.newOrderId
      ? `Hyperlocal Order Id: ${command.state.orderId} Converted into new online Order Id: ${request.newOrderId} |${reason}`
      : `${request.subject} | Order ID : ${command.state.orderId} |${reason}`,
    message =
      head +
      (ticket?.ticketId && ticket.ticketId !== '0' ? ` CRM Ticket Id: ${ticket.ticketId}` : '') +
      (command.input.staffName ? ` | Staff User : ${command.input.staffName}` : '');
  await runtime.addCall(tx, command, 'slack', 10002, { description: message });
}
