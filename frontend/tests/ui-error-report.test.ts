import { describe, expect, it, vi } from 'vitest';
import {
  installUiErrorReporting,
  uiErrorReporter,
  type UiErrorTransport,
} from '../src/observability/report-ui-error';
import {
  errorNameOf,
  routePattern,
  uiErrorReportSchema,
  type UiErrorReport,
} from '../src/observability/ui-events';

/** Workstream D: renderer errors are reported as IDs only (event, error class, route pattern). */
const secret = 'Customer 9876543210 at Flat 9 Canary Lane';

function transport() {
  const desktop: UiErrorReport[] = [],
    web: UiErrorReport[] = [];
  const value: UiErrorTransport = {
    desktop: async (report) => void desktop.push(report),
    web: async (report) => void web.push(report),
  };
  return { value, desktop, web };
}

describe('ID-only UI error reports', () => {
  it('keeps the error class name and drops the message, stack and non-error values', () => {
    expect(errorNameOf(new TypeError(secret))).toBe('TypeError');
    expect(errorNameOf(Object.assign(new Error(secret), { name: secret }))).toBe('Error');
    expect(errorNameOf(secret)).toBe('NonStringValue');
    expect(errorNameOf({ phone: '9876543210' })).toBe('NonErrorObject');
    expect(errorNameOf(null)).toBe('Null');
    expect(errorNameOf(undefined)).toBe('NonErrorValue');
  });
  it('reduces the path to its section and :id placeholders, without query or hash', () => {
    expect(routePattern('/')).toBe('/');
    expect(routePattern('/sales')).toBe('/sales');
    expect(routePattern('/orders/9001/invoice')).toBe('/orders/:id/:id');
    expect(routePattern('/customers/9876543210')).toBe('/customers/:id');
    expect(routePattern('/9876543210')).toBe('/:id');
    expect(routePattern('/Orders/X')).toBe('/:id/:id');
    for (const path of ['/', '/sales', '/orders/1/2/3/4/5/6/7/8/9/10', '/customers/9876543210'])
      expect(uiErrorReportSchema.shape.route.safeParse(routePattern(path)).success).toBe(true);
  });
  it('sends desktop reports over IPC and web reports to the beacon, with only the three fields', async () => {
    const desktop = transport();
    uiErrorReporter(desktop.value, {
      isDesktop: () => true,
      pathname: () => '/customers/9876543210',
    })('ui.render.failed', new RangeError(secret));
    const web = transport();
    uiErrorReporter(web.value, { isDesktop: () => false, pathname: () => '/sales' })(
      'ui.promise.unhandled',
      secret,
    );
    await Promise.resolve();
    expect(desktop.desktop).toEqual([
      { eventId: 'ui.render.failed', errorName: 'RangeError', route: '/customers/:id' },
    ]);
    expect(desktop.web).toEqual([]);
    expect(web.web).toEqual([
      { eventId: 'ui.promise.unhandled', errorName: 'NonStringValue', route: '/sales' },
    ]);
    expect(JSON.stringify([desktop, web])).not.toContain('9876543210');
  });
  it('drops repeats within a minute, caps a page at 20 reports and never throws', async () => {
    let now = 0;
    const sink = transport();
    const report = uiErrorReporter(sink.value, {
      isDesktop: () => false,
      now: () => now,
      pathname: () => '/sales',
    });
    report('ui.window.error', new TypeError('a'));
    report('ui.window.error', new TypeError('b'));
    expect(sink.web).toHaveLength(1);
    now += 60_000;
    report('ui.window.error', new TypeError('c'));
    expect(sink.web).toHaveLength(2);
    for (let index = 0; index < 50; index++) {
      now += 60_000;
      report('ui.window.error', new TypeError('loop'));
    }
    expect(sink.web).toHaveLength(20);
    const failing = uiErrorReporter(
      {
        desktop: () => Promise.reject(new Error('down')),
        web: () => {
          throw new Error('down');
        },
      },
      { isDesktop: () => false, pathname: () => '/sales' },
    );
    expect(() => failing('ui.window.error', new Error('x'))).not.toThrow();
  });
  it('installs window error and unhandled rejection handlers, ignoring resource load errors', () => {
    const listeners = new Map<string, (event: object) => void>();
    const report = vi.fn();
    installUiErrorReporting(
      {
        addEventListener: ((type: string, listener: (event: object) => void) =>
          void listeners.set(type, listener)) as Window['addEventListener'],
      },
      report,
    );
    const thrown = new SyntaxError(secret);
    listeners.get('error')!({ error: thrown, message: secret });
    listeners.get('error')!({ type: 'error', target: {} });
    listeners.get('unhandledrejection')!({ reason: thrown });
    expect(report.mock.calls).toEqual([
      ['ui.window.error', thrown],
      ['ui.promise.unhandled', thrown],
    ]);
  });
});
