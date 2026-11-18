/** Phase D2: the IndexedDB offline cash flow is retired in favour of desktop
 * offline billing (encrypted SQLite in the Electron main process, see
 * frontend/electron/offline). New offline cash authorizations and completions
 * are refused here; saved records stay readable until W2 deletes the module.
 * The previous application-shell readiness check is in git history. */
export async function requireOfflineCashShell(
  signal: AbortSignal,
  _assets: readonly string[] = [],
): Promise<void> {
  signal.throwIfAborted();
  throw new Error(
    'Offline cash has moved to Offline billing in the Souled POS desktop app. Open Offline billing to bill during an outage.',
  );
}
