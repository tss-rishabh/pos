import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  captureOperatorScope,
  request,
  requestWithResponse,
  setRequestOperator,
} from '../src/api/client';

afterEach(() => {
  setRequestOperator(null);
  vi.unstubAllGlobals();
});
it('fences local file/hash continuations across operator changes before they can publish work', () => {
  setRequestOperator('101');
  const scope = captureOperatorScope('101');
  expect(scope.aborted).toBe(false);
  setRequestOperator('102');
  expect(scope.aborted).toBe(true);
  expect(() => captureOperatorScope('101')).toThrow('The signed-in operator changed.');
  expect(captureOperatorScope('102').aborted).toBe(false);
});
it('binds resource calls to their initiating operator and refuses new stale-owner work before transport', async () => {
  const headers: Headers[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      headers.push(new Headers(init.headers));
      return Response.json({ saved: true });
    }),
  );
  setRequestOperator('101');
  await request(
    '/api/v1/fixture',
    { method: 'POST', body: '{}' },
    z.object({ saved: z.boolean() }),
  );
  setRequestOperator('102');
  await expect(
    request(
      '/api/v1/fixture',
      { method: 'POST', body: '{}', operatorId: '101' },
      z.object({ saved: z.boolean() }),
    ),
  ).rejects.toMatchObject({ name: 'AbortError' });
  await expect(
    request('/api/v1/fixture', { headers: { 'X-Operator-ID': '101' } }, z.unknown()),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(headers.map((value) => value.get('X-Operator-ID'))).toEqual(['101']);
});
it('aborts outstanding resource work when the committed workspace operator changes', async () => {
  let pending: AbortSignal | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      pending = init.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) =>
        pending!.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        ),
      );
    }),
  );
  setRequestOperator('101');
  const result = request('/api/v1/fixture', {}, z.unknown());
  setRequestOperator('102');
  expect(pending?.aborted).toBe(true);
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
});
it('does not release a completed binary result to a stale operator after an awaited body read', async () => {
  let finish: (() => void) | undefined, started: (() => void) | undefined;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('private-export-fixture')),
  );
  setRequestOperator('101');
  const result = requestWithResponse('/api/v1/fixture', { operatorId: '101' }, async (response) => {
    started!();
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return response.blob();
  });
  await reading;
  setRequestOperator('102');
  finish!();
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
});
it('discards a stale operator error after awaited parsing without refreshing the new identity', async () => {
  const window = new EventTarget(),
    refreshed = vi.fn();
  window.addEventListener('pos-operator-changed', refreshed);
  vi.stubGlobal('window', window);
  let finish: (() => void) | undefined, started: (() => void) | undefined;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const response = new Response(null, { status: 409 });
  vi.spyOn(response, 'json').mockImplementation(async () => {
    started!();
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { error: { code: 'OPERATOR_CHANGED', message: 'The account changed.' } };
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response),
  );
  setRequestOperator('101');
  const result = request('/api/v1/fixture', { operatorId: '101' }, z.unknown());
  await reading;
  setRequestOperator('102');
  finish!();
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  expect(refreshed).not.toHaveBeenCalled();
});
