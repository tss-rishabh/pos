import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { sendFulfillmentCommand } from '../../src/pages/fulfillment/commands';

describe('fulfillment actions', () => {
  it('posts each legacy action once to its store/order path with only the rejection reason', async () => {
    const sent: { path: string; method?: string; operatorId?: string; body?: unknown }[] = [];
    const send = async <T>(
      path: string,
      options: { method?: string; operatorId?: string; body?: BodyInit | null } = {},
      schema?: z.ZodType<T>,
    ): Promise<T> => {
      sent.push({
        path,
        method: options.method,
        operatorId: options.operatorId,
        body: JSON.parse(String(options.body)) as unknown,
      });
      return schema!.parse({ message: 'Success', updatedCount: 2 });
    };
    await expect(
      sendFulfillmentCommand(
        '10',
        { storeId: '1', orderId: '1001', action: 'rejection', rejectionReasonId: '3' },
        send,
      ),
    ).resolves.toEqual({ message: 'Success', updatedCount: 2 });
    await sendFulfillmentCommand('10', { storeId: '1', orderId: '1001', action: 'packing' }, send);
    expect(sent).toEqual([
      {
        path: '/api/v1/stores/1/fulfillment/orders/1001/rejection',
        method: 'POST',
        operatorId: '10',
        body: { rejectionReasonId: '3' },
      },
      {
        path: '/api/v1/stores/1/fulfillment/orders/1001/packing',
        method: 'POST',
        operatorId: '10',
        body: {},
      },
    ]);
  });
});
