import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { sourceOrderPreparation } from '../../src/modules/legacy-order-imports/source-order-preparation.js';
import type {
  CsvMembershipHistoryRequest,
  QualifiedCsvMembershipHistory,
} from '../../src/modules/legacy-order-imports/membership-profile/history.js';
import type { SourceOrderPreparationInput } from '../../src/modules/legacy-order-imports/source-order-preparation-contracts.js';
import {
  preparationInput,
  preparationScope,
  preparationDocument,
  preparationOptions,
  previewFetch,
  preparationConfig,
  preparationFinancial,
  preparationNow,
} from './fixtures.js';
const capability = z.object({ attemptId: z.string() });

describe('source-first read-only CSV order preparation', () => {
  it('accepts a literal no-history result with absent warehouse views/keys and never calls BQ or financial endpoints', async () => {
    const input = preparationInput(),
      f = previewFetch(input, ['ready']),
      historyReader = { read: vi.fn() };
    const port = sourceOrderPreparation(
      preparationConfig,
      preparationFinancial,
      preparationOptions(),
      { ...f, clock: () => preparationNow, historyReader },
    );
    expect(await port.prepare(input, { signal: new AbortController().signal })).toEqual({});
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]!.url).toBe(
      preparationFinancial.sourceUrl + '/' + input.state.scope.operationId + '/preparation',
    );
    expect(historyReader.read).not.toHaveBeenCalled();
    expect(f.requests[0]!.body).not.toHaveProperty('capability.nonce');
    expect(f.requests[0]!.body).not.toHaveProperty('membershipHistory');
  });
  it('prefetches one qualified document only after trusted NeedHistory, reruns preview once and hands off the same signed generation', async () => {
    const input = preparationInput(),
      f = previewFetch(input, ['need-history', 'ready']);
    const read = vi.fn(async (scope: CsvMembershipHistoryRequest) => {
      expect(f.requests).toHaveLength(1);
      return preparationDocument(scope);
    });
    const port = sourceOrderPreparation(
      preparationConfig,
      preparationFinancial,
      preparationOptions(true),
      { ...f, clock: () => preparationNow, historyReader: { read } },
    );
    const result = await port.prepare(input, { signal: new AbortController().signal });
    expect(read).toHaveBeenCalledExactlyOnceWith(preparationScope(input));
    expect(result.membershipHistory?.document.generationId).toBe('f'.repeat(64));
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]!.body).toHaveProperty('membershipHistory', result.membershipHistory);
    expect(
      f.requests.map(
        (request) =>
          capability.parse(z.object({ capability: z.unknown() }).parse(request.body).capability)
            .attemptId,
      ),
    ).toEqual([input.attemptId, input.attemptId]);
    expect(input.plan.createdAt).toBe('2026-06-15 12:00:00');
  });
  it('fails only at the actual required-history branch when warehouse authority is absent', async () => {
    const input = preparationInput(),
      f = previewFetch(input, ['need-history']);
    const port = sourceOrderPreparation(
      preparationConfig,
      preparationFinancial,
      preparationOptions(),
      { ...f, clock: () => preparationNow },
    );
    await expect(
      port.prepare(input, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_PREPARATION_HISTORY_REQUIRED' });
    expect(f.requests).toHaveLength(1);
  });
  it.each([
    'requestHash',
    'planHash',
    'attemptId',
    'authorityHash',
    'planDigest',
    'sourceTimeZone',
    'membershipHistoryHash',
  ] as const)('refuses a swapped/tampered %s before a warehouse request', async (field) => {
    const input = preparationInput(),
      f = previewFetch(input, ['need-history'], (body) => ({
        ...body,
        [field]:
          field === 'attemptId'
            ? randomUUID()
            : field === 'sourceTimeZone'
              ? 'UTC'
              : 'e'.repeat(64),
      }));
    const read = vi.fn();
    await expect(
      sourceOrderPreparation(preparationConfig, preparationFinancial, preparationOptions(true), {
        ...f,
        clock: () => preparationNow,
        historyReader: { read },
      }).prepare(input, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_PREPARATION_INVALID' });
    expect(read).not.toHaveBeenCalled();
  });
  it('never loops or repeats BQ if the second literal preview unexpectedly still needs history', async () => {
    const input = preparationInput(),
      f = previewFetch(input, ['need-history', 'need-history']);
    const read = vi.fn(async (scope: CsvMembershipHistoryRequest) => preparationDocument(scope));
    await expect(
      sourceOrderPreparation(preparationConfig, preparationFinancial, preparationOptions(true), {
        ...f,
        clock: () => preparationNow,
        historyReader: { read },
      }).prepare(input, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_PREPARATION_INVALID' });
    expect(read).toHaveBeenCalledTimes(1);
    expect(f.requests).toHaveLength(2);
  });
  it('propagates stale/incomplete/malformed signed history instead of fabricating empty history or dispatching order', async () => {
    for (const change of [
      { complete: false },
      { fetchedAt: preparationNow - 60001 },
      { signature: 'a'.repeat(64) },
    ]) {
      const input = preparationInput(),
        f = previewFetch(input, ['need-history']);
      const read = vi.fn(async (scope: CsvMembershipHistoryRequest) => {
        const document = preparationDocument(scope);
        Object.assign(document, change);
        return document;
      });
      await expect(
        sourceOrderPreparation(preparationConfig, preparationFinancial, preparationOptions(true), {
          ...f,
          clock: () => preparationNow,
          historyReader: { read },
        }).prepare(input, { signal: new AbortController().signal }),
      ).rejects.toBeDefined();
      expect(f.requests).toHaveLength(1);
    }
  });
  it('cancels while warehouse read is outstanding without a repeated preview or financial request', async () => {
    const input = preparationInput(),
      f = previewFetch(input, ['need-history']),
      abort = new AbortController();
    let finish: ((value: QualifiedCsvMembershipHistory) => void) | undefined;
    const read = vi.fn(
      () =>
        new Promise<QualifiedCsvMembershipHistory>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = sourceOrderPreparation(
      preparationConfig,
      preparationFinancial,
      preparationOptions(true),
      { ...f, clock: () => preparationNow, historyReader: { read } },
    ).prepare(input, { signal: abort.signal });
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    finish?.(preparationDocument(preparationScope(input)));
    await Promise.resolve();
    expect(f.requests).toHaveLength(1);
  });
  it('has no retry for missing/failed source replies and never exposes provider error strings', async () => {
    const input = preparationInput(),
      fetcher = vi.fn<typeof fetch>(async () => {
        throw new Error('private-provider-credential-canary');
      });
    await expect(
      sourceOrderPreparation(preparationConfig, preparationFinancial, preparationOptions(), {
        fetcher,
        clock: () => preparationNow,
      }).prepare(input, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_PREPARATION_UNAVAILABLE' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('refuses disabled configuration, changed prices or expired attempt before network', async () => {
    for (const mutate of [
      (input: SourceOrderPreparationInput) => {
        input.expiresAt = preparationNow;
      },
      (input: SourceOrderPreparationInput) => {
        input.plan.lines[0]!.unitPrice = '20.00';
      },
      (input: SourceOrderPreparationInput) => {
        input.state.preparationContract = undefined;
      },
    ]) {
      const input = preparationInput(),
        f = previewFetch(input, ['ready']);
      mutate(input);
      await expect(
        sourceOrderPreparation(preparationConfig, preparationFinancial, preparationOptions(), {
          ...f,
          clock: () => preparationNow,
        }).prepare(input, { signal: new AbortController().signal }),
      ).rejects.toMatchObject({ code: 'ORDER_IMPORT_PREPARATION_INVALID' });
      expect(f.fetcher).not.toHaveBeenCalled();
    }
  });
});
