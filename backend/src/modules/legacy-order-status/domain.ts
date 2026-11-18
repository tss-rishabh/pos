import { z } from 'zod';
/** The three buttons legacy renders on the "Vinculum Status" tab (`show.html:312-323`). */
export const platform = z.enum(['PACK', 'SHIP', 'DELIVER']);
export type StatusPlatform = z.infer<typeof platform>;
export const statusRequestInput = z.object({ platform }).strict();
/** Legacy success message (`order/views.py:4444`). */
export const queuedMessage = 'Request has been queued for processing';
export interface SourceStatusLog {
  id: string;
  platform: string | null;
  status: string | null;
  updatedAt: string;
}
/**
 * Legacy `ShowOrderDetailsView` (`order/views.py:451-464`): iterate the order's logs in id
 * order, the last row per platform wins; CREATE becomes SUCCESS once PACK succeeded.
 * Legacy keys any platform string into the dict; only the four rendered keys are returned.
 */
export function sourceStatusPresentation(logs: readonly SourceStatusLog[]) {
  const stages: Record<
    'CREATE' | 'PACK' | 'SHIP' | 'DELIVER',
    { status: string | null; date: string }
  > = {
    CREATE: { status: '-', date: '' },
    PACK: { status: '-', date: '' },
    SHIP: { status: '-', date: '' },
    DELIVER: { status: '-', date: '' },
  };
  for (const row of [...logs].sort((a, b) =>
    BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0,
  )) {
    if (
      row.platform === 'CREATE' ||
      row.platform === 'PACK' ||
      row.platform === 'SHIP' ||
      row.platform === 'DELIVER'
    )
      stages[row.platform] = { status: row.status, date: row.updatedAt };
  }
  if (stages.PACK.status === 'SUCCESS') stages.CREATE = { status: 'SUCCESS', date: '' };
  return stages;
}
/** `show.html:304`: the tab shows "Order Is Not Processed Yet" for these labels. */
export const unprocessedLabels = ['Order Placed', 'Cancelled'];
