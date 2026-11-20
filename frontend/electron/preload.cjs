// Sandboxed preload: exposes only the allowlisted offline billing channels and the ID-only
// UI error report channel (the same set as `ipcChannels` in src/offline/billing/contracts.ts).
// No Node API, key material or raw ipcRenderer reaches the renderer; the main
// process validates every payload and the sender origin.
const { contextBridge, ipcRenderer } = require('electron');

const channels = new Set([
  'offline:status',
  'offline:catalog:search',
  'offline:catalog:barcode',
  'offline:catalog:refresh',
  'offline:salespeople:list',
  'offline:sale:create',
  'offline:sale:list',
  'offline:sale:reprint',
  'offline:sync:status',
  'offline:sync:retry',
  'offline:conflict:resolve',
  'diagnostics:ui-error',
]);
const STATUS_EVENT = 'offline:status:changed';

contextBridge.exposeInMainWorld(
  'souledOfflineBilling',
  Object.freeze({
    version: 1,
    invoke(channel, payload) {
      if (typeof channel !== 'string' || !channels.has(channel))
        return Promise.reject(new Error('Unknown offline billing channel.'));
      return ipcRenderer.invoke(channel, { requestId: globalThis.crypto.randomUUID(), payload });
    },
    onStatusChanged(listener) {
      if (typeof listener !== 'function') return () => {};
      const forward = () => listener();
      ipcRenderer.on(STATUS_EVENT, forward);
      return () => ipcRenderer.removeListener(STATUS_EVENT, forward);
    },
  }),
);
