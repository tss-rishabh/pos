/** Keep each independent Docker context self-contained with identical reviewed bytes. */
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, '../../../frontend/tools/dependency-security');
const flags = process.argv.slice(2);
assert(flags.length <= 1 && flags.every((flag) => flag === '--write'));
const names = ['manifest.json', 'picomatch-4.0.7-pos-review.tgz', 'LICENSE.picomatch', 'verify.mjs'];
if (flags[0] === '--write') mkdirSync(target, { recursive: true });
for (const name of names) {
  if (flags[0] === '--write') copyFileSync(join(here, name), join(target, name));
  assert(readFileSync(join(here, name)).equals(readFileSync(join(target, name))), 'Mitigation mirrors differ');
}
process.stdout.write(JSON.stringify({ mirrorsEqual: true, files: names.length }) + '\n');
