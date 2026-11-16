import { describe, expect, it } from 'vitest';
import { readShippingDocument } from '../../src/pages/fulfillment/shipping-label';
const html =
  '<!doctype html><meta name="pos-shipping-label" content="1:9007199254740993"><meta http-equiv="Content-Security-Policy" content="script-src none"><main>Fixture label</main>';
describe('shipping preview transport boundary', () => {
  it('accepts the exact current scope and rejects other-order, executable or non-HTML responses', async () => {
    expect(
      await readShippingDocument(
        new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
        '1',
        '9007199254740993',
      ),
    ).toBe(html);
    for (const body of [
      html.replace('1:9007199254740993', '2:9007199254740993'),
      html.replace('Content-Security-Policy', 'no-policy'),
      html + '<script>unsafe()</script>',
    ])
      await expect(
        readShippingDocument(
          new Response(body, { headers: { 'Content-Type': 'text/html' } }),
          '1',
          '9007199254740993',
        ),
      ).rejects.toThrow('could not be confirmed');
    await expect(
      readShippingDocument(
        new Response('{}', { headers: { 'Content-Type': 'application/json' } }),
        '1',
        '9007199254740993',
      ),
    ).rejects.toThrow('unsupported');
  });
  it('cancels oversized document streams before buffering an unbounded private response', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(524289));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      readShippingDocument(
        new Response(stream, { headers: { 'Content-Type': 'text/html' } }),
        '1',
        '9007199254740993',
      ),
    ).rejects.toThrow('supported size');
    expect(cancelled).toBe(true);
  });
});
