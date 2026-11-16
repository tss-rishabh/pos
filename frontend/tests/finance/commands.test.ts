import { describe, expect, it } from 'vitest';
import { submitClose } from '../../src/pages/finance/commands';
import {
  cents,
  decimal,
  differences,
  type CloseState,
  type Entries,
} from '../../src/pages/finance/model';
const entries: Entries = {
  cash_actual: '95.10',
  cash_manual_punched: '0',
  cash_manual_created: '0',
  card_actual: '35.20',
  card_manual_punched: '0',
  card_manual_created: '0',
  banking_amount: '40',
  cash_reason: '',
  card_reason: '',
  cash_comment: '',
  card_comment: '',
};
const state: CloseState = {
  store_id: '1',
  close_date: '2026-11-16',
  window: {
    state: 'OPEN',
    allowed: true,
    override: null,
    message: '',
    opens_at: '2026-11-16 22:00',
    closes_at: '2026-11-17 21:00',
  },
  system: {
    cash: '100.10',
    cash_refund: '5.00',
    card_upi: '25.10',
    total_online: '35.20',
    district: '30.00',
    online_other: '10.10',
    total_collection: '165.30',
    order_count: 2,
  },
  close: null,
  tolerance: '0.00',
};
describe('finance command durability and exact amount preview', () => {
  it('does integer decimal arithmetic without binary-float drift', () => {
    expect(differences(state, entries)).toEqual({ cash: 0n, card: 0n });
    expect(cents('999999999999.99')).toBe(99999999999999n);
    expect(decimal(-12345n)).toBe('-123.45');
    expect(cents('-0.01')).toBe(-1n);
  });
  it('keeps only a digest and stable command ID after uncertainty, and rejects changed figures', async () => {
    const map = new Map<string, string>(),
      storage = {
        getItem: (key: string) => map.get(key) || null,
        setItem: (key: string, value: string) => {
          map.set(key, value);
        },
        removeItem: (key: string) => {
          map.delete(key);
        },
      };
    const ids: string[] = [],
      withComment = { ...entries, cash_comment: 'Private fixture comment' };
    const send = async (command: { commandId: string }) => {
      ids.push(command.commandId);
      throw new Error('response lost');
    };
    await expect(
      submitClose('10', '1', state.close_date, 0, withComment, storage, send),
    ).rejects.toThrow('response lost');
    const persisted = [...map.values()][0]!;
    expect(persisted).not.toContain('Private fixture comment');
    expect(persisted).not.toContain('95.10');
    await expect(
      submitClose(
        '10',
        '1',
        state.close_date,
        0,
        { ...withComment, banking_amount: '41' },
        storage,
        send,
      ),
    ).rejects.toThrow('awaiting confirmation');
    expect(ids).toHaveLength(1);
    await expect(
      submitClose('10', '1', state.close_date, 0, withComment, storage, send),
    ).rejects.toThrow('response lost');
    expect(ids[1]).toBe(ids[0]);
  });
});
