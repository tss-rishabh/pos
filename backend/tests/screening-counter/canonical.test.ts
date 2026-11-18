import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { counterDigest } from '../../src/modules/legacy-order-imports/screening-counter/contracts.js';
import { operationHash } from '../../src/modules/checkout/crypto.js';
import { generationSnapshot, generationSourceKey } from './generation-fixture.js';
const key = 'local-cross-language-counter-fixture-key-'.repeat(2);
const python = (kind: string, input: unknown) =>
  execFileSync(
    'python3',
    [
      '-c',
      `import hashlib,hmac,json,sys
value=json.load(sys.stdin)
body=json.dumps(value['input'],sort_keys=True,ensure_ascii=False,separators=(',',':'),allow_nan=False)
raw='{"kind":'+json.dumps(value['kind'])+',"input":'+body+'}'
print(hmac.new(value['key'].encode(),raw.encode(),hashlib.sha256).hexdigest())
`,
    ],
    { input: JSON.stringify({ kind, input, key }), encoding: 'utf8' },
  ).trim();
describe('counter signatures shared with source Python', () => {
  it('signs the complete capture using the actual source canonical field ordering', () => {
    const { signature: _signature, ...capture } = generationSnapshot().capture;
    expect(counterDigest(key, 'capture', capture)).toBe(
      python('screening-counter.capture.v1', capture),
    );
  });
  it('signs publication capture timestamp/hash fields identically and rejects the former locale ordering', () => {
    const { signature: _signature, ...capture } = generationSnapshot().capture;
    const input = {
      ...capture,
      sourceCapturedAt: capture.capturedAt,
      sourceCaptureHash: counterDigest(generationSourceKey, 'capture', capture),
    };
    expect(counterDigest(key, 'publication', input)).toBe(
      python('screening-counter.publication.v1', input),
    );
    expect(counterDigest(key, 'publication', input)).not.toBe(
      operationHash('screening-counter.publication.v1', input, key),
    );
  });
  it('orders mixed case, numeric and supplementary Unicode keys by Python codepoints', () => {
    const input = {
      '2': 'two',
      '10': 'ten',
      a: 'é',
      A: '😀',
      '\uE000': { '😀': 'x', '\uE000': 'y' },
      '😀': 'z',
    };
    expect(counterDigest(key, 'publication', input)).toBe(
      python('screening-counter.publication.v1', input),
    );
  });
});
