import Fastify, { LogController } from 'fastify';
import { randomUUID } from 'node:crypto';
import { readConfig } from '../../config.js';
import { createDatabases, type Databases } from '../../db/pools.js';
import { AppError } from '../../domain/errors.js';
import {
  createDocumentationMediaStore,
  readDocumentationMediaOptions,
  type DocumentationMediaStore,
} from './media-storage.js';
import { documentationMediaWorker, type MediaWorkerLogger } from './media-worker.js';
import { documentationMediaCleanup } from './media-cleanup.js';

class PrivateMediaLogController extends LogController {
  constructor() {
    super({ disableRequestLogging: true });
  }
}
const workerRunId = randomUUID();
const runtime = Fastify({
  logger: {
    base: null,
    serializers: {
      err: () => ({ type: 'InternalError', message: 'Media worker operation failed', stack: '' }),
    },
    mixin: () => ({
      module: 'administration',
      resource: 'documentation-media-worker',
      eventId: 'administration.documentation-media-worker.lifecycle',
      eventInstanceId: randomUUID(),
      requestId: workerRunId,
      userId: null,
    }),
  },
  logController: new PrivateMediaLogController(),
});
const log: MediaWorkerLogger = (level, event, message) =>
  runtime.log[level]({ ...event, requestId: event.requestId ?? workerRunId }, message);
let db: Databases | undefined, media: DocumentationMediaStore | undefined;
try {
  const options = readDocumentationMediaOptions(),
    args = process.argv.slice(2);
  if (
    args.length &&
    (!options.DOCUMENTATION_MEDIA_WORKER_ENABLED ||
      args.length !== 2 ||
      args[0] !== '--retry-asset' ||
      !/^[0-9a-f-]{36}$/i.test(args[1]!))
  )
    throw new AppError(
      400,
      'MEDIA_WORKER_ARGUMENTS_INVALID',
      'Choose one configured attachment cleanup recovery.',
    );
  if (!options.DOCUMENTATION_MEDIA_WORKER_ENABLED) {
    log(
      'info',
      {
        module: 'administration',
        resource: 'documentation-media-worker',
        eventId: 'administration.documentation-media-worker.disabled',
        eventInstanceId: randomUUID(),
        requestId: workerRunId,
        userId: null,
      },
      'Guide media cleanup is disabled',
    );
    await runtime.close();
  } else {
    const config = readConfig();
    media = createDocumentationMediaStore(config, options);
    if (!media || !config.MYSQL_WRITER_URL)
      throw new AppError(
        503,
        'MEDIA_WORKER_CONFIGURATION_REQUIRED',
        'Configure private guide storage and its writer.',
      );
    db = createDatabases(config);
    if (args.length) {
      await documentationMediaCleanup(db, media).retry(args[1]!);
      log(
        'info',
        {
          module: 'administration',
          resource: 'documentation-media',
          eventId: 'administration.documentation-media.cleanup-requeued',
          eventInstanceId: randomUUID(),
          requestId: randomUUID(),
          userId: null,
          effectId: args[1]!,
        },
        'Guide attachment cleanup requeued',
      );
      await db.close();
      media.close();
      await runtime.close();
    } else {
      const worker = documentationMediaWorker(db, media, options, log);
      let closing = false;
      for (const signal of ['SIGTERM', 'SIGINT'] as const)
        process.on(signal, async () => {
          if (closing) return;
          closing = true;
          const deadline = setTimeout(() => process.exit(1), 10000);
          deadline.unref();
          await worker.stop();
          await db?.close();
          media?.close();
          await runtime.close();
          clearTimeout(deadline);
        });
      worker.start();
    }
  }
} catch (error) {
  log(
    'warn',
    {
      module: 'administration',
      resource: 'documentation-media-worker',
      eventId: 'administration.documentation-media-worker.startup-failed',
      eventInstanceId: randomUUID(),
      requestId: workerRunId,
      userId: null,
      errorCode: error instanceof AppError ? error.code : 'MEDIA_WORKER_CONFIGURATION_INVALID',
    },
    'Guide media cleanup could not start',
  );
  await db?.close();
  media?.close();
  await runtime.close();
  process.exitCode = 1;
}
