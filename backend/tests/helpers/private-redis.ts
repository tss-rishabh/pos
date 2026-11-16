import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, createConnection } from 'node:net';
import { setTimeout } from 'node:timers/promises';

/** Own a separate loopback Redis process. Never reuse or flush a developer's Redis. */
export async function privateRedisFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'pos-handoff-redis-')),
    server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Fixture port unavailable'));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
  const child: ChildProcess = spawn(
    'redis-server',
    [
      '--bind',
      '127.0.0.1',
      '--protected-mode',
      'yes',
      '--port',
      String(port),
      '--save',
      '',
      '--appendonly',
      'no',
      '--dir',
      directory,
      '--logfile',
      join(directory, 'redis.log'),
    ],
    { stdio: 'ignore' },
  );
  let stopped = false,
    startupError = false;
  child.once('error', () => {
    startupError = true;
  });
  async function close() {
    if (stopped) return;
    stopped = true;
    if (child.exitCode === null && !startupError) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      const timer = globalThis.setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 2000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    if (startupError || child.exitCode !== null) {
      await close();
      throw new Error('Private Redis fixture could not start.');
    }
    const connected = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (connected) return { url: `redis://127.0.0.1:${port}/0`, close };
    await setTimeout(25);
  }
  await close();
  throw new Error('Private Redis fixture timed out.');
}
