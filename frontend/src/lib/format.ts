export const currency = (value: string | number) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(Number(value));
export function total(lines: { unitPrice: string; quantity: number }[]): string {
  const minor = lines.reduce((sum, line) => {
    const [whole, fraction = ''] = line.unitPrice.split('.');
    return sum + (BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'))) * BigInt(line.quantity);
  }, 0n);
  return `${minor / 100n}.${String(minor % 100n).padStart(2, '0')}`;
}
