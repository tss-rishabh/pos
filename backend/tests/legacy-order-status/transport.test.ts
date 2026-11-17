import { describe, expect, it, vi } from 'vitest';
import {
  receiptSignature,
  sourceStatusBody,
  verifiedReceipt,
  wholeOrderStatusContract,
} from '../../src/modules/legacy-order-status/domain.js';
import { wholeOrderStatusTransport } from '../../src/modules/legacy-order-status/transport.js';
import { readWholeOrderStatusOptions } from '../../src/modules/legacy-order-status/options.js';
import { config, options, command, queuedReceipt, capabilityResponse } from './fixtures.js';
describe('whole-order status qualified transport', () => {
  it('sends exactly the source STORE payload with every HP once, full-width string IDs, no express path or extra DELIVER calls', async () => {
    const reply = queuedReceipt(),
      fetcher = vi.fn(
        async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
          capabilityResponse(input, init) ??
          new Response(JSON.stringify(reply), {
            headers: {
              'Content-Type': 'application/json',
              'x-pos-status-receipt': receiptSignature(
                options.WHOLE_ORDER_STATUS_RECEIPT_KEY!,
                reply,
              ),
            },
          }),
      );
    expect(await wholeOrderStatusTransport(config, options, fetcher).send(command)).toEqual(reply);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, input] = fetcher.mock.calls[1]! as unknown as [URL, RequestInit];
    expect(url.pathname).toBe('/api/store-order/status');
    expect(input.method).toBe('POST');
    expect(JSON.parse(String(input.body))).toEqual(sourceStatusBody(command.snapshot, 'PACK'));
    expect(JSON.parse(String(input.body)).has_product_ids).toHaveLength(3);
    expect(input.redirect).toBe('error');
    expect(input.headers).toMatchObject({
      'Idempotency-Key': command.id,
      'x-api-key': options.BACKEND_SYNC_REPO_API_KEY,
    });
    expect(url.search).toBe('');
  });
  it('reads receipts with GET only and never treats absent remote state as permission to resend', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 404 })),
      transport = wholeOrderStatusTransport(config, options, fetcher);
    expect(await transport.read(command)).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, input] = fetcher.mock.calls[0]! as unknown as [URL, RequestInit];
    expect(url.pathname).toBe('/api/store-order/status/commands/' + command.id);
    expect(input.method).toBe('GET');
    expect(input.body).toBeUndefined();
  });
  it('refuses an old or impersonated receiver BEFORE any effectful POST', async () => {
    const methods: string[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      methods.push(init?.method ?? 'GET');
      return Response.json({ success: true, taskId: 'old-unqualified-source-ack' });
    };
    await expect(
      wholeOrderStatusTransport(config, options, fetcher).send(command),
    ).rejects.toMatchObject({ code: 'WHOLE_ORDER_STATUS_NOT_SENT' });
    expect(methods).toEqual(['GET']);
  });
  it.each([
    'source-ack',
    'wrong-hash',
    'wrong-scope',
    'bad-signature',
    'partial-success',
    'timeout',
    'non-json',
  ] as const)('freezes %s without parsing or logging private errors', async (mode) => {
    const value = queuedReceipt();
    if (mode === 'wrong-hash') value.requestHash = '0'.repeat(64);
    if (mode === 'wrong-scope') value.scopeHash = '0'.repeat(64);
    if (mode === 'partial-success') {
      value.state = 'succeeded';
      value.completedAt = '2026-11-17T06:01:00Z';
      value.stages = [{ platform: 'PACK', status: 'SUCCESS', updatedAt: '2026-11-17T06:01:00Z' }];
    }
    const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const capability = capabilityResponse(input, init);
      if (capability) return capability;
      if (mode === 'timeout')
        throw Object.assign(new Error('synthetic-private-response'), {
          request: { headers: { authorization: 'synthetic-private-header' } },
          response: { body: 'synthetic-private-body' },
        });
      return new Response(
        mode === 'source-ack'
          ? JSON.stringify({
              success: true,
              message: 'PACK queued for processing',
              taskId: 'source-task',
            })
          : mode === 'non-json'
            ? 'synthetic-private-html'
            : JSON.stringify(value),
        {
          headers: {
            'Content-Type': 'application/json',
            'x-pos-status-receipt':
              mode === 'bad-signature'
                ? 'a'.repeat(43)
                : receiptSignature(options.WHOLE_ORDER_STATUS_RECEIPT_KEY!, value),
          },
        },
      );
    });
    try {
      await wholeOrderStatusTransport(config, options, fetcher).send(command);
      throw new Error('Unqualified response passed');
    } catch (error: unknown) {
      expect(String(error)).not.toContain('synthetic-private');
      expect(error).toMatchObject({ status: 502 });
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('rejects unconfigured contracts/credentials and external cleartext before any transport', async () => {
    for (const changed of [
      { WHOLE_ORDER_STATUS_CONTRACT: undefined },
      { BACKEND_SYNC_REPO_API_KEY: undefined },
      { WHOLE_ORDER_STATUS_RECEIPT_KEY: undefined },
      { BACKEND_SYNC_API_BASE_URL: 'http://external.synthetic.invalid' },
    ]) {
      const fetcher = vi.fn(),
        transport = wholeOrderStatusTransport(config, { ...options, ...changed }, fetcher);
      await expect(transport.send(command)).rejects.toMatchObject({
        code: 'WHOLE_ORDER_STATUS_NOT_SENT',
      });
      expect(fetcher).not.toHaveBeenCalled();
    }
    expect(readWholeOrderStatusOptions({}).WHOLE_ORDER_STATUS_WORKER_ENABLED).toBe(false);
  });
  it('requires an exact purpose-bound signed receipt, with complete chained stages for success', () => {
    const receipt = queuedReceipt();
    receipt.state = 'succeeded';
    receipt.completedAt = '2026-11-17T06:01:00Z';
    receipt.stages = (['PACK', 'SHIP', 'DELIVER'] as const).map((platform) => ({
      platform,
      status: 'SUCCESS' as const,
      updatedAt: receipt.completedAt!,
    }));
    expect(
      verifiedReceipt(
        options.WHOLE_ORDER_STATUS_RECEIPT_KEY!,
        receipt,
        receiptSignature(options.WHOLE_ORDER_STATUS_RECEIPT_KEY!, receipt),
        {
          operationId: command.id,
          scopeHash: command.scopeHash,
          requestHash: command.requestHash,
          platform: 'PACK',
        },
      ).contract,
    ).toBe(wholeOrderStatusContract);
  });
});
