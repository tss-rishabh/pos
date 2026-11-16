import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readConfig } from '../config.js';
import { applyMigrations, migrationPlan, MigrationError } from './migrations.js';

export async function main(args: string[]) {
  if (args.some((value) => value !== '--apply'))
    throw new MigrationError('INVALID_MIGRATION_ARGUMENT');
  const plan = migrationPlan();
  if (!args.includes('--apply')) {
    process.stdout.write(
      JSON.stringify(
        {
          mode: 'plan',
          migrations: plan.map((value) => ({
            id: value.id,
            checksum: value.checksum,
            statements: value.statements.length,
          })),
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }
  const result = await applyMigrations(readConfig(), plan);
  process.stdout.write(
    JSON.stringify({
      eventId: 'database.schema-migration.apply.completed',
      eventInstanceId: crypto.randomUUID(),
      module: 'database',
      resource: 'schema-migration',
      requestId: null,
      userId: null,
      ...result,
    }) + '\n',
  );
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  void main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      JSON.stringify({
        eventId: 'database.schema-migration.apply.failed',
        eventInstanceId: crypto.randomUUID(),
        module: 'database',
        resource: 'schema-migration',
        requestId: null,
        userId: null,
        errorCode: error instanceof MigrationError ? error.code : 'MIGRATION_FAILED',
      }) + '\n',
    );
    process.exitCode = 1;
  });
