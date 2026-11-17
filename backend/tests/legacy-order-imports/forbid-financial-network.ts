/** Subprocess fixture: a recovery-only worker may use local SQL, never HTTP. */
globalThis.fetch = async () => {
  process.stderr.write('UNEXPECTED_IMPORT_FINANCIAL_NETWORK\n');
  throw new Error('The recovery worker attempted an HTTP request.');
};
