import { createHmac, timingSafeEqual } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';

export function packageQrExpiry(timestamp: number, period: number) {
  return (Math.floor(timestamp / (period * 1000)) + 1) * period * 1000;
}
export const applicationDigest = (secret: string, purpose: string, value: string) =>
  createHmac('sha256', secret)
    .update('application-links:' + purpose + ':' + value)
    .digest('hex');
export const applicationToken = (secret: string, purpose: string, values: readonly string[]) =>
  createHmac('sha256', secret)
    .update('application-links:' + purpose + ':' + JSON.stringify(values))
    .digest('base64url');
export function sameToken(left: string, right: string) {
  return left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}
export function sourceCustomerLinkBody(
  storeId: string,
  website = 'https://www.thesouledstore.com',
) {
  return { link: `${website}?store_id=${storeId}` };
}
export function scanWallTime(timestamp: number, zone: string) {
  return Temporal.Instant.fromEpochMilliseconds(timestamp)
    .toZonedDateTimeISO(zone)
    .toPlainDateTime()
    .toString({ smallestUnit: 'second' })
    .replace('T', ' ');
}
