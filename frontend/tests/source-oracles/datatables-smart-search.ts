import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { z } from 'zod';

const fixtureSchema = z
  .object({
    version: z.literal(1),
    sourceCommit: z.literal('78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'),
    sourcePath: z.literal('static/adminlte/plugins/datatables/jquery.dataTables.js'),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    functionsSha256: z.string().regex(/^[a-f0-9]{64}$/),
    regexExpression: z.string().min(1),
    escapeFunction: z.string().min(1),
    createFunction: z.string().min(1),
  })
  .strict();

const fixture = fixtureSchema.parse(
  JSON.parse(readFileSync(new URL('./datatables-smart-search.json', import.meta.url), 'utf8')),
);
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const payload = [fixture.regexExpression, fixture.escapeFunction, fixture.createFunction].join(
  '\n',
);
if (sha256(payload) !== fixture.functionsSha256) {
  throw new Error('The pinned DataTables source fixture checksum changed.');
}

// Native desktop CI checks out the rewrite alone. Full-project parity still
// requires the clean pinned source checkout; when present, verify its bytes too.
const sourceFile = new URL(`../../../../backend-pos-web/${fixture.sourcePath}`, import.meta.url);
if (existsSync(sourceFile)) {
  const source = readFileSync(sourceFile, 'utf8');
  if (
    sha256(source) !== fixture.sourceSha256 ||
    !source.includes(fixture.regexExpression) ||
    !source.includes(fixture.escapeFunction) ||
    !source.includes(fixture.createFunction)
  ) {
    throw new Error('The original DataTables source does not match the pinned fixture.');
  }
}

const create: unknown = runInNewContext(
  `(function(){var _re_escape_regex=${fixture.regexExpression};var _fnEscapeRegex=${fixture.escapeFunction};${fixture.createFunction};return function(query){return _fnFilterCreateSearch(query,false,true,true).source;};})()`,
  { $: { map: (items: string[], map: (value: string) => string) => items.map(map) } },
);
export function sourceSmartSearchPattern(query: string): string {
  if (typeof create !== 'function') {
    throw new Error('The pinned source search function is unavailable.');
  }
  const pattern: unknown = Reflect.apply(create, undefined, [query]);
  if (typeof pattern !== 'string') throw new Error('The source search pattern is unavailable.');
  return pattern;
}
