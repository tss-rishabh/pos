/** Source: Helpers.mask_name/email/phone. Never log the values passed here. */
export function maskCustomerName(value: string | null): string {
  const letters = Array.from(value || '');
  return letters.length < 3 ? '***' : letters[0] + '*'.repeat(letters.length - 2) + letters.at(-1);
}
export function maskCustomerEmail(value: string | null): string {
  const parts = (value || '').split('@');
  if (parts.length !== 2 || !parts[0]) return '****';
  const domain = parts[1]!.split('.');
  if (domain.length !== 2 || !domain[0]) return '****';
  const user = Array.from(parts[0]),
    host = Array.from(domain[0]);
  return `${user[0]}${'*'.repeat(user.length - 1)}@${host[0]}${'*'.repeat(host.length - 1)}.${domain[1]}`;
}
const otherDigitRanges: readonly (readonly [number, number])[] = [
  [178, 179],
  [185, 185],
  [4969, 4977],
  [6618, 6618],
  [8304, 8304],
  [8308, 8313],
  [8320, 8329],
  [9312, 9320],
  [9332, 9340],
  [9352, 9360],
  [9450, 9450],
  [9461, 9469],
  [9471, 9471],
  [10102, 10110],
  [10112, 10120],
  [10122, 10130],
  [68160, 68163],
  [69216, 69224],
  [69714, 69722],
  [127232, 127242],
];
export function maskCustomerPhone(value: string | null): string {
  const digits = Array.from(value || '').filter((char) => {
    if (/\p{Decimal_Number}/u.test(char)) return true;
    const point = char.codePointAt(0)!;
    return otherDigitRanges.some(([start, end]) => point >= start && point <= end);
  });
  return digits.length < 4 ? '****' : '*'.repeat(digits.length - 4) + digits.slice(-4).join('');
}
