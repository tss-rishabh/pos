import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger, preview } from 'vite';

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const snapshot = await mkdtemp(join(tmpdir(), 'pos-real-mysql-ui-'));
await cp(join(frontend, 'dist'), snapshot, { recursive: true });
const server = await preview({
  configFile: false, customLogger: createLogger('silent'), root: frontend, build: { outDir: snapshot },
  preview: {
    host: '127.0.0.1', port: 4273, strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:4610', '/health': 'http://127.0.0.1:4610' },
  },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.httpServer.close(); });
process.stdout.write('Real MySQL UI preview: http://localhost:4273\n');
