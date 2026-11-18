import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { extname, resolve, sep } from 'node:path';

/** Genuine HTTP forwarding; never fulfills/replaces application responses. */
export async function nativeUiServer(built: string) {
  let apiOrigin = '';
  const calls: { method: string; path: string; status: number }[] = [];
  const server = createServer((incoming, outgoing) => {
    const url = new URL(incoming.url || '/', 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/health/')) {
      const target = new URL(apiOrigin);
      target.pathname = url.pathname;
      target.search = url.search;
      const proxy = request(
        target,
        { method: incoming.method, headers: incoming.headers },
        (response) => {
          calls.push({
            method: incoming.method || 'GET',
            path: url.pathname,
            status: response.statusCode || 500,
          });
          outgoing.writeHead(response.statusCode || 500, response.headers);
          response.pipe(outgoing);
        },
      );
      proxy.on('error', () => {
        outgoing.writeHead(502);
        outgoing.end();
      });
      incoming.pipe(proxy);
      return;
    }
    let file: string;
    try {
      file = resolve(built, '.' + decodeURIComponent(url.pathname));
    } catch {
      outgoing.writeHead(400);
      outgoing.end();
      return;
    }
    if (file !== built && !file.startsWith(built + sep)) {
      outgoing.writeHead(400);
      outgoing.end();
      return;
    }
    if (!extname(url.pathname) || url.pathname === '/') file = resolve(built, 'index.html');
    if (!existsSync(file)) {
      outgoing.writeHead(404);
      outgoing.end();
      return;
    }
    const mime: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.svg': 'image/svg+xml',
    };
    outgoing.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' });
    outgoing.end(readFileSync(file));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert(address && typeof address === 'object');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    calls,
    attach: (value: string) => {
      assert(new URL(value).hostname === '127.0.0.1');
      apiOrigin = value;
    },
    close: () =>
      new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      ),
  };
}
