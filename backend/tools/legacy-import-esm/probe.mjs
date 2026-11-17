import { pathToFileURL } from 'node:url';

// Each invocation is a fresh native ESM process. Never print import errors,
// SDK objects, environment values or module output from a failed graph.
try {
  if (!process.argv[2]) throw new Error('Missing isolated entrypoint.');
  await import(pathToFileURL(process.argv[2]).href);
  process.stdout.write('IMPORT_OK\n');
} catch {
  process.stdout.write('IMPORT_FAILED\n');
  process.exitCode = 1;
}
