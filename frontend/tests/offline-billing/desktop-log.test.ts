import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopRecord, mainEvents, type DesktopLogEvent } from '../../electron/offline/events';
import { jsonlSink } from '../../electron/offline/log-sink';
import { callRequestId } from '../../electron/offline/request-id';
import { dispatchIpc, type IpcHandlers } from '../../electron/offline/ipc';
import { uiEvents } from '../../src/observability/ui-events';

/** Workstream D: the desktop log sink, record shape, registry and per-call request IDs. */
const traceId = '6f1c1d3e-2f0a-4b8e-9c55-3a1d2b4c5e6f';
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pos-desktop-log-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('desktop log record', () => {
  it('matches the backend line shape: numeric level, epoch-ms time, fixed msg, process and errorCode', () => {
    const record = desktopRecord(
      {
        eventId: 'offline.sale.retry-scheduled',
        traceId,
        requestId: callRequestId(traceId, 'upload:x'),
        outcome: 'failed',
        errorCode: 'NETWORK_UNAVAILABLE',
      },
      { userId: '77', now: 1_763_600_000_000 },
    );
    expect(record).toMatchObject({
      level: 40,
      time: 1_763_600_000_000,
      msg: mainEvents['offline.sale.retry-scheduled'].msg,
      process: 'main',
      module: 'desktop-offline-billing',
      resource: 'sale',
      eventId: 'offline.sale.retry-scheduled',
      traceId,
      userId: '77',
      errorCode: 'NETWORK_UNAVAILABLE',
    });
    expect(record.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(record.eventInstanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(record).not.toHaveProperty('code');
  });
  it('spreads the event first, so it cannot overwrite module, requestId, userId or msg', () => {
    const forged = {
      eventId: 'offline.ipc.completed',
      traceId,
      outcome: 'succeeded',
      module: 'forged-module',
      requestId: traceId,
      userId: 'forged-user',
      msg: 'forged message 9876543210',
      level: 10,
    } as DesktopLogEvent;
    const record = desktopRecord(forged, { userId: '42', now: 1 });
    expect(record.module).toBe('desktop-offline-billing');
    expect(record.userId).toBe('42');
    expect(record.msg).toBe(mainEvents['offline.ipc.completed'].msg);
    expect(record.level).toBe(30);
    expect(JSON.stringify(record)).not.toContain('9876543210');
  });
  it('reduces free-text codes to null and raises a failed info event to warn', () => {
    const record = desktopRecord(
      {
        eventId: 'offline.ipc.completed',
        traceId,
        outcome: 'failed',
        errorCode: 'SQLITE_CORRUPT at /Users/someone/secret.db',
        errorName: 'Error: customer 9876543210',
      },
      { userId: null, now: 1 },
    );
    expect(record.level).toBe(40);
    expect(record.errorCode).toBeNull();
    expect(record.errorName).toBeNull();
    expect(JSON.stringify(record)).not.toContain('secret');
  });
  it('logs renderer reports as process renderer, module ui, with the fixed renderer message', () => {
    const record = desktopRecord(
      {
        eventId: 'ui.render.failed',
        traceId,
        outcome: 'failed',
        errorName: 'TypeError',
        route: '/orders/:id',
      },
      { userId: '5', now: 1 },
    );
    expect(record).toMatchObject({
      process: 'renderer',
      module: 'ui',
      level: 50,
      msg: uiEvents['ui.render.failed'],
      errorName: 'TypeError',
      route: '/orders/:id',
    });
  });
});

describe('desktop log sink', () => {
  it('appends JSON lines and rotates at the size cap, keeping a fixed number of files', async () => {
    const sink = jsonlSink({ directory, maxBytes: 8192, maxFiles: 2 });
    for (let index = 0; index < 120; index++)
      sink.write(
        desktopRecord(
          { eventId: 'offline.ipc.completed', traceId: randomUUID(), outcome: 'succeeded' },
          { userId: null, now: index },
        ),
      );
    sink.close();
    const files = (await readdir(directory)).sort();
    expect(files).toEqual(['retail-pos.jsonl', 'retail-pos.jsonl.1', 'retail-pos.jsonl.2']);
    for (const file of files) {
      const text = await readFile(join(directory, file), 'utf8');
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8192);
      for (const line of text.trim().split('\n'))
        expect(JSON.parse(line)).toMatchObject({
          eventId: 'offline.ipc.completed',
          process: 'main',
        });
    }
  });
  it('creates the log folder, writes stdout only when asked, and never throws on an unwritable path', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const nested = join(directory, 'Retail POS', 'logs');
      const quiet = jsonlSink({ directory: nested });
      quiet.write({ eventId: 'offline.sale.created' });
      quiet.close();
      expect(write).not.toHaveBeenCalled();
      expect(await readFile(join(nested, 'retail-pos.jsonl'), 'utf8')).toContain(
        'offline.sale.created',
      );
      const development = jsonlSink({ directory, stdout: true });
      development.write({ eventId: 'offline.sale.created' });
      development.close();
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      write.mockRestore();
    }
    const blocked = jsonlSink({
      directory: join(directory, 'retail-pos.jsonl', 'not-a-directory'),
    });
    jsonlSink({ directory }).write({ eventId: 'offline.sale.created' });
    expect(() => blocked.write({ eventId: 'offline.sale.created' })).not.toThrow();
  });
});

