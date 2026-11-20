import { randomUUID } from 'node:crypto';
import { uiEvents, type UiEventId } from '../../src/observability/ui-events';

type Level = 'info' | 'warn' | 'error';
interface EventSpec {
  module: 'desktop-offline-billing' | 'desktop-shell';
  level: Level;
  /** Fixed sentence logged as `msg` (the `details` of the log schema): never any value. */
  msg: string;
}

/**
 * Registered events of the desktop main process (`process: 'main'`). The desktop logger accepts
 * only these IDs and the renderer IDs in `src/observability/ui-events.ts`.
 */
export const mainEvents = {
  'offline.storage.unavailable': {
    module: 'desktop-offline-billing',
    level: 'error',
    msg: 'Offline billing storage is unavailable',
  },
  'offline.ipc.completed': {
    module: 'desktop-offline-billing',
    level: 'info',
    msg: 'Offline billing request handled',
  },
  'offline.ipc.rejected': {
    module: 'desktop-offline-billing',
    level: 'warn',
    msg: 'Offline billing request from an untrusted sender was refused',
  },
  'offline.heartbeat.failed': {
    module: 'desktop-offline-billing',
    level: 'warn',
    msg: 'Store service contact failed',
  },
  'offline.session.check-failed': {
    module: 'desktop-offline-billing',
    level: 'warn',
    msg: 'The session could not be verified with the store service',
  },
  'offline.check-in.read-failed': {
    module: 'desktop-offline-billing',
    level: 'warn',
    msg: 'The check-in could not be read from the store service',
  },
  'offline.settings.read-failed': {
    module: 'desktop-offline-billing',
    level: 'warn',
    msg: 'Offline billing limits could not be read from the store service',
  },
  'offline.stores.read-failed': {
    module: 'desktop-offline-billing',
    level: 'warn',
    msg: 'Store names could not be read from the store service',
  },
  'offline.counters.read-failed': {
    module: 'desktop-offline-billing',
    level: 'warn',
    msg: 'Store counters could not be read from the store service',
  },
  'offline.clock.persist-failed': {
    module: 'desktop-offline-billing',
    level: 'error',
    msg: 'The offline billing window could not be saved',
  },
  'offline.catalog.refreshed': {
    module: 'desktop-offline-billing',
    level: 'info',
    msg: 'Offline catalogue refresh finished',
  },
  'offline.catalog.truncated': {
    module: 'desktop-offline-billing',
    level: 'warn',
    msg: 'Offline catalogue stopped at the page cap; later products are not on this device',
  },
  'offline.sales.pruned': {
    module: 'desktop-offline-billing',
    level: 'info',
    msg: 'Old synced offline sales were removed from this device',
  },
  'offline.sales.prune-failed': {
    module: 'desktop-offline-billing',
    level: 'warn',
    msg: 'Old synced offline sales could not be removed from this device',
  },
  'offline.sale.created': {
    module: 'desktop-offline-billing',
    level: 'info',
    msg: 'Offline sale saved on this device',
  },
  'offline.sale.synced': {
    module: 'desktop-offline-billing',
    level: 'info',
    msg: 'Offline sale uploaded',
  },
  'offline.sale.conflict': {
    module: 'desktop-offline-billing',
    level: 'warn',
    msg: 'Offline sale needs a manager decision',
  },
  'offline.sale.retry-scheduled': {
    module: 'desktop-offline-billing',
    level: 'warn',
    msg: 'Offline sale upload deferred',
  },
  'offline.sync.completed': {
    module: 'desktop-offline-billing',
    level: 'info',
    msg: 'Offline sales sync finished',
  },
  'offline.sync.interrupted': {
    module: 'desktop-offline-billing',
    level: 'warn',
    msg: 'Sales left mid-upload by a restart now need a manager decision',
  },
  'offline.sync.failed': {
    module: 'desktop-offline-billing',
    level: 'error',
    msg: 'Offline sales sync stopped with an error',
  },
  'offline.conflict.resolved': {
    module: 'desktop-offline-billing',
    level: 'info',
    msg: 'Manager resolved an offline sale',
  },
  'desktop.offline-billing.start-failed': {
    module: 'desktop-shell',
    level: 'error',
    msg: 'Offline billing could not start; the online workspace continues',
  },
  'desktop.renderer.gone': {
    module: 'desktop-shell',
    level: 'error',
    msg: 'The workspace renderer process ended',
  },
  'desktop.workspace.load-failed': {
    module: 'desktop-shell',
    level: 'error',
    msg: 'The workspace could not be loaded',
  },
  'desktop.app.start-failed': {
    module: 'desktop-shell',
    level: 'error',
    msg: 'The desktop app could not start',
  },
} as const satisfies Record<string, EventSpec>;
export type MainEventId = keyof typeof mainEvents;
export type DesktopEventId = MainEventId | UiEventId;

/** Fields a desktop event may carry: identifiers, codes, counts and timings only. */
export interface DesktopLogEvent {
  eventId: DesktopEventId;
  /** The operation's trace; HTTP calls derive their own `requestId` from it. */
  traceId: string;
  requestId?: string;
  outcome?: 'succeeded' | 'failed' | 'skipped';
  /** A stable error code (never a message). */
  errorCode?: string;
  /** An error class name such as `TypeError` (never the message or stack). */
  errorName?: string;
  /** IPC channel (also the `resource`). */
  channel?: string;
  /** Manager resolution action or similar fixed keyword. */
  action?: string;
  /** Renderer route pattern (`/orders/:id`), for renderer events only. */
  route?: string;
  /** Renderer `render-process-gone` reason, a fixed Electron keyword. */
  reason?: string;
  count?: number;
  durationMs?: number;
}
export type LogProcess = 'main' | 'preload' | 'renderer';

const levels: Record<Level, number> = { info: 30, warn: 40, error: 50 };
const keyword = /^[A-Za-z0-9_:.-]{1,64}$/;
/** Values that are not a fixed keyword become null instead of reaching the log. */
const safe = (value: string | undefined) =>
  value === undefined ? undefined : keyword.test(value) ? value : null;

/**
 * One desktop log record, shaped like the backend's pino lines: numeric `level`, epoch-ms
 * `time`, fixed `msg`, `process`, `module`, `resource`, `eventId`, `eventInstanceId`, `traceId`,
 * `requestId` and `userId`. The event is spread first, so it cannot override the identity fields;
 * free-text fields are reduced to keywords.
 */
export function desktopRecord(
  event: DesktopLogEvent,
  context: { userId: string | null; now: number },
): Record<string, unknown> {
  const ui = event.eventId in uiEvents,
    spec = ui ? null : mainEvents[event.eventId as MainEventId],
    level: Level = spec
      ? spec.level === 'info' && event.outcome === 'failed'
        ? 'warn'
        : spec.level
      : 'error',
    process: LogProcess = ui ? 'renderer' : 'main';
  return {
    ...event,
    errorCode: safe(event.errorCode),
    errorName: safe(event.errorName),
    channel: safe(event.channel),
    action: safe(event.action),
    reason: safe(event.reason),
    level: levels[level],
    time: context.now,
    msg: spec ? spec.msg : uiEvents[event.eventId as UiEventId],
    process,
    module: spec ? spec.module : 'ui',
    resource: safe(event.channel) ?? event.eventId.split('.')[1] ?? 'runtime',
    eventId: event.eventId,
    eventInstanceId: randomUUID(),
    traceId: event.traceId,
    requestId: event.requestId ?? event.traceId,
    userId: context.userId,
  };
}
