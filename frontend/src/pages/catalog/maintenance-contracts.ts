import { z } from 'zod';
export const maintenanceCapabilities = z.object({
  inventoryPullEnabled: z.boolean(),
  troubleshootingEnabled: z.boolean(),
});
/** `InventorySyncView` outcome (core/views.py:1564-1620). */
export const inventoryPullResult = z.object({
  status: z.literal('success'),
  message: z.string(),
  productIds: z.array(z.string()),
});
/** `AjaxTroubleshootProductView` constant answer (core/views.py:3027-3030). */
export const troubleshootResult = z.object({ status: z.literal(200), message: z.string() });
export type InventoryPullInput =
  { mode: 'manual'; skus: string } | { mode: 'csv'; filename: string; csv: string };