describe('per-call request IDs', () => {
  it('derives a distinct, stable version-8 UUID per call from one trace ID', () => {
    const steps = ['reachable', 'session', 'check-in', 'catalog:0', 'catalog:1', 'upload:a'];
    const ids = steps.map((step) => callRequestId(traceId, step));
    expect(new Set(ids).size).toBe(steps.length);
    for (const id of ids)
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(callRequestId(traceId, 'session')).toBe(ids[1]);
    expect(callRequestId(randomUUID(), 'session')).not.toBe(ids[1]);
  });
});

describe('UI error IPC channel', () => {
  const fail = () => {
    throw new Error('not expected');
  };
  const handlers = (report: IpcHandlers['diagnostics:ui-error']) =>
    ({
      'offline:status': fail,
      'offline:catalog:search': fail,
      'offline:catalog:barcode': fail,
      'offline:catalog:refresh': fail,
      'offline:salespeople:list': fail,
      'offline:sale:create': fail,
      'offline:sale:list': fail,
      'offline:sale:reprint': fail,
      'offline:sync:retry': fail,
      'offline:conflict:resolve': fail,
      'diagnostics:ui-error': report,
    }) satisfies IpcHandlers;
  it('accepts only the ID-only report schema', async () => {
    const report = vi.fn(() => ({}));
    const accepted = await dispatchIpc(
      'diagnostics:ui-error',
      {
        requestId: traceId,
        payload: { eventId: 'ui.window.error', errorName: 'TypeError', route: '/sales' },
      },
      handlers(report),
      vi.fn(),
    );
    expect(accepted).toMatchObject({ ok: true });
    for (const payload of [
      { eventId: 'ui.window.error', errorName: 'TypeError', route: '/sales', message: 'x' },
      { eventId: 'ui.window.error', errorName: 'TypeError', route: '/sales', stack: 'at x' },
      { eventId: 'ui.anything', errorName: 'TypeError', route: '/sales' },
      { eventId: 'ui.window.error', errorName: 'Customer 9876543210', route: '/sales' },
      { eventId: 'ui.window.error', errorName: 'TypeError', route: '/customers/9876543210' },
      { eventId: 'ui.window.error', errorName: 'TypeError', route: '/sales?phone=9876543210' },
    ]) {
      const rejected = await dispatchIpc(
        'diagnostics:ui-error',
        { requestId: traceId, payload },
        handlers(report),
        vi.fn(),
      );
      expect(rejected).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    }
    expect(report).toHaveBeenCalledTimes(1);
  });
  it('logs the error class name of an unexpected handler failure, never its message', async () => {
    const log = vi.fn();
    await dispatchIpc(
      'diagnostics:ui-error',
      {
        requestId: traceId,
        payload: { eventId: 'ui.window.error', errorName: 'TypeError', route: '/' },
      },
      handlers(() => {
        throw new RangeError('customer 9876543210');
      }),
      log,
    );
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'OFFLINE_BILLING_FAILED', errorName: 'RangeError' }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain('9876543210');
  });
});
