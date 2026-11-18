/** Source GET default uses now minus five days and now plus one minute before formatting. */
export function businessDate(at: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(at));
}
export function dailyReportDates(now = Date.now()) {
  return { from: businessDate(now - 5 * 86400000), to: businessDate(now + 60000) };
}
export function cashLedgerDates(now = Date.now()) {
  const to = businessDate(now);
  return { from: to.slice(0, 8) + '01', to };
}
