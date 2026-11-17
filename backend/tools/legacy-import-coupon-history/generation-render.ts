/** Offline deployment artifact renderer. Does no connection/credential work and
 * never applies SQL. Root owns actual migration registry and deployment review. */
import { generationJournalDdl } from '../../src/modules/legacy-order-imports/benefit-profile/history-generation-journal.js';
if (process.argv.length !== 3 || process.argv[2] !== '--journal-sql')
  throw Error('RENDER_ONLY_ARGUMENT_REQUIRED');
process.stdout.write('-- REVIEW ONLY; no SQL was executed.\n' + generationJournalDdl + ';\n');
