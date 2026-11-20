import { describe, expect, it } from 'vitest';
import {
  importProgressJournalKey,
  importProgressKey,
  initialProgress,
  replayImportJournal,
  type ImportJournalEntry,
} from '../../src/modules/administration/import-domain.js';
import { insertBatches } from '../../src/modules/administration/service.js';

const entry = (record: number, extra: Partial<ImportJournalEntry> & { extra?: boolean } = {}) =>
  JSON.stringify({ record, failed: [], productId: null, inserts: [], ...extra });
/** LRANGE 0 -1 of an LPUSH list: newest first. */
const journal = (...entries: string[]) => [...entries].reverse();

describe('inventory import progress journal', () => {
  it('keeps the snapshot key and derives the journal key from it', () => {
    expect(importProgressKey('7')).toBe('pos:import_progress:7');
    expect(importProgressJournalKey('7')).toBe('pos:import_progress:7:journal');
  });

  it('folds journal entries after the snapshot, in record order, with repeats', () => {
    const progress = replayImportJournal(
      { record: 1, failed: [], productIds: ['11'], inserts: [] },
      journal(
        entry(2, { productId: '11' }),
        entry(3, {
          failed: [{ data: { SkuId: 'x' }, message: 'Required parameters are missing.' }],
        }),
        entry(4, { productId: '12', inserts: [['1', '12']] }),
      ),
    );
    expect(progress).toEqual({
      record: 4,
      failed: [{ data: { SkuId: 'x' }, message: 'Required parameters are missing.' }],
      productIds: ['11', '11', '12'],
      inserts: [['1', '12']],
    });
  });

  it('skips entries a checkpoint already folded in (journal reset interrupted)', () => {
    const progress = replayImportJournal(
      { record: 2, failed: [], productIds: ['11', '12'], inserts: [] },
      journal(entry(1, { productId: '11' }), entry(2, { productId: '12' }), entry(3)),
    );
    expect(progress).toMatchObject({ record: 3, productIds: ['11', '12'] });
  });

  it('treats a gap or an unreadable entry as a lost cursor', () => {
    expect(replayImportJournal(initialProgress(), journal(entry(1), entry(3)))).toBeNull();
    expect(replayImportJournal(initialProgress(), journal(entry(2)))).toBeNull();
    expect(replayImportJournal(initialProgress(), ['{'])).toBeNull();
    expect(replayImportJournal(initialProgress(), [entry(1, { extra: true })])).toBeNull();
  });

  it('does not mutate the snapshot it replays', () => {
    const snapshot = initialProgress();
    replayImportJournal(snapshot, journal(entry(1, { productId: '5' })));
    expect(snapshot).toEqual(initialProgress());
  });
});

describe('administration multi-row insert batches', () => {
  it('keeps row order and splits at the batch size', () => {
    expect(insertBatches([])).toEqual([]);
    expect(insertBatches([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
    const rows = Array.from({ length: 2001 }, (_, index) => index);
    expect(insertBatches(rows).map((batch) => batch.length)).toEqual([1000, 1000, 1]);
    expect(insertBatches(rows).flat()).toEqual(rows);
  });
});
