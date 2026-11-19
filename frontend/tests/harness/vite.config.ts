import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { harnessPorts } from './ports';

/**
 * `vite preview` of the built app (frontend/dist) for the harness stack only. It proxies to the
 * harness backend port, so a Playwright suite or another agent's stack on 4410/4173 cannot
 * collide with, or be mistaken for, the harness stack.
 */
const backend = `http://127.0.0.1:${harnessPorts.backend}`;
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  preview: {
    host: '127.0.0.1',
    port: harnessPorts.web,
    strictPort: true,
    proxy: { '/api': { target: backend, ws: true }, '/health': backend },
  },
});
