import { appendFileSync } from 'node:fs';
import {
  test as base,
  expect,
  type ConsoleMessage,
  type Page,
  type Request,
  type Response,
  type WebSocket,
} from '@playwright/test';

export { expect };

/**
 * One request a test triggers on purpose that ends in an HTTP error or a network failure, for
 * example an unknown order number that must answer 404. `path` is the URL path without the query
 * string. Each expectation must be seen exactly `times` times (default 1); the matching Chrome
 * "Failed to load resource" console line is covered by the same expectation.
 */
export interface ExpectedFailure {
  method: string;
  path: string | RegExp;
  /** HTTP status, or a Chromium network error such as `net::ERR_FAILED`. */
  outcome: number | `net::${string}`;
  times?: number;
  /**
   * Only for `net::ERR_ABORTED`: a request the app itself cancels because a newer one superseded
   * it (or the test navigates away) may be cancelled 0..upTo times, depending on timing.
   */
  upTo?: number;
}

export interface Observation {
  kind: 'console' | 'pageerror' | 'response' | 'requestfailed' | 'websocket';
  /** URL path only. Query values are never recorded. */
  path: string;
  method?: string;
  outcome?: number | string;
  /** Console text with any URL query string removed. */
  text?: string;
}

export interface NetworkGuard {
  /** Declare a deliberate failure for this test only. */
  expectFailure(failure: ExpectedFailure): void;
  /** Watch another page or Electron window (the default `page` and its popups are watched). */
  watch(page: Page): void;
}

/**
 * For specs that render the tax-invoice preview. The preview frame is sandboxed without
 * `allow-scripts` and its CSP is `script-src 'none'` (S20). Playwright's trace DOM snapshotter
 * injects a script into every frame, which Chrome blocks there and reports as "Blocked script
 * execution … the document's frame is sandboxed". Recording these traces without DOM snapshots
 * (screenshots and sources stay) keeps the harness from executing script in that frame; the
 * sandbox itself is unchanged.
 */
export const sandboxedFrameTrace = {
  trace: { mode: 'retain-on-failure', snapshots: false, screenshots: true, sources: true },
} as const;

const failedResource =
  /^Failed to load resource: (?:the server responded with a status of (\d+)|(net::[A-Z_]+))/;
