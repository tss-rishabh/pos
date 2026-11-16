import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/api/client';
import { sendFulfillmentCommand } from '../../src/pages/fulfillment/commands';
const store = () => {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) || null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    map,
  };
};
describe('durable fulfillment commands', () => {
  it('uses the exact same command after a timeout and refuses to mutate its reason', async () => {
    const storage = store(),
      ids: string[] = [],
      input = { orderId: '1001', path: 'rejection', rejectionReasonId: '1' };
    await expect(
      sendFulfillmentCommand('10', '1', input, storage, async (id) => {
        ids.push(id);
        throw new Error('response lost');
      }),
    ).rejects.toThrow('response lost');
    await expect(
      sendFulfillmentCommand('10', '1', { ...input, rejectionReasonId: '2' }, storage, async () => {
        throw new Error('must not send');
      }),
    ).rejects.toThrow('confirmation');
    const result = await sendFulfillmentCommand('10', '1', input, storage, async (id) => {
      ids.push(id);
      return {
        commandId: id,
        updatedCount: 2,
        integrationState: 'pending',
        effectIds: ['fixture'],
      };
    });
    expect(ids[1]).toBe(ids[0]);
    expect(result.integrationState).toBe('pending');
    expect(storage.map.size).toBe(0);
  });
  it('separates operators and clears commands rejected before execution', async () => {
    const storage = store(),
      input = { orderId: '1001', path: 'acceptance' };
    await expect(
      sendFulfillmentCommand('10', '1', input, storage, async () => {
        throw new Error('response lost');
      }),
    ).rejects.toThrow();
    await expect(
      sendFulfillmentCommand('11', '1', input, storage, async () => {
        throw new ApiError(403, 'FORBIDDEN', 'Denied');
      }),
    ).rejects.toThrow('Denied');
    expect(storage.map.size).toBe(1);
    expect([...storage.map.keys()][0]).toContain(':10:');
  });
});
