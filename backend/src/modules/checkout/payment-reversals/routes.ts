import type { FastifyInstance } from 'fastify';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';

/**
 * @deprecated Registers nothing. The rewrite correction routes
 * (`/orders/:orderId/payment-reversals`) are deleted; the legacy manual mark-paid/revert
 * view is served by checkout/payments as `POST .../orders/:orderId/payment-status`.
 * The app.ts call remains until the lead removes it.
 */
export function registerPaymentReversals(
  _app: FastifyInstance,
  _config: Config,
  _db: Databases,
  _options: object = {},
): void {}
