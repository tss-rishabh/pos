import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  evaluateRelease,
  sourceInventorySchema,
  releaseCoverageSchema,
} from '../src/domain/release.js';

const workspace = resolve('..');
const inventory = sourceInventorySchema.parse(
  JSON.parse(readFileSync('parity/legacy-inventory.json', 'utf8')) as unknown,
);
const coverage = releaseCoverageSchema.parse(
  JSON.parse(readFileSync('parity/release-coverage.json', 'utf8')) as unknown,
);
function localFile(path: string) {
  const file = resolve(workspace, path),
    part = relative(workspace, file);
  if (part.startsWith('..') || isAbsolute(part)) return false;
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}
const evidenceSchema = z.object({
  sourceCommit: z.literal(inventory.source_commit),
  recordedAt: z.iso.datetime(),
  command: z.string().min(1),
  exitCode: z.literal(0),
  checksums: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
});
function evidence(path: string, references: string[]) {
  if (!path.startsWith('backend/evidence/') || !localFile(path)) return false;
  try {
    const record = evidenceSchema.parse(
      JSON.parse(readFileSync(resolve(workspace, path), 'utf8')) as unknown,
    );
    return (
      [
        ...references,
        'backend/package-lock.json',
        'frontend/package-lock.json',
        'backend/parity/legacy-inventory.json',
      ].every((reference) => reference in record.checksums) &&
      Object.entries(record.checksums).length > 0 &&
      Object.entries(record.checksums).every(
        ([name, checksum]) =>
          localFile(name) &&
          createHash('sha256')
            .update(readFileSync(resolve(workspace, name)))
            .digest('hex') === checksum,
      )
    );
  } catch {
    return false;
  }
}
const result = evaluateRelease(inventory, coverage, evidence, localFile);
const sourceRoot = resolve(process.env.LEGACY_SOURCE_ROOT || '../../backend-pos-web');
const sourceFiles = z
  .object({
    source_hashes: z
      .array(z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }))
      .min(1),
  })
  .parse(JSON.parse(readFileSync('parity/legacy-inventory.json', 'utf8')) as unknown);
for (const source of sourceFiles.source_hashes) {
  const file = resolve(sourceRoot, source.path),
    part = relative(sourceRoot, file);
  try {
    if (
      part.startsWith('..') ||
      isAbsolute(part) ||
      createHash('sha256').update(readFileSync(file)).digest('hex') !== source.sha256
    )
      throw new Error('Changed source');
  } catch {
    result.failures.push(
      'The source checkout is missing or differs from the inventoried snapshot.',
    );
    break;
  }
}
if (result.failures.length) result.productionReady = false;
console.log(JSON.stringify(result, null, 2));
if (!result.productionReady) {
  console.error(
    'Production release blocked: every source surface and release requirement needs current, reviewable parity evidence.',
  );
  process.exitCode = 1;
}
