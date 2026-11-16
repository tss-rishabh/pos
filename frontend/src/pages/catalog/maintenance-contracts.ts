import { z } from 'zod';
export const maintenanceKind = z.enum(['inventory-pull', 'product-troubleshoot']);
export const maintenanceState = z.enum(['PENDING', 'RUNNING', 'SUCCEEDED', 'UNCERTAIN', 'FAILED']);
export const maintenanceMetadata = z.object({
  requestedCount: z.number(),
  uniqueRequestedCount: z.number(),
  matchedCount: z.number(),
  mode: z.enum(['manual', 'csv']).optional(),
  productId: z.string().optional(),
  parentRowsChanged: z.number(),
  imageReset: z.boolean(),
  barcodeRowsChanged: z.number(),
});
export const maintenanceReceipt = z.object({
  id: z.uuid(),
  kind: maintenanceKind,
  state: maintenanceState,
  metadata: maintenanceMetadata,
  localApplied: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  errorCode: z.string().nullable(),
  deliveries: z.array(
    z.object({
      id: z.uuid(),
      ordinal: z.number(),
      state: z.enum(['PENDING', 'SENDING', 'DELIVERED', 'UNCERTAIN', 'FAILED']),
      errorCode: z.string().nullable(),
      updatedAt: z.string(),
      productIds: z.array(z.string()),
    }),
  ),
});
export const maintenanceActive = z.object({
  reader: z.literal('primary'),
  data: z.array(maintenanceReceipt.omit({ deliveries: true }).extend({ ownerId: z.string() })),
});
export const maintenanceCapabilities = z.object({
  inventoryPullEnabled: z.boolean(),
  troubleshootingEnabled: z.boolean(),
});
export const repairPlan = z.object({
  productId: z.string(),
  name: z.string(),
  type: z.string(),
  planHash: z.string(),
  parentVisibility: z.array(
    z.object({
      id: z.string(),
      storeId: z.string(),
      availableBefore: z.boolean(),
      listedBefore: z.boolean(),
    }),
  ),
  imageReset: z.boolean(),
  imageProductId: z.string().nullable(),
  barcodeChanges: z.array(
    z.object({ id: z.string(), productId: z.string(), from: z.string(), to: z.string() }),
  ),
  syncProductIds: z.array(z.string()),
});
export type MaintenanceReceipt = z.infer<typeof maintenanceReceipt>;
export type MaintenanceKind = z.infer<typeof maintenanceKind>;
