// @ts-check
// Sandboxed preload: exposes only the allowlisted offline billing channels and the ID-only
// UI error report channel (the same set as `ipcChannels` in src/offline/billing/contracts.ts).
// No Node API, key material or raw ipcRenderer reaches the renderer; the main
// process validates every payload and the sender origin.
const { contextBridge, ipcRenderer } = require('electron');

// Must equal ipcChannels in src/offline/billing/contracts.ts (a sandboxed preload cannot import
// it); tests/offline-billing/preload-channels.test.ts fails when the two differ.
const channels = new Set([
  'offline:status',
  'offline:catalog:search',
  'offline:catalog:barcode',
  'offline:catalog:refresh',
  'offline:salespeople:list',
  'offline:sale:create',
  'offline:sale:list',
  'offline:sale:reprint',
  'offline:sync:retry',
  'offline:conflict:resolve',
  'diagnostics:ui-error',
]);
// Push event, outside the invoke namespace: offlineStatusEvent in contracts.ts.
const STATUS_EVENT = 'offline-billing-event:status-changed';

contextBridge.exposeInMainWorld(
  'souledOfflineBilling',
  Object.freeze({
    version: 1,
    /**
     * @param {unknown} channel
     * @param {unknown} payload
     * @returns {Promise<unknown>}
     */
    invoke(channel, payload) {
      if (typeof channel !== 'string' || !channels.has(channel))
        return Promise.reject(new Error('Unknown offline billing channel.'));
      return ipcRenderer.invoke(channel, { requestId: globalThis.crypto.randomUUID(), payload });
    },
    /**
     * @param {unknown} listener
     * @returns {() => void}
     */
    onStatusChanged(listener) {
      if (typeof listener !== 'function') return () => {};
      const forward = () => listener();
      ipcRenderer.on(STATUS_EVENT, forward);
      return () => ipcRenderer.removeListener(STATUS_EVENT, forward);
    },
  }),
);
