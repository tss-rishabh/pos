// Wire contracts mirrored from backend/src/domain/contracts.ts; contract tests check shapes.
export interface Principal {
  userType:1|2;
  id: string;
  name: string;
  email: string;
  role: 1 | 2 | 3 | 4 | 5;
  storeIds: string[];
}
export interface Store {
  id: string;
  name: string;
  locationCode: string;
  city: string;
  active: boolean;
}
export interface Counter {
  id: string;
  storeId: string;
  name: string;
}
export interface Product {
  id: string;
  name: string;
  erpName: string;
  barcode: string | null;
  parentId: string;
  type: string;
  price: string;
  specialPrice: string;
  exclusivePrice: string | null;
  stock: number;
  gst: number;
  image: string | null;
}
export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}
export interface Order {
  id: string;
  reference: string;
  storeId: string;
  customer: string;
  amount: string;
  status: string;
  paymentStatus: string;
  createdAt: string;
}
export interface DraftLine {
  productId: string;
  name: string;
  barcode: string | null;
  unitPrice: string;
  quantity: number;
}
export interface Draft {
  id: string;
  storeId: string;
  counterId: string;
  customerId: string | null;
  lines: DraftLine[];
  version: number;
}
export interface DraftMutation {
  mutationId: string;
  expectedVersion: number;
  draft: Omit<Draft, 'version'>;
}
