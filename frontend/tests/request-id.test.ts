import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiError, errorRequestId, request, setRequestOperator } from '../src/api/client';
import { ErrorState } from '../src/components/common';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
afterEach(() => {
  setRequestOperator(null);
  vi.unstubAllGlobals();
});

it('sends a fresh X-Request-Id per request and reuses a caller-supplied one for retries', async () => {
  const sent: (string | null)[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(new Headers(init.headers).get('X-Request-Id'));
      return Response.json({ ok: true });
    }),
  );
  const schema = z.object({ ok: z.boolean() });
  await request('/api/v1/fixture', {}, schema);
  await request('/api/v1/fixture', {}, schema);
  const retried = crypto.randomUUID();
  await request('/api/v1/fixture', { requestId: retried }, schema);
  await request('/api/v1/fixture', { requestId: retried }, schema);
  await request('/api/v1/fixture', { headers: { 'X-Request-Id': retried } }, schema);
  expect(sent.every((value) => value !== null && uuid.test(value))).toBe(true);
  expect(sent[0]).not.toBe(sent[1]);
  expect(sent.slice(2)).toEqual([retried, retried, retried]);
});

it("surfaces the server's request ID on errors and in the shared error UI", async () => {
  const serverId = crypto.randomUUID();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json(
        {
          error: {
            code: 'INVALID_REQUEST',
            message: 'Some request fields are missing or invalid.',
          },
        },
        { status: 400, headers: { 'X-Request-Id': serverId } },
      ),
    ),
  );
  const error = await request('/api/v1/fixture', {}, z.unknown()).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(ApiError);
  expect(errorRequestId(error)).toBe(serverId);
  const markup = renderToStaticMarkup(createElement(ErrorState, { error }));
  expect(markup).toContain('Some request fields are missing or invalid.');
  expect(markup).toContain(serverId);
  expect(renderToStaticMarkup(createElement(ErrorState, { error: new Error('x') }))).not.toContain(
    'Reference',
  );
});
