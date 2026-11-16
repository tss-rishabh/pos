import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt } from 'drizzle-orm';
import type { Databases } from '../../db/pools.js';
import { documentationMediaCleanup } from './media-cleanup.js';
import { documentationAssets } from './media-schema.js';
import type { DocumentationMediaOptions, DocumentationMediaStore } from './media-storage.js';

export interface MediaWorkerEvent {
  module: 'administration';
  resource: 'documentation-media' | 'documentation-media-worker';
  eventId: string;
  eventInstanceId: string;
  requestId: string | null;
  userId: string | null;
  effectId?: string;
  documentId?: string | null;
  errorCode?: string;
}
export type MediaWorkerLogger = (
  level: 'info' | 'warn',
  event: MediaWorkerEvent,
  message: string,
) => void;
const event = (
  resource: MediaWorkerEvent['resource'],
  action: string,
  requestId: string | null = null,
  userId: string | null = null,
): MediaWorkerEvent => ({
  module: 'administration',
  resource,
  eventId: `administration.${resource}.${action}`,
  eventInstanceId: randomUUID(),
  requestId,
  userId,
});
export function documentationMediaWorker(
  db: Databases,
  media: DocumentationMediaStore,
  options: DocumentationMediaOptions,
  log: MediaWorkerLogger,
) {
  const cleanup = documentationMediaCleanup(db, media);
  const blocked = new Set<string>();
  function rememberBlocked(id: string) {
    blocked.add(id);
    if (blocked.size > 1000) blocked.delete(blocked.values().next().value!);
  }
  let afterBlocked = '';
  async function alertBlocked(runId: string) {
    const rows = await db
      .get('writer')
      .select({
        id: documentationAssets.id,
        actorId: documentationAssets.actorId,
        requestId: documentationAssets.requestId,
        documentId: documentationAssets.documentId,
      })
      .from(documentationAssets)
      .where(
        and(eq(documentationAssets.state, 'BLOCKED'), gt(documentationAssets.id, afterBlocked)),
      )
      .orderBy(asc(documentationAssets.id))
      .limit(options.DOCUMENTATION_MEDIA_WORKER_BATCH_SIZE);
    afterBlocked =
      rows.length === options.DOCUMENTATION_MEDIA_WORKER_BATCH_SIZE ? rows.at(-1)!.id : '';
    for (const row of rows) {
      if (blocked.has(row.id)) continue;
      rememberBlocked(row.id);
      log(
        'warn',
        {
          ...event('documentation-media', 'cleanup-blocked', row.requestId || runId, row.actorId),
          effectId: row.id,
          documentId: row.documentId === null ? null : String(row.documentId),
          errorCode: 'DOCUMENTATION_CLEANUP_BLOCKED',
        },
        'Guide attachment cleanup requires operator recovery',
      );
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined,
    active: Promise<void> | undefined,
    abort: AbortController | undefined,
    stopping = false;
  const runOnce = () => {
    if (stopping || !options.DOCUMENTATION_MEDIA_WORKER_ENABLED) return Promise.resolve();
    if (active) return active;
    const runId = randomUUID();
    abort = new AbortController();
    const deadline = setTimeout(() => abort?.abort(), 20000);
    deadline.unref();
    active = (async () => {
      try {
        for (
          let index = 0;
          index < options.DOCUMENTATION_MEDIA_WORKER_BATCH_SIZE &&
          !stopping &&
          !abort?.signal.aborted;
          index++
        ) {
          const result = await cleanup.dispatchNext(abort?.signal);
          if (!result) break;
          if (result.status === 'blocked') rememberBlocked(result.id);
          else blocked.delete(result.id);
          log(
            result.status === 'deleted' || result.status === 'retained' ? 'info' : 'warn',
            {
              ...event(
                'documentation-media',
                `cleanup-${result.status}`,
                result.requestId || runId,
                result.actorId,
              ),
              effectId: result.id,
              documentId: result.documentId,
              ...(result.errorCode ? { errorCode: result.errorCode } : {}),
            },
            result.status === 'deleted'
              ? 'Unreferenced guide attachment deleted'
              : result.status === 'retained'
                ? 'Shared guide attachment retained'
                : 'Guide attachment cleanup requires retry or recovery',
          );
          if (result.status === 'failed') break;
        }
        await alertBlocked(runId);
      } catch {
        log(
          'warn',
          {
            ...event('documentation-media-worker', 'batch-failed', runId),
            errorCode: 'DOCUMENTATION_CLEANUP_UNAVAILABLE',
          },
          'Guide media cleanup could not complete this batch',
        );
      } finally {
        clearTimeout(deadline);
        active = undefined;
        abort = undefined;
      }
    })();
    return active;
  };
  async function tick() {
    await runOnce();
    if (!stopping)
      timer = setTimeout(() => void tick(), options.DOCUMENTATION_MEDIA_WORKER_INTERVAL_MS);
  }
  return {
    runOnce,
    start() {
      if (timer || active || stopping) return;
      if (!options.DOCUMENTATION_MEDIA_WORKER_ENABLED) {
        log(
          'info',
          event('documentation-media-worker', 'disabled'),
          'Guide media cleanup is disabled',
        );
        return;
      }
      log('info', event('documentation-media-worker', 'started'), 'Guide media cleanup started');
      void tick();
    },
    async stop() {
      stopping = true;
      if (timer) clearTimeout(timer);
      abort?.abort();
      await active;
      log('info', event('documentation-media-worker', 'stopped'), 'Guide media cleanup stopped');
    },
  };
}
