import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const fixtures = {
  'cash-manager': new URL('../tests/checkout-manager/browser-check.mjs', import.meta.url),
  'shipping-label': new URL('../tests/shipping-label/browser-check.mjs', import.meta.url),
  'invoice-documents': new URL('../tests/invoice-documents/browser-check.mjs', import.meta.url),
  'legacy-delivery': new URL('../tests/legacy-fulfillment/browser-check.mjs', import.meta.url),
  'legacy-delivery-lifecycle': new URL(
    '../tests/legacy-fulfillment/lifecycle-browser-check.mjs',
    import.meta.url,
  ),
};
const selected = process.argv[2];
if (process.argv.length !== 3 || !Object.hasOwn(fixtures, selected)) {
  process.stderr.write('Select a registered isolated browser fixture.\n');
  process.exitCode = 1;
} else {
  const server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('..', import.meta.url)),
    plugins: [react()],
    logLevel: 'silent',
    // No API proxy or inherited project server options: every service request
    // must be fulfilled or blocked by the synthetic browser fixture.
    server: { host: '127.0.0.1', port: 4490, strictPort: true, hmr: false },
  });
  try {
    await server.listen();
    if (selected === 'invoice-documents')
      process.env.POS_INVOICE_BROWSER_BASE_URL = 'http://127.0.0.1:4490';
    await import(fixtures[selected].href);
  } finally {
    await server.close();
  }
}
