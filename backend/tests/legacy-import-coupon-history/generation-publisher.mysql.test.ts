import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { importFinancialFixture } from '../legacy-import-financial/fixture.js';
import {
  generationJournal,
  generationJournalTable,
  generationJournalDdl,
} from '../../src/modules/legacy-order-imports/benefit-profile/history-generation-journal.js';
import { couponGenerationPublisher } from '../../src/modules/legacy-order-imports/benefit-profile/history-generation-publisher.js';
import { couponGenerationCandidate } from '../../src/modules/legacy-order-imports/benefit-profile/history-generation-candidate.js';
import { generationFixture } from './generation-fixtures.js';
import type {
  GenerationWritePlan,
  GenerationWriteReply,
  GenerationWritePort,
} from '../../src/modules/legacy-order-imports/benefit-profile/history-generation-writer.js';
const template = process.env.CHECKOUT_MYSQL_TEST_URL,
  journalKey = 'isolated-publisher-journal-key-'.repeat(3);
function reply(
  plan: GenerationWritePlan,
  status: GenerationWriteReply['status'],
): GenerationWriteReply {
  const body = { status, jobId: plan.jobId, queryHash: plan.hash };
  return { ...body, evidenceHash: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
}
describe.skipIf(!template)(
  'immutable generation publisher native journal and lost acknowledgement',
  () => {
    let db: Awaited<ReturnType<typeof importFinancialFixture>>,
      f: ReturnType<typeof generationFixture>;
    beforeAll(async () => {
      db = await importFinancialFixture(template!);
      await db.connection.query(generationJournalDdl);
    }, 30000);
    afterAll(async () => {
      await db?.close();
    });
    beforeEach(async () => {
      await db.reset();
      await db.connection.query('DELETE FROM pos_rewrite_coupon_generation_journal');
      f = generationFixture();
    });
    function fixture() {
      let enabled = true,
        remote: GenerationWriteReply['status'] = 'pending';
      const source = {
          capture: vi.fn(async () => ({
            capture: f.capture,
            controls: f.controls,
            logs: f.logRows,
          })),
        },
        writer: GenerationWritePort = {
          start: vi.fn(async (plan) => reply(plan, remote)),
          read: vi.fn(async (plan) => reply(plan, remote)),
        };
      const journal = generationJournal(
          db.db,
          { sourceKey: f.authority.sourceKey, journalKey },
          () => f.now,
        ),
        candidate = couponGenerationCandidate(
          f.options,
          { sourceKey: f.authority.sourceKey },
          {
            clock: () => f.now,
            query: { estimate: async () => 0n, execute: async () => f.rows('candidate') },
          },
        );
      const service = couponGenerationPublisher(f.options, f.authority, {
        source,
        journal,
        candidate,
        writer,
        newWorkEnabled: () => enabled,
        clock: () => f.now,
      });
      return {
        source,
        writer,
        journal,
        service,
        setEnabled: (v: boolean) => {
          enabled = v;
        },
        setRemote: (v: GenerationWriteReply['status']) => {
          remote = v;
        },
      };
    }
    it('claims each stage once under 20 contenders, then binds immutable publication without a second native capture', async () => {
      const x = fixture(),
        record = await x.service.prepare(f.scope, f.control);
      x.setRemote('succeeded');
      await Promise.all(
        Array.from({ length: 20 }, () =>
          x.service.advance(record.id, new AbortController().signal),
        ),
      );
      expect(x.writer.start).toHaveBeenCalledTimes(1);
      expect((await x.service.read(record.id)).phase).toBe('materialized');
      await x.service.advance(record.id, new AbortController().signal);
      expect((await x.service.read(record.id)).phase).toBe('qualified');
      await Promise.all(
        Array.from({ length: 20 }, () =>
          x.service.advance(record.id, new AbortController().signal),
        ),
      );
      await x.service.advance(record.id, new AbortController().signal);
      expect((await x.service.read(record.id)).phase).toBe('published');
      expect(x.writer.start).toHaveBeenCalledTimes(2);
      expect(x.source.capture).toHaveBeenCalledTimes(1);
      const calls = vi.mocked(x.writer.start).mock.calls;
      expect(new Set(calls.map((v) => v[0].jobId)).size).toBe(2);
      expect(calls[0]![0].jobId).toContain(record.id);
      expect(calls[1]![0].jobId).toContain(record.id);
    });
    it('lost materialization response and disabled new work recover original job by GET only', async () => {
      const x = fixture(),
        record = await x.service.prepare(f.scope, f.control);
      x.setRemote('unknown');
      await x.service.advance(record.id, new AbortController().signal);
      x.setEnabled(false);
      await x.service.advance(record.id, new AbortController().signal);
      x.setRemote('succeeded');
      await x.service.advance(record.id, new AbortController().signal);
      expect((await x.service.read(record.id)).phase).toBe('materialized');
      await x.service.advance(record.id, new AbortController().signal);
      expect(x.writer.start).toHaveBeenCalledTimes(1);
      expect(x.writer.read).toHaveBeenCalledTimes(2);
      expect(x.source.capture).toHaveBeenCalledTimes(1);
    });
    it('lost publication response remains one immutable original job and survives selector disable', async () => {
      const x = fixture(),
        record = await x.service.prepare(f.scope, f.control);
      x.setRemote('succeeded');
      await x.service.advance(record.id, new AbortController().signal);
      await x.service.advance(record.id, new AbortController().signal);
      x.setRemote('unknown');
      await x.service.advance(record.id, new AbortController().signal);
      x.setEnabled(false);
      await x.service.advance(record.id, new AbortController().signal);
      x.setRemote('succeeded');
      const final = await x.service.advance(record.id, new AbortController().signal);
      expect(final.phase).toBe('published');
      expect(x.writer.start).toHaveBeenCalledTimes(2);
      expect(x.source.capture).toHaveBeenCalledTimes(1);
      await x.service.advance(record.id, new AbortController().signal);
      expect(x.writer.start).toHaveBeenCalledTimes(2);
    });
    it('no configured writer/new-work selection means no native capture or side effects', async () => {
      const x = fixture();
      x.setEnabled(false);
      await expect(x.service.prepare(f.scope, f.control)).rejects.toMatchObject({
        code: 'ORDER_IMPORT_COUPON_PUBLICATION_GENERATION_WRITER_REQUIRED',
      });
      expect(x.source.capture).not.toHaveBeenCalled();
      expect(x.writer.start).not.toHaveBeenCalled();
    });
    it('keeps private log/customer data encrypted and refuses authenticated journal tampering', async () => {
      const x = fixture(),
        record = await x.service.prepare(f.scope, f.control),
        [raw] = await db.db
          .get('writer')
          .select()
          .from(generationJournalTable)
          .where(eq(generationJournalTable.id, record.id));
      expect(raw!.payload).not.toContain('customerId');
      expect(raw!.payload).not.toContain('couponId');
      expect(raw!.payload).not.toContain('9007199254740993');
      await db.connection.query(
        "UPDATE pos_rewrite_coupon_generation_journal SET payload=CONCAT(payload,'a') WHERE id=?",
        [record.id],
      );
      await expect(x.service.read(record.id)).rejects.toMatchObject({
        code: 'ORDER_IMPORT_COUPON_PUBLICATION_GENERATION_JOURNAL',
      });
      expect(x.writer.start).not.toHaveBeenCalled();
    });
    it('rolls back a failed durable claim before any remote write and preserves the original plan', async () => {
      const x = fixture(),
        record = await x.service.prepare(f.scope, f.control);
      await db.connection.query(
        "CREATE TRIGGER pos_gen_fixture_fail BEFORE UPDATE ON pos_rewrite_coupon_generation_journal FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic generation rollback'",
      );
      try {
        await expect(
          x.service.advance(record.id, new AbortController().signal),
        ).rejects.toBeDefined();
        expect(x.writer.start).not.toHaveBeenCalled();
        expect((await x.service.read(record.id)).phase).toBe('prepared');
      } finally {
        await db.connection.query('DROP TRIGGER pos_gen_fixture_fail');
      }
      await x.service.advance(record.id, new AbortController().signal);
      expect(x.writer.start).toHaveBeenCalledTimes(1);
    });
  },
);
