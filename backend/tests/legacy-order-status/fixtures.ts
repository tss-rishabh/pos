import { readConfig } from '../../src/config.js';
import { readWholeOrderStatusOptions } from '../../src/modules/legacy-order-status/options.js';
export const config = readConfig({
  NODE_ENV: 'test',
  SESSION_SECRET: 'synthetic-status-session-key-'.repeat(2),
  MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
  MYSQL_PRIMARY_READER_URL: 'mysql://root@127.0.0.1/pos_rewrite_whole_status_test',
  MYSQL_WRITER_URL: 'mysql://root@127.0.0.1/pos_rewrite_whole_status_test',
});
export const options = readWholeOrderStatusOptions({
  BACKEND_SYNC_API_BASE_URL: 'https://sync.synthetic.invalid/api/',
  BACKEND_SYNC_REPO_API_KEY: 'synthetic-private-sync-key',
});
/** Same synthetic order and lines as the captured pinned-source golden input. */
export const snapshot = {
  orderId: '9007199254740993',
  lines: [
    { id: '9007199254741001', productId: '501', subProductId: '0', quantity: '3' },
    { id: '9007199254741002', productId: '501', subProductId: '0', quantity: '1' },
    { id: '9007199254741003', productId: '999', subProductId: '0', quantity: '0' },
  ],
};
export const lineIds = snapshot.lines.map((row) => row.id);
