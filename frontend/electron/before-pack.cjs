const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { workspaceFromEnvironment } = require('./workspace-config.cjs');
const builds = new WeakMap();

/** electron-builder beforePack: write validated public deployment settings
 * before ASAR collection/signing. Restore the source tree when all targets
 * finish, including failures; architecture builds share one immutable config. */
module.exports = async function beforePack(context) {
  const packager = context?.packager?.info;
  if (
    !packager ||
    typeof packager.appDir !== 'string' ||
    !path.isAbsolute(packager.appDir) ||
    typeof packager.disposeOnBuildFinish !== 'function'
  )
    throw new Error('Desktop workspace packaging is not configured.');
  // Build artifacts always require HTTPS; the runtime's explicit development
  // loopback override remains separate from a distributable deployment config.
  const bytes = Buffer.from(JSON.stringify(workspaceFromEnvironment(process.env)) + '\n');
  if (bytes.length > 16384) throw new Error('Desktop workspace packaging is not configured.');
  const prior = builds.get(packager);
  if (prior) {
    if (!prior.bytes.equals(bytes))
      throw new Error('Desktop workspace configuration changed during packaging.');
    return prior.ready;
  }
  const owned = { bytes, ready: null };
  builds.set(packager, owned);
  owned.ready = prepare(packager, bytes);
  return owned.ready;
};

async function prepare(packager, bytes) {
  const filename = path.join(packager.appDir, 'electron', 'workspace.json');
  let previous = null;
  try {
    const stat = await fs.stat(filename);
    if (!stat.isFile() || stat.size > 16384)
      throw new Error('Desktop workspace packaging is unavailable.');
    previous = await fs.readFile(filename);
    if (previous.length > 16384) throw new Error('Desktop workspace packaging is unavailable.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Desktop workspace packaging is unavailable.');
  }
  const temporary = filename + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, filename);
  } catch {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw new Error('Desktop workspace packaging is unavailable.');
  }
  packager.disposeOnBuildFinish(async () => {
    try {
      const current = await fs.readFile(filename);
      if (!current.equals(bytes)) return; // Preserve any independent edit.
      if (previous === null) await fs.rm(filename);
      else await fs.writeFile(filename, previous);
    } catch (error) {
      if (error.code !== 'ENOENT')
        throw new Error('Desktop workspace packaging cleanup is unavailable.');
    } finally {
      builds.delete(packager);
    }
  });
}
