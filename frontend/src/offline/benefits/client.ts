import { z } from 'zod';
import { post, request } from '../../api/client';
import {
  walletAdjustmentReceiptSchema,
  walletCustomerSchema,
  type WalletAdjustmentInput,
} from './contracts';
export const readWalletCapabilities = (operatorId: string) =>
  request(
    '/api/v1/wallet-adjustment-capabilities',
    { operatorId },
    z.object({
      enabled: z.boolean(),
      contract: z.literal('pos-global-wallet-adjustment-v1'),
      patchHash: z.literal('800758e0763efddfe1cacdc5a9a55022d3209a9bdbb1599f76a5b86f24e30730'),
    }),
  );
export const lookupWalletCustomer = (operatorId: string, email: string) =>
  post('/api/v1/benefit-customer-lookups', { email }, walletCustomerSchema, operatorId);
export const readWalletAdjustment = (operatorId: string, operationId: string) =>
  request(
    '/api/v1/wallet-adjustments/' + encodeURIComponent(operationId),
    { operatorId },
    walletAdjustmentReceiptSchema,
  );
export const sendWalletAdjustment = (operatorId: string, input: WalletAdjustmentInput) =>
  post('/api/v1/wallet-adjustments', input, walletAdjustmentReceiptSchema, operatorId);
