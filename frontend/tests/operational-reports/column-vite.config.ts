import { mergeConfig } from 'vite';
import base from '../../vite.config.ts';

export default mergeConfig(base, {
  cacheDir: process.env.POS_REPORT_COLUMN_CACHE || `/tmp/pos-report-column-vite-${process.pid}`,
  server: { host: '127.0.0.1', port: 4498, strictPort: true },
});
