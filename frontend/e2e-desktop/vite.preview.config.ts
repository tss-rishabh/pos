import { mergeConfig } from 'vite';
import base from '../vite.config';
import { desktopPorts } from './ports';

// The production preview config, with /api and /health proxied to the desktop stack's backend gate.
const backend = `http://127.0.0.1:${desktopPorts.backend}`;
export default mergeConfig(base, {
  preview: { proxy: { '/api': { target: backend, ws: true }, '/health': backend } },
});
