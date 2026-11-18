import { defineConfig } from 'vite';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

/** Bundle the main-process offline billing module (TypeScript + zod) into one
 * CommonJS file loaded by electron/main.cjs. Only Electron, Node built-ins and
 * the N-API SQLCipher module stay external; the latter ships prebuilt binaries
 * for darwin-arm64/x64 and win32-x64 and is packaged from node_modules. */
export default defineConfig({
  publicDir: false,
  build: {
    target: 'node22',
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    ssr: fileURLToPath(new URL('./offline/index.ts', import.meta.url)),
    rollupOptions: {
      external: [
        'electron',
        'better-sqlite3-multiple-ciphers',
        ...builtinModules,
        ...builtinModules.map((name) => `node:${name}`),
      ],
      output: { format: 'cjs', entryFileNames: 'offline-billing.cjs' },
    },
  },
  ssr: { noExternal: true },
});
