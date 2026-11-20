/**
 * Verbatim source excerpts captured from a pinned legacy file, for tests that execute the
 * original legacy code itself (a template's jQuery handler, a sync-service query function) on
 * test inputs. They replace reading sibling legacy checkouts at test time.
 *
 * Captured by `tools/golden/capture-source-excerpts.ts` from files exported with
 * `git show <pin>:<path>`; the whole-file SHA-256 is checked at capture time and every excerpt
 * records its own SHA-256, which is re-checked here. Never edit an excerpt by hand: recapture.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { goldenPath } from './load.js';

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
export const sourceExcerptFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('source-excerpt'),
    sourceRepository: z.string().min(1),
    sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
    path: z.string().min(1),
    fileSha256: sha256,
    capturedAt: z.iso.datetime(),
    capture: z.string().min(1),
    test: z.string().min(1),
    excerpts: z.record(
      z.string(),
      z.object({ rule: z.string().min(1), sha256, text: z.string().min(1) }).strict(),
    ),
  })
  .strict();
export type SourceExcerptFile = z.infer<typeof sourceExcerptFileSchema>;

export function loadSourceExcerpts(area: string, name: string): SourceExcerptFile {
  const file = sourceExcerptFileSchema.parse(
    JSON.parse(readFileSync(goldenPath(area, name), 'utf8')),
  );
  for (const [key, excerpt] of Object.entries(file.excerpts))
    if (createHash('sha256').update(excerpt.text).digest('hex') !== excerpt.sha256)
      throw new Error(`Source excerpt ${area}/${name}#${key} does not match its recorded hash.`);
  return file;
}

export function sourceExcerpt(area: string, name: string, key: string): string {
  const excerpt = loadSourceExcerpts(area, name).excerpts[key];
  if (!excerpt) throw new Error(`Source excerpt ${area}/${name}#${key} is not captured.`);
  return excerpt.text;
}
