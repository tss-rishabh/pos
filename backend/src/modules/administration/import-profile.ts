import type { z } from 'zod';
import type { Principal, Role } from '../../domain/access.js';
import type { AdministrationTransaction } from './checkins.js';
import type { StockImportCommand, StockImportCells } from './import-schema.js';
import type {
  ParentStoreImportCommand,
  ParentStoreImportCells,
} from './parent-store-imports/types.js';
import type { InventoryImportHistory } from './import-history.js';

export type ImportCommand = StockImportCommand | ParentStoreImportCommand;
export type ImportCells = StockImportCells | ParentStoreImportCells;
export interface QueueImportRow {
  rowNumber: number;
  cells: ImportCells;
  command: ImportCommand | null;
  errorCode: string | null;
  message: string | null;
}
export interface ImportPreviewRow extends QueueImportRow {
  saleableStock: number | null;
  heldStock: number | null;
}
export interface ImportActor {
  role: Role;
  allActors: boolean;
}
/** Only trusted module constructors provide profiles; never a request-body option. */
export interface InventoryImportProfile {
  kind: 'parent-store';
  authorize(user: Principal): void;
  currentActor(tx: AdministrationTransaction, id: string): Promise<ImportActor>;
  parse(csv: string): QueueImportRow[];
  inspect(user: Principal, rows: QueueImportRow[]): Promise<ImportPreviewRow[]>;
  command: z.ZodType<ImportCommand>;
  cells: z.ZodType<ImportCells>;
  headers: readonly string[];
  needsStock(command: ImportCommand): boolean;
  apply(
    tx: AdministrationTransaction,
    context: { actorId: string; requestId: string | null; importId: string; rowNumber: number },
    command: ImportCommand,
  ): Promise<void>;
  failureMessages: Readonly<Record<string, string>>;
  isBlockedCode(code: string): boolean;
  successMessage: string;
  history: InventoryImportHistory;
  finalize?(
    tx: AdministrationTransaction,
    context: { importId: string; actorId: string; requestId: string | null; processedRows: number },
  ): Promise<void>;
}
