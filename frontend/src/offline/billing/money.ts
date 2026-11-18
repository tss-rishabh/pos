/** Exact money handling for offline billing. Amounts are integer paise; the
 * wire format is a decimal string with exactly two fraction digits. */
export const MAX_SALE_PAISE = 9_999_999_999;

const decimal = /^(\d{1,10})(?:\.(\d+))?$/;

/** Parse a catalogue/server decimal string into paise. Fractions beyond two
 * digits are accepted only when they are zeros (e.g. "499.000"). */
export function parseMoney(value: string): number | null {
  const match = decimal.exec(value.trim());
  if (!match) return null;
  const whole = match[1] ?? '0',
    fraction = match[2] ?? '';
  if (fraction.length > 2 && !/^0+$/.test(fraction.slice(2))) return null;
  const paise = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  return Number.isSafeInteger(paise) && paise <= MAX_SALE_PAISE ? paise : null;
}

export function formatMoney(paise: number): string {
  if (!Number.isSafeInteger(paise) || paise < 0) throw new RangeError('Invalid amount.');
  const rupees = Math.floor(paise / 100),
    rest = paise % 100;
  return `${rupees}.${String(rest).padStart(2, '0')}`;
}

/** Pinned legacy CalculationsWrapper: sum line amounts, then floor to whole
 * rupees for the payable. The rounding difference is shown on the receipt. */
export function saleTotals(lines: readonly { unitPricePaise: number; quantity: number }[]) {
  let gross = 0;
  for (const line of lines) {
    if (!Number.isSafeInteger(line.unitPricePaise) || line.unitPricePaise < 0)
      throw new RangeError('Invalid line price.');
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1)
      throw new RangeError('Invalid line quantity.');
    gross += line.unitPricePaise * line.quantity;
    if (!Number.isSafeInteger(gross) || gross > MAX_SALE_PAISE)
      throw new RangeError('Sale total is too large.');
  }
  const roundingPaise = gross % 100;
  return { grossPaise: gross, roundingPaise, payablePaise: gross - roundingPaise };
}
