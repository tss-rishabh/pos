/** Status values the sync-repo service accepts (legacy callers pass these literals). */
export type SyncRepoStatus = 'PACK' | 'SHIP' | 'DELIVER' | 'RTO' | (string & {});
export interface SyncRepoStatusApiOptions {
  /** Legacy `BACKEND_SYNC_API_BASE_URL`, trailing `/` stripped (`settings.py:570`). Unset = skip. */
  BACKEND_SYNC_API_BASE_URL?: string | undefined;
  /** Legacy `BACKEND_SYNC_REPO_API_KEY` (`settings.py:571`, default ''). */
  BACKEND_SYNC_REPO_API_KEY?: string | undefined;
}
export type SyncRepoOutcome = 'sent' | 'skipped-unconfigured' | 'failed';
/**
 * Legacy `Helpers.call_status_api` (`helpers/helpers.py:1133-1158`): one fire-once POST of
 * `{orderId, has_product_ids, platform}` with `x-api-key`, timeout 10 s, to
 * `/order/status` (hyperlocal/express line items) or `/store-order/status` (store orders).
 * Never throws: a missing base URL is skipped and any request failure or non-2xx is only
 * reported to `log`, exactly as legacy only logs it. No retry.
 */
export function syncRepoStatusApi(
  options: SyncRepoStatusApiOptions,
  fetcher: typeof fetch = fetch,
  log: (outcome: SyncRepoOutcome, hyperlocal: boolean) => void = () => {},
) {
  return async function callStatusApi(
    orderId: string | bigint,
    lineItemIds: readonly (string | bigint)[],
    status: SyncRepoStatus,
    hyperlocal = false,
  ): Promise<SyncRepoOutcome> {
    const base = (options.BACKEND_SYNC_API_BASE_URL ?? '').replace(/\/+$/, '');
    if (!base) {
      log('skipped-unconfigured', hyperlocal);
      return 'skipped-unconfigured';
    }
    try {
      const response = await fetcher(
        `${base}${hyperlocal ? '/order/status' : '/store-order/status'}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': options.BACKEND_SYNC_REPO_API_KEY ?? '',
          },
          body: JSON.stringify({
            orderId: String(orderId),
            has_product_ids: lineItemIds.map((id) => String(id)),
            platform: status,
          }),
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
        },
      );
      await response.body?.cancel();
      if (!response.ok) {
        log('failed', hyperlocal);
        return 'failed';
      }
      log('sent', hyperlocal);
      return 'sent';
    } catch {
      log('failed', hyperlocal);
      return 'failed';
    }
  };
}
export type CallStatusApi = ReturnType<typeof syncRepoStatusApi>;
