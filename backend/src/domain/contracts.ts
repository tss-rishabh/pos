export interface StoreDto {
  id: string;
  name: string;
  locationCode: string;
  city: string;
  active: boolean;
}
export interface CounterDto {
  id: string;
  storeId: string;
  name: string;
}
export interface ProductDto {
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
export interface OrderDto {
  id: string;
  // orders.order_ref_no is nullable; NULL is serialised as null.
  reference: string | null;
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
