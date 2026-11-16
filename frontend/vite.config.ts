import { defineConfig, type Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import react from '@vitejs/plugin-react';

export function offlineShell(): Plugin {
  const mediaOrigins = [
    ...new Set(
      (process.env.POS_MEDIA_ORIGINS || '')
        .split(',')
        .filter(Boolean)
        .map((value) => {
          const url = new URL(value.trim());
          if (
            url.protocol !== 'https:' ||
            url.username ||
            url.password ||
            url.pathname !== '/' ||
            url.search ||
            url.hash
          )
            throw new Error('POS_MEDIA_ORIGINS must contain explicit HTTPS origins only.');
          return url.origin;
        }),
    ),
  ].join(' ');
  const policy = `default-src 'self';script-src 'self';style-src 'self';connect-src 'self' ${mediaOrigins};img-src 'self' https://prod-img.thesouledstore.com data: blob: ${mediaOrigins};media-src 'self' blob: ${mediaOrigins};font-src 'self';worker-src 'self';manifest-src 'self';object-src 'none';base-uri 'self';form-action 'self';frame-src 'self'`;
  let publicDir = '';
  return {
    name: 'offline-app-shell',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      publicDir = config.publicDir;
    },
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: {
          'http-equiv': 'Content-Security-Policy',
          content: policy,
        },
        injectTo: 'head',
      },
    ],
    generateBundle(_options, bundle) {
      const files = [
        '/',
        '/index.html',
        '/manifest.webmanifest',
        '/icon.svg',
        ...Object.keys(bundle)
          .filter((name) => name.startsWith('assets/') && !name.endsWith('.map'))
          .map((name) => '/' + name),
      ];
      const revision = createHash('sha256').update(files.join(',')).update(policy);
      for (const [name, item] of Object.entries(bundle).sort(([one], [two]) =>
        one < two ? -1 : one > two ? 1 : 0,
      ))
        revision
          .update(name)
          .update('\0')
          .update(item.type === 'chunk' ? item.code : item.source)
          .update('\0');
      for (const name of ['manifest.webmanifest', 'icon.svg'])
        revision.update(readFileSync(join(publicDir, name)));
      const version = revision.digest('hex').slice(0, 12);
      const source = `const CACHE='souled-pos-shell-${version}';const ASSETS=${JSON.stringify(files)};
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS))));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('souled-pos-shell-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{const url=new URL(event.request.url);if(event.request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/')||url.pathname.startsWith('/health/'))return;if(event.request.mode==='navigate'){event.respondWith(fetch(event.request).catch(()=>caches.match('/index.html',{ignoreVary:true})));return;}if(ASSETS.includes(url.pathname))event.respondWith(caches.match(url.pathname,{ignoreVary:true}).then(cached=>cached||fetch(event.request)));});`;
      this.emitFile({ type: 'asset', fileName: 'service-worker.js', source });
    },
  };
}
export default defineConfig({
  plugins: [react(), offlineShell()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4410', ws: true },
      '/health': 'http://127.0.0.1:4410',
    },
  },
  preview: {
    port: 4173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4410', ws: true },
      '/health': 'http://127.0.0.1:4410',
    },
  },
  build: {
    target: 'es2023',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: (id) =>
          id.includes('node_modules/react')
            ? 'react'
            : id.includes('node_modules')
              ? 'vendor'
              : undefined,
      },
    },
  },
});
