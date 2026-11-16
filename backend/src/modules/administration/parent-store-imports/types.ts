export interface ParentStoreImportCommand {
  kind: 'parent-store';
  productId: string;
  storeId: string;
  active: boolean;
}
export type ParentStoreImportCells = [string, string, string];
