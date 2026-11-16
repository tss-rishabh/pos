import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface FeedbackLogEvent {
  module: 'customer-feedback';
  resource: 'nps';
  eventId:
    | 'customer-feedback.nps.request'
    | 'customer-feedback.nps.complete'
    | 'customer-feedback.nps.source-error'
    | 'customer-feedback.nps.source-result';
  requestId: string | null;
  /** The feedback capability does not authenticate an operator or customer. */
  userId: null;
}
const context = new AsyncLocalStorage<{ requestId: string }>();
const sink = (event: FeedbackLogEvent) => process.stdout.write(JSON.stringify(event) + '\n');
export function feedbackEvent(eventId: FeedbackLogEvent['eventId']): FeedbackLogEvent {
  return {
    module: 'customer-feedback',
    resource: 'nps',
    eventId,
    requestId: context.getStore()?.requestId ?? null,
    userId: null,
  };
}
export function emitFeedbackEvent(eventId: FeedbackLogEvent['eventId']) {
  sink(feedbackEvent(eventId));
}
export function feedbackRequest<T>(task: () => T) {
  // A caller-supplied request ID may itself contain PII. Generate correlation here.
  return context.run({ requestId: randomUUID() }, task);
}
export function withFeedbackRequest<T>(requestId: string, task: () => T) {
  if (!/^[a-f0-9-]{36}$/.test(requestId)) throw new Error('Invalid feedback correlation.');
  return context.run({ requestId }, task);
}
/** Deliberately never serializes a source argument, error, URL, header or body. */
export const feedbackLogger = {
  debug: (..._args: readonly unknown[]) => {},
  info: (..._args: readonly unknown[]) =>
    sink(feedbackEvent('customer-feedback.nps.source-result')),
  warn: (..._args: readonly unknown[]) => sink(feedbackEvent('customer-feedback.nps.source-error')),
  error: (..._args: readonly unknown[]) =>
    sink(feedbackEvent('customer-feedback.nps.source-error')),
};
export default feedbackLogger;
