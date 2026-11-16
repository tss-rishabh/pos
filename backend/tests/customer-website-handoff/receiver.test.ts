import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
const html = readFileSync('compatibility/upstream/customer-website-handoff/receiver.html', 'utf8');
describe('single-purpose website fragment receiver', () => {
  it('removes the cap before transport and retries the exact body only in memory', async () => {
    const order: string[] = [],
      bodies: string[] = [];
    let click: (() => void) | undefined;
    let complete: () => void = () => undefined;
    const status = { textContent: '' },
      retry = {
        hidden: true,
        addEventListener(_name: string, callback: () => void) {
          click = callback;
        },
      };
    const script = html.split('<script nonce="__NONCE__">')[1]!.split('</script>')[0]!;
    const context = {
      location: {
        hash: '#' + 'a'.repeat(43),
        replace(path: string) {
          order.push(path);
          complete();
        },
      },
      history: {
        replaceState(_state: unknown, _title: string, path: string) {
          order.push('clear:' + path);
        },
      },
      document: {
        getElementById(id: string) {
          return id === 'status' ? status : retry;
        },
      },
      async fetch(_path: string, init: { body: string }) {
        order.push('fetch');
        bodies.push(init.body);
        if (bodies.length === 1) throw new Error('Synthetic lost response');
        return { ok: true, json: async () => ({ status: 'signed-in' }) };
      },
      AbortSignal,
    };
    vm.runInNewContext(script, context);
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(['clear:/pos/secure-login', 'fetch']);
    expect(retry.hidden).toBe(false);
    await new Promise<void>((resolve) => {
      complete = resolve;
      click!();
    });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(order.at(-1)).toBe('/');
    expect(html).not.toMatch(/localStorage|sessionStorage|console\.|src=/);
  });
  it('does not transmit an invalid or empty fragment', async () => {
    let work = 0;
    const script = html.split('<script nonce="__NONCE__">')[1]!.split('</script>')[0]!;
    vm.runInNewContext(script, {
      location: { hash: '#invalid' },
      history: { replaceState() {} },
      document: {
        getElementById() {
          return { textContent: '', hidden: true, addEventListener() {} };
        },
      },
      fetch() {
        work++;
        throw new Error('Forbidden');
      },
      AbortSignal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(work).toBe(0);
  });
});
