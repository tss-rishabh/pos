import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import { AppError } from '../../src/domain/errors.js';
import { identifier } from '../../src/domain/validation.js';
import { validateAccessSnapshot } from '../../src/modules/administration/access-domain.js';
import { reconcileAdministrationAccess } from '../../src/modules/administration/access-reconciliation.js';

const requestId = crypto.randomUUID();
let db: Databases | undefined,
  userId: string | null = null;
const event = (
  action: string,
  extra: {
    snapshotHash?: string;
    counts?: ReturnType<typeof validateAccessSnapshot>['counts'];
    errorCode?: string;
  } = {},
) =>
  process.stdout.write(
    JSON.stringify({
      module: 'administration',
      resource: 'model-administration-access-import',
      eventId: `administration.model-administration-access-import.${action}`,
      eventInstanceId: crypto.randomUUID(),
      requestId,
      userId,
      ...extra,
    }) + '\n',
  );
try {
  const args = process.argv.slice(2),
    apply = args[0] === '--apply',
    path = args[apply ? 1 : 0];
  if (!path || args.length !== (apply ? 2 : 1))
    throw new AppError(
      400,
      'ADMIN_ACCESS_IMPORT_ARGUMENT',
      'Provide one snapshot file, optionally prefixed with --apply.',
    );
  const file = await stat(path);
  if (!file.isFile() || file.size < 1 || file.size > 32 * 1024 * 1024)
    throw new AppError(
      400,
      'ADMIN_ACCESS_IMPORT_FILE',
      'Choose a complete access snapshot smaller than 32 MB.',
    );
  let input: unknown;
  try {
    const bytes = await readFile(path);
    if (bytes.length > 32 * 1024 * 1024) throw new Error('Snapshot exceeds the supported size.');
    input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new AppError(400, 'ADMIN_ACCESS_IMPORT_JSON', 'Choose a valid source access snapshot.');
  }
  const validated = validateAccessSnapshot(input);
  if (!apply) event('preview', { snapshotHash: validated.hash, counts: validated.counts });
  else {
    const options = z
      .object({
        ADMIN_ACCESS_SOURCE_VERIFIED: z.literal('true'),
        ADMIN_ACCESS_IMPORT_OPERATOR_ID: identifier,
      })
      .parse(process.env);
    userId = options.ADMIN_ACCESS_IMPORT_OPERATOR_ID;
    const config = readConfig();
    if (config.DEMO_MODE)
      throw new AppError(
        503,
        'ADMIN_ACCESS_IMPORT_DEMO_FORBIDDEN',
        'Use an explicit writer service configuration.',
      );
    db = createDatabases(config);
    const result = await reconcileAdministrationAccess(db, validated.snapshot, {
      operatorId: userId,
      requestId,
    });
    event(result.replay ? 'replayed' : 'completed', {
      snapshotHash: result.hash,
      counts: result.counts,
    });
  }
} catch (error) {
  event('failed', {
    errorCode: error instanceof AppError ? error.code : 'ADMIN_ACCESS_IMPORT_INVALID',
  });
  process.exitCode = 1;
} finally {
  await db?.close().catch(() => undefined);
}
