import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, type Rollup } from 'vite';
import { it, expect } from 'vitest';
import { offlineShell } from '../vite.config';

function shellVersion(result: Rollup.RollupOutput | Rollup.RollupOutput[] | Rollup.RollupWatcher) {
  const output = Array.isArray(result) ? result[0] : result;
  if (!output || !('output' in output)) throw new Error('Expected a completed fixture build.');
  const worker = output.output.find((asset) => asset.fileName === 'service-worker.js');
  if (!worker || worker.type !== 'asset') throw new Error('Offline worker was not emitted.');
  return String(worker.source).match(/souled-pos-shell-([a-f0-9]+)/)?.[1];
}
it('revisions cached HTML when only security policy or public assets change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pos-offline-shell-')),
    previous = process.env.POS_MEDIA_ORIGINS;
  try {
    await mkdir(join(root, 'public'));
    await writeFile(join(root, 'public', 'manifest.webmanifest'), '{}');
    await writeFile(join(root, 'public', 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await writeFile(
      join(root, 'index.html'),
      '<html><head></head><body><script type="module" src="/main.js"></script></body></html>',
    );
    await writeFile(join(root, 'main.js'), 'document.title="fixture";');
    const render = () =>
      build({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [offlineShell()],
        build: { write: false },
      });
    delete process.env.POS_MEDIA_ORIGINS;
    const original = shellVersion(await render());
    expect(original).toBeTruthy();
    process.env.POS_MEDIA_ORIGINS = 'https://fixture-bucket.s3.ap-south-1.amazonaws.com';
    const updatedPolicy = shellVersion(await render());
    expect(updatedPolicy).not.toBe(original);
    await writeFile(
      join(root, 'public', 'icon.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg"><title>updated</title></svg>',
    );
    expect(shellVersion(await render())).not.toBe(updatedPolicy);
  } finally {
    if (previous === undefined) delete process.env.POS_MEDIA_ORIGINS;
    else process.env.POS_MEDIA_ORIGINS = previous;
    await rm(root, { recursive: true, force: true });
  }
});
