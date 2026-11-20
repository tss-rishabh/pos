import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { ipcChannels, offlineStatusEvent } from '../../src/offline/billing/contracts';

/**
 * The sandboxed preload cannot import contracts.ts, so it repeats the invoke channel allowlist and
 * the push event name. Both are read from the preload source (not a list copied into this test),
 * so a channel added to both files, or removed from both, keeps this test green; a channel in
 * only one of them fails it.
 */
const source = readFileSync(
  fileURLToPath(new URL('../../electron/preload.cjs', import.meta.url)),
  'utf8',
);

function preloadLiterals() {
  const file = ts.createSourceFile('preload.cjs', source, ts.ScriptTarget.ES2022, true);
  let channels: string[] | null = null;
  let statusEvent: string | null = null;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = node.initializer;
      if (
        node.name.text === 'channels' &&
        ts.isNewExpression(init) &&
        ts.isIdentifier(init.expression) &&
        init.expression.text === 'Set' &&
        init.arguments?.length === 1 &&
        ts.isArrayLiteralExpression(init.arguments[0]!)
      )
        channels = init.arguments[0].elements.map((element) => {
          if (!ts.isStringLiteral(element)) throw new Error('Preload channels must be literals.');
          return element.text;
        });
      if (node.name.text === 'STATUS_EVENT' && ts.isStringLiteral(init)) statusEvent = init.text;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!channels || !statusEvent) throw new Error('The preload channel list was not found.');
  return { channels: channels as string[], statusEvent: statusEvent as string };
}

interface ExposedBridge {
  version: number;
  invoke(channel: unknown, payload: unknown): Promise<unknown>;
  onStatusChanged(listener: unknown): () => void;
}
/** Run the real preload with a fake Electron and capture what it exposes and sends. */
function loadPreload() {
  const invoked: string[] = [];
  const listening = new Map<string, number>();
  let exposed: { name: string; api: ExposedBridge } | null = null;
  const electron = {
    contextBridge: {
      exposeInMainWorld(name: string, api: ExposedBridge) {
        exposed = { name, api };
      },
    },
    ipcRenderer: {
      invoke(channel: string) {
        invoked.push(channel);
        return Promise.resolve({ ok: true });
      },
      on(channel: string) {
        listening.set(channel, (listening.get(channel) ?? 0) + 1);
      },
      removeListener(channel: string) {
        listening.set(channel, (listening.get(channel) ?? 0) - 1);
      },
    },
  };
  runInNewContext(source, {
    require: (name: string) => {
      if (name !== 'electron') throw new Error(`The preload may not require ${name}.`);
      return electron;
    },
    crypto: { randomUUID: () => '6f1c1d3e-2f0a-4b8e-9c55-3a1d2b4c5e6f' },
  });
  if (!exposed) throw new Error('The preload exposed nothing.');
  return { exposed: exposed as { name: string; api: ExposedBridge }, invoked, listening };
}

describe('desktop preload allowlist', () => {
  it('allows exactly the invoke channels the main process registers', () => {
    const { channels } = preloadLiterals();
    expect(new Set(channels).size).toBe(channels.length);
    expect([...channels].sort()).toEqual([...ipcChannels].sort());
  });

  it('uses the shared push event, outside the invoke namespace', () => {
    const { statusEvent } = preloadLiterals();
    expect(statusEvent).toBe(offlineStatusEvent);
    expect(statusEvent.startsWith('offline:')).toBe(false);
    expect(ipcChannels).not.toContain(statusEvent);
  });

  it('forwards every allowlisted channel and refuses anything else', async () => {
    const { exposed, invoked, listening } = loadPreload();
    expect(exposed.name).toBe('souledOfflineBilling');
    for (const channel of ipcChannels) await exposed.api.invoke(channel, {});
    expect(invoked).toEqual([...ipcChannels]);
    for (const channel of ['offline:sync:status', offlineStatusEvent, 'offline:status:changed', 7])
      await expect(exposed.api.invoke(channel, {})).rejects.toThrow(
        'Unknown offline billing channel.',
      );
    expect(invoked).toHaveLength(ipcChannels.length);
    const stop = exposed.api.onStatusChanged(() => undefined);
    expect(listening.get(offlineStatusEvent)).toBe(1);
    stop();
    expect(listening.get(offlineStatusEvent)).toBe(0);
  });
});
