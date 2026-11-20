import { desktopOfflineBridge } from '../offline/billing/bridge';
import {
  errorNameOf,
  routePattern,
  uiErrorReportSchema,
  type UiErrorReport,
  type UiEventId,
} from './ui-events';

export const UI_ERROR_BEACON = '/api/v1/diagnostics/ui-errors';
const MAX_REPORTS = 20;
const REPEAT_WINDOW_MS = 60_000;

export interface UiErrorTransport {
  desktop(report: UiErrorReport): Promise<unknown>;
  web(report: UiErrorReport): Promise<unknown>;
}

/** Desktop: the allowlisted IPC channel to the main-process log (works offline). Web: the
 * backend beacon. Both carry only the ID-only report. */
const defaultTransport: UiErrorTransport = {
  desktop(report) {
    const bridge = desktopOfflineBridge();
    return bridge ? bridge.invoke('diagnostics:ui-error', report) : Promise.resolve();
  },
  web(report) {
    return fetch(UI_ERROR_BEACON, {
      method: 'POST',
      credentials: 'include',
      keepalive: true,
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': crypto.randomUUID() },
      body: JSON.stringify(report),
    });
  },
};

/**
 * Reports UI errors without values. Duplicate reports (same event, error name and route) within a
 * minute are dropped and a page reports at most 20, so a render loop cannot flood the log.
 * Reporting never throws and never rejects.
 */
export function uiErrorReporter(
  transport: UiErrorTransport = defaultTransport,
  options: { isDesktop?: () => boolean; now?: () => number; pathname?: () => string } = {},
) {
  const isDesktop = options.isDesktop ?? (() => desktopOfflineBridge() !== null),
    now = options.now ?? Date.now,
    pathname = options.pathname ?? (() => window.location.pathname),
    recent = new Map<string, number>();
  let sent = 0;
  return function report(eventId: UiEventId, error: unknown): void {
    try {
      const parsed = uiErrorReportSchema.safeParse({
        eventId,
        errorName: errorNameOf(error),
        route: routePattern(pathname()),
      });
      if (!parsed.success || sent >= MAX_REPORTS) return;
      const key = `${parsed.data.eventId} ${parsed.data.errorName} ${parsed.data.route}`,
        at = now(),
        last = recent.get(key);
      if (last !== undefined && at - last < REPEAT_WINDOW_MS) return;
      recent.set(key, at);
      sent += 1;
      const delivery = isDesktop() ? transport.desktop(parsed.data) : transport.web(parsed.data);
      void delivery.catch(() => undefined);
    } catch {
      /* Error reporting must never raise a second error. */
    }
  };
}

export const reportUiError = uiErrorReporter();

/** Window-level handlers: uncaught errors and unhandled promise rejections. */
export function installUiErrorReporting(
  target: Pick<Window, 'addEventListener'> = window,
  report: (eventId: UiEventId, error: unknown) => void = reportUiError,
) {
  target.addEventListener('error', (event) => {
    // Script errors only (ErrorEvent): resource load failures are plain Events without `error`.
    if ('error' in event) report('ui.window.error', event.error);
  });
  target.addEventListener('unhandledrejection', (event) =>
    report('ui.promise.unhandled', event.reason),
  );
}
