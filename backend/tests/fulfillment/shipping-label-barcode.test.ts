import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  shippingCode128,
  shippingCode128Svg,
} from '../../src/modules/fulfillment/shipping-label/code128.js';

const folder = 'tools/fulfillment/shipping-label-source/',
  artifact = readFileSync(folder + 'JsBarcode.code128.min.fixture.txt', 'utf8');
const independent = z
  .array(z.string().regex(/^1[01]+$/))
  .length(107)
  .parse(
    (
      /export const BARS = \[([^\]]+)\]/.exec(
        readFileSync(folder + 'constants.fixture.txt', 'utf8'),
      )?.[1] || ''
    ).match(/\d+/g),
  );
function decode(modules: string) {
  if (!modules.endsWith(independent[106]!)) throw new Error('Barcode stop symbol missing.');
  const codes: number[] = [];
  for (let offset = 0; offset < modules.length - 13; offset += 11) {
    const code = independent.indexOf(modules.slice(offset, offset + 11));
    if (code < 0) throw new Error('Barcode symbol invalid.');
    codes.push(code);
  }
  const checksum = codes.pop(),
    start = codes.shift();
  if (start === undefined || start < 103 || start > 105)
    throw new Error('Barcode start symbol invalid.');
  if ((start + codes.reduce((sum, code, index) => sum + code * (index + 1), 0)) % 103 !== checksum)
    throw new Error('Barcode checksum invalid.');
  let set = start - 103,
    result = '';
  for (let index = 0; index < codes.length; index++) {
    const code = codes[index]!;
    if (code === 102) {
      result += '\xcf';
      continue;
    }
    if (set === 2) {
      if (code < 100) result += String(code).padStart(2, '0');
      else if (code === 100 || code === 101) set = code === 100 ? 1 : 0;
      else throw new Error('Barcode numeric symbol invalid.');
      continue;
    }
    if (code === 99) {
      set = 2;
      continue;
    }
    if (code === 100 && set === 0) {
      set = 1;
      continue;
    }
    if (code === 101 && set === 1) {
      set = 0;
      continue;
    }
    let use = set,
      value = code;
    if (code === 98) {
      use = 1 - set;
      value = codes[++index]!;
    }
    if (value < 0 || value > 95) throw new Error('Barcode text symbol invalid.');
    result += String.fromCharCode(use === 1 ? value + 32 : value < 64 ? value + 32 : value - 64);
  }
  return result;
}

describe('shipping label machine-readable Code128', () => {
  it('preserves scanned values against the actual source-pinned encoder across long IDs, numeric runs, control sets and FNC1', () => {
    expect(createHash('sha256').update(artifact).digest('hex')).toBe(
      '1643cd2953c4ff5e0b3fb94ada172faee1d1770e81bdf3ad07dabca8e211b29e',
    );
    const sandbox = { window: { JsBarcode: undefined as unknown } };
    vm.runInNewContext(artifact, sandbox, {
      timeout: 1000,
      contextCodeGeneration: { strings: false, wasm: false },
    });
    const encode = z
      .custom<(target: object, value: string, options: { format: string }) => void>(
        (value) => typeof value === 'function',
      )
      .parse(sandbox.window.JsBarcode);
    const vectors = [
      '0',
      '9007199254740993',
      '99999999999999999999',
      'AWB123456789012IN',
      'abc01234567890def',
      '12A34B56',
      'x'.repeat(255),
      '\x00\x01\x1fABC\x7fabc',
      '\xcf1234567890123456',
      ...Array.from({ length: 64 }, (_, index) =>
        Array.from({ length: index + 1 }, (_char, offset) =>
          String.fromCharCode((index * 7 + offset * 11) % 128),
        ).join(''),
      ),
    ];
    for (const value of vectors) {
      const source: { encodings?: unknown } = {};
      encode(source, value, { format: 'CODE128' });
      const original = z
          .array(z.object({ data: z.string() }))
          .parse(source.encodings)
          .map((row) => row.data)
          .join(''),
        rewrite = shippingCode128(value);
      expect(decode(original)).toBe(value);
      expect(decode(rewrite.modules)).toBe(value);
      expect(rewrite.modules.length).toBeLessThanOrEqual(original.length);
    }
  });
  it('renders only local escaped SVG and rejects unsupported or unbounded barcode data', () => {
    const svg = shippingCode128Svg('<script>&"', true);
    expect(svg).toContain('&lt;script&gt;&amp;&quot;');
    expect(svg).not.toContain('<script>');
    expect(svg).not.toContain('href=');
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(shippingCode128Svg('9007199254740993', false)).not.toContain('<text');
    for (const value of ['', 'x'.repeat(256), 'भारतीय', '\u0100'])
      expect(() => shippingCode128(value)).toThrow('requires reconciliation');
  });
});
