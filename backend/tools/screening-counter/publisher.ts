/** Independent publisher CLI. Authoring this entry does not authorize running
 * it against a live writer. BigQuery access here is SELECT-only. The review SQL
 * generation publisher requires a separately authorized identity/deployment. */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import { equalImportHash } from '../../src/modules/legacy-order-imports/financial-adapter-primitives.js';
import {
  counterCaptureSchema,
  counterCustomer,
  counterDigest,
  counterHash,
} from '../../src/modules/legacy-order-imports/screening-counter/contracts.js';
import {
  configuredScreeningCounterPublisher,
  readScreeningCounterPublisherOptions,
} from '../../src/modules/legacy-order-imports/screening-counter/options.js';
export async function screeningCounterPublisherMain(
  args = process.argv.slice(2),
  env = process.env,
) {
  let db: Databases | undefined;
  const requestId = randomUUID();
  try {
    const options = readScreeningCounterPublisherOptions(env);
    if (!options.contract || !env.POS_SCREENING_COUNTER_ARTIFACT_DIRECTORY)
      throw new Error('Publisher disabled');
    if (!['capture', 'complete'].includes(args[0] ?? '') || args.length < 2 || args.length > 3)
      throw new Error('Publisher arguments');
    const directory = resolve(env.POS_SCREENING_COUNTER_ARTIFACT_DIRECTORY),
      config = readConfig();
    if (config.DEMO_MODE || !config.MYSQL_WRITER_URL) throw new Error('Publisher writer missing');
    db = createDatabases(config);
    const publisher = configuredScreeningCounterPublisher(config, db, options);
    if (!publisher) throw new Error('Publisher disabled');
    let generationId: string | undefined, artifact: string;
    if (args[0] === 'capture') {
      if (args.length !== 2) throw new Error('Publisher arguments');
      const capture = await publisher.capture(counterCustomer.parse(args[1]));
      artifact = 'screening-counter-capture-' + capture.snapshotId + '.json';
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = join(directory, '.' + randomUUID() + '.tmp');
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(capture));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, join(directory, artifact));
    } else {
      artifact = args[1]!;
      if (!/^screening-counter-capture-[a-f0-9-]{36}\.json$/.test(artifact))
        throw new Error('Publisher artifact');
      const handle = await open(
        join(directory, artifact),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      let raw: string;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 12000 || (stat.mode & 0o077) !== 0)
          throw new Error('Publisher artifact');
        raw = await handle.readFile('utf8');
      } finally {
        await handle.close();
      }
      const capture = counterCaptureSchema.parse(JSON.parse(raw) as unknown),
        { signature, ...body } = capture;
      if (
        !options.sourceKey ||
        !equalImportHash(signature, counterDigest(options.sourceKey, 'capture', body))
      )
        throw new Error('Publisher artifact');
      generationId = (
        await publisher.complete(capture, args[2] === undefined ? null : counterHash.parse(args[2]))
      ).generationId;
    }
    process.stdout.write(
      JSON.stringify({
        module: 'reports',
        resource: 'screening-counter-publisher',
        eventId: 'reports.screening-counter-publisher.' + args[0],
        requestId,
        userId: null,
        artifact,
        ...(generationId ? { generationId } : {}),
      }) + '\n',
    );
    return 0;
  } catch {
    // Unknown SDK/driver errors never reach stdout/stderr, stack or logs.
    process.stderr.write(
      JSON.stringify({
        module: 'reports',
        resource: 'screening-counter-publisher',
        eventId: 'reports.screening-counter-publisher.unavailable',
        requestId,
        userId: null,
        code: 'SCREENING_COUNTER_PUBLISHER_UNAVAILABLE',
      }) + '\n',
    );
    return 1;
  } finally {
    try {
      await db?.close();
    } catch {
      /* Do not expose driver shutdown payloads. */
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = await screeningCounterPublisherMain();
