import { eq } from 'drizzle-orm';
import { MUser, TssMoneyHistory } from '../../../db/legacy-schema.js';
import { generatedId } from '../../../db/generated-id.js';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import { reconciliation } from './domain.js';
import type { DeliveryCommand, LifecycleRuntime } from './runtime.js';

/** CPython round(binary64,2): round the exact binary rational, ties to even. */
export function pythonRoundMoney(value: number) {
  if (!Number.isFinite(value)) throw reconciliation();
  const bytes = new DataView(new ArrayBuffer(8));
  bytes.setFloat64(0, Math.abs(value), false);
  const bits = bytes.getBigUint64(0, false),
    exponent = Number((bits >> 52n) & 2047n),
    fraction = bits & ((1n << 52n) - 1n),
    mantissa = exponent === 0 ? fraction : (1n << 52n) | fraction,
    power = (exponent === 0 ? -1022 : exponent - 1023) - 52;
  let numerator = mantissa * 100n,
    denominator = 1n;
  if (power >= 0) numerator <<= BigInt(power);
  else denominator <<= BigInt(-power);
  let integer = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder * 2n > denominator || (remainder * 2n === denominator && integer % 2n !== 0n))
    integer++;
  const digits = integer.toString().padStart(3, '0');
  return Number(
    (value < 0 || Object.is(value, -0) ? '-' : '') + digits.slice(0, -2) + '.' + digits.slice(-2),
  );
}
export async function refundOnlineCharge(
  runtime: LifecycleRuntime,
  tx: AdministrationTransaction,
  command: DeliveryCommand,
  charges: number,
  context: Awaited<ReturnType<LifecycleRuntime['context']>>,
) {
  if (!Number.isFinite(charges) || charges < 0 || charges > context.order.hlCharges)
    throw reconciliation();
  if (charges === 0) return null;
  const [customer] = await tx
    .select({ money: MUser.tss_money })
    .from(MUser)
    .where(eq(MUser.id, BigInt(command.snapshot.customerId)))
    .limit(1)
    .for('update');
  if (!customer || !Number.isFinite(customer.money)) throw reconciliation();
  const after = customer.money + charges;
  if (!Number.isFinite(after)) throw reconciliation();
  const now = runtime.timestamp(),
    expiry = runtime
      .clock()
      .toZonedDateTimeISO(runtime.config.BUSINESS_TIMEZONE)
      .toPlainDateTime()
      .add({ days: 365 })
      .toString({ smallestUnit: 'second' })
      .replace('T', ' '),
    id = generatedId(
      await tx.insert(TssMoneyHistory).values({
        user_id: BigInt(command.snapshot.customerId),
        order_id: BigInt(command.state.orderId),
        added_amt: charges,
        used_amt: 0,
        amt_before_update: customer.money,
        amt_after_update: pythonRoundMoney(after),
        platform: 'ORDER_REFUND',
        comment: 'Hyperlocal charges refunded',
        added_user: 0n,
        is_expired: 0,
        expiry,
        created_at: now,
        updated_at: now,
      }),
    );
  // The source intentionally assigns both fields from the resulting tss_money.
  await tx
    .update(MUser)
    .set({ cashback: after, tss_money: after })
    .where(eq(MUser.id, BigInt(command.snapshot.customerId)));
  await runtime.audit(
    tx,
    command,
    context,
    'Hyperlocal Charges Refunded into tss money and Order has been converted to online order',
    '0',
    { 'Hyperlocal Charges refunded into tss money': charges },
  );
  return String(id);
}