const withoutQuery = (text: string) => text.replace(/\?[^\s'"`)]*/g, '');
function pathOf(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'data:' || parsed.protocol === 'blob:'
      ? `${parsed.protocol}…`
      : parsed.pathname;
  } catch {
    return '';
  }
}
function describe(observation: Observation) {
  return [
    observation.kind,
    observation.method,
    observation.path,
    observation.outcome,
    observation.text && JSON.stringify(observation.text),
  ]
    .filter((part) => part !== undefined && part !== '')
    .join(' ');
}

/**
 * Shared web e2e fixture: a test fails on any console error, uncaught page error, HTTP 4xx/5xx
 * response, failed request or failed WebSocket handshake that the test did not declare with
 * `network.expectFailure`. There is no global allow-list.
 */
export const test = base.extend<{ network: NetworkGuard }>({
  network: [
    async ({ context }, use, testInfo) => {
      const expected: (ExpectedFailure & { seen: number })[] = [];
      const unexpected: Observation[] = [];
      const audit = process.env.E2E_NETWORK_AUDIT_FILE;
      const record = (observation: Observation, allowed: boolean) => {
        if (!allowed) unexpected.push(observation);
        if (audit)
          appendFileSync(
            audit,
            JSON.stringify({
              file: testInfo.file.split('/e2e/')[1],
              test: testInfo.title,
              allowed,
              ...observation,
            }) + '\n',
          );
      };
      const claim = (method: string | undefined, path: string, outcome: number | string) => {
        const match = expected.find(
          (failure) =>
            (method === undefined || failure.method === method) &&
            (typeof failure.path === 'string' ? failure.path === path : failure.path.test(path)) &&
            failure.outcome === outcome,
        );
        if (!match) return false;
        match.seen += 1;
        return true;
      };
      // A failed response is reported once by the network layer and once by Chrome's console;
      // the console line is allowed when its own request was an expected failure.
      const consoleAllowance = new Map<string, number>();
      const allowConsole = (path: string, outcome: number | string) => {
        const key = `${path} ${outcome}`;
        consoleAllowance.set(key, (consoleAllowance.get(key) ?? 0) + 1);
      };
      const takeConsole = (path: string, outcome: number | string) => {
        const key = `${path} ${outcome}`,
          left = consoleAllowance.get(key) ?? 0;
        if (left < 1) return false;
        consoleAllowance.set(key, left - 1);
        return true;
      };
      const watched = new WeakSet<Page>();
      const onResponse = (response: Response) => {
        const status = response.status();
        if (status < 400) return;
        const method = response.request().method(),
          path = pathOf(response.url()),
          allowed = claim(method, path, status);
        if (allowed) allowConsole(path, status);
        record({ kind: 'response', method, path, outcome: status }, allowed);
      };
      const onRequestFailed = (request: Request) => {
        // Chromium may suffix the error (`net::ERR_BLOCKED_BY_CLIENT.Inspector`); keep the code.
        const errorText = request.failure()?.errorText ?? 'unknown',
          failure = /^net::[A-Z_]+/.exec(errorText)?.[0] ?? errorText,
          method = request.method(),
          path = pathOf(request.url()),
          allowed = claim(method, path, failure);
        if (allowed) allowConsole(path, failure);
        record({ kind: 'requestfailed', method, path, outcome: failure }, allowed);
      };
      const onConsole = (message: ConsoleMessage) => {
        if (message.type() !== 'error') return;
        const text = message.text(),
          path = pathOf(message.location().url),
          resource = failedResource.exec(text),
          outcome = resource ? (resource[1] ? Number(resource[1]) : resource[2]!) : undefined;
        const allowed = outcome !== undefined && takeConsole(path, outcome);
        record(
          { kind: 'console', path, ...(outcome ? { outcome } : {}), text: withoutQuery(text) },
          allowed,
        );
      };
      const onWebSocket = (socket: WebSocket) => {
        socket.on('socketerror', (error) =>
          record(
            { kind: 'websocket', path: pathOf(socket.url()), text: withoutQuery(error) },
            false,
          ),
        );
      };
      const watch = (target: Page) => {
        if (watched.has(target)) return;
        watched.add(target);
        target.on('console', onConsole);
        target.on('pageerror', (error) =>
          record(
            { kind: 'pageerror', path: pathOf(target.url()), text: withoutQuery(error.message) },
            false,
          ),
        );
        target.on('websocket', onWebSocket);
        target.on('response', onResponse);
        target.on('requestfailed', onRequestFailed);
      };
      context.pages().forEach(watch);
      context.on('page', watch);
      await use({
        expectFailure(failure) {
          if (failure.upTo !== undefined && failure.outcome !== 'net::ERR_ABORTED')
            throw new Error('Only cancelled requests (net::ERR_ABORTED) may use upTo.');
          expected.push({ ...failure, seen: 0 });
        },
        watch,
      });
      context.off('page', watch);
      const problems = [
        ...unexpected.map((observation) => `unexpected ${describe(observation)}`),
        ...expected
          .filter((failure) =>
            failure.upTo === undefined
              ? failure.seen !== (failure.times ?? 1)
              : failure.seen > failure.upTo,
          )
          .map(
            (failure) =>
              `expected ${failure.method} ${String(failure.path)} → ${failure.outcome} ${failure.upTo === undefined ? `×${failure.times ?? 1}` : `≤${failure.upTo}`}, saw ×${failure.seen}`,
          ),
      ];
      expect(problems, 'console errors and failed requests').toEqual([]);
    },
    { auto: true },
  ],
});
