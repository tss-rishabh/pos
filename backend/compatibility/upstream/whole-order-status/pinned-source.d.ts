import type { StatusPlatform } from '../../../src/modules/legacy-order-status/domain.js';
export interface SourceTaskLogger {
  info(...values: unknown[]): void;
  warn(...values: unknown[]): void;
  error(...values: unknown[]): void;
  debug(...values: unknown[]): void;
}
export interface SourceVendorResponse {
  responseCode: number;
  responseMessage: string;
}
export interface SourceQueueMessage {
  orderId: string;
  hasProductIds: string[];
  platform: StatusPlatform;
  source?: 'STORE' | 'MEMBERSHIP';
  force?: boolean;
}
export interface SourceNetcoreProduct {
  userId: unknown;
  prodId: unknown;
  parentProdId: unknown;
  qty: number;
  urlKey: string | null;
  price: number;
  genderType: number | null;
}
export interface SourceStorePorts {
  config: {
    sqs: {
      storeOrderQueueUrl: string;
      slackWebhookUrl: string;
      storeOrderInitialDelaySeconds: Record<StatusPlatform, number>;
      membershipOrderInitialDelaySeconds: Record<StatusPlatform, number>;
      storeOrderRetryDelaySeconds: Record<StatusPlatform, number>;
      membershipOrderRetryDelaySeconds: Record<StatusPlatform, number>;
    };
    vinculum: {
      orderShippedUrl: string;
      orderDeliveredUrl: string;
      rateLimits: Record<StatusPlatform, { maxRequests: number; windowMs: number }>;
    };
    events: { baseUrl: string; appId: string; appKey: string };
  };
  getStoreOrderLocationAndRef(
    orderId: string,
  ): Promise<{ orderRefNo: string; locationCode: string }>;
  getProductsForPackShip(
    orderId: string,
    ids: string[],
  ): Promise<{ id: string; productId: string; qty: string }[]>;
  getOrderProductsForNetcore(orderId: string): Promise<SourceNetcoreProduct[]>;
  hasAutoDeliverSuccess(orderId: string, platform: StatusPlatform): Promise<boolean>;
  clearAutoDeliverSuccess(orderId: string, platform: StatusPlatform): Promise<number>;
  executeVinculumJsonRequest(
    body: Record<string, unknown>,
    url: string,
  ): Promise<SourceVendorResponse>;
  upsertAutoDeliverLog(value: {
    orderId: string;
    productId: number;
    hasProductId: string | null;
    platform: StatusPlatform;
    retries: number;
    request: string;
    response: string;
    status: string;
    message: string;
  }): Promise<void>;
  enqueue(queue: string, url: string, message: SourceQueueMessage, delay: number): Promise<string>;
  sendSlackAlert(url: string, message: string): Promise<void>;
  axios: {
    post(
      url: string,
      body: Record<string, unknown>,
      options: { headers: Record<string, string>; timeout: number },
    ): Promise<unknown>;
  };
}
export function createSourceStoreRuntime(ports: SourceStorePorts): {
  process(
    orderId: string,
    ids: string[],
    platform: StatusPlatform,
    logger: SourceTaskLogger,
    receiveCount?: number,
    source?: 'STORE',
    force?: false,
  ): Promise<{
    status: 'ALREADY_SUCCEEDED' | 'SUCCESS' | 'UNEXPECTED';
    response: SourceVendorResponse | null;
  }>;
  packShip(
    orderId: string,
    ids: string[],
    platform: 'PACK' | 'SHIP',
  ): Promise<Record<string, unknown>>;
  deliver(orderId: string): Record<string, unknown>;
  initialDelay(source: 'STORE', platform: StatusPlatform): number;
  retryDelay(source: 'STORE', platform: StatusPlatform): number;
};
