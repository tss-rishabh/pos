import { statSync } from 'node:fs';
import { resolve } from 'node:path';

/** Forward only the local reviewed artifact location, never service credentials.
 * Individual source consumers still enforce their original byte/commit pins. */
export function pinnedSourceEnvironment(): NodeJS.ProcessEnv {
  const source = process.env.POS_LEGACY_IMPORT_SOURCE_ROOT;
  if (!source) return {};
  const directory = resolve(source);
  if (!statSync(directory).isDirectory())
    throw new Error('The pinned source fixture directory is unavailable.');
  return { POS_LEGACY_IMPORT_SOURCE_ROOT: directory };
}
