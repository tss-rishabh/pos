import { describe, expect, it } from 'vitest';
import {
  pythonFloatDict,
  pythonFloatRepr,
  pythonIntLiteral,
  pythonJsonDumps,
  pythonRepr,
  pythonRound2,
  pythonStringRepr,
} from '../../src/domain/python-compat.js';
import { goldenStdout, loadGolden } from '../golden/load.js';

/** Float tokens of a CPython `json.dumps` text: `json` prints floats with `float.__repr__`. */
const floatTokens = (text: string) => text.match(/-?\d+(?:\.\d+)?(?:e[+-]\d+)?/g) ?? [];

describe('python-compat against the captured CPython goldens', () => {
  it('round(x, 2): core/parity and legacy-fulfillment/lifecycle-domain', () => {
    const values = [
      2.675,
      1.005,
      4.125,
      -2.675,
      -1.005,
      0,
      0.125,
      1.375,
      10000000000.125,
      ...Array.from({ length: 1000 }, (_, i) => (i - 500) * 0.12345),
    ];
    const core: unknown = JSON.parse(
      goldenStdout('core', 'parity', JSON.stringify({ operation: 'round', values })),
    );
    expect(values.map(pythonRound2)).toEqual(core);

    const wallet = [
      2.675,
      2.685,
      1.005,
      -2.675,
      60.125,
      5e-324,
      -0.00001,
      123456789.555,
      1e20,
      Number.MAX_VALUE,
    ];
    const stdout = goldenStdout(
      'legacy-fulfillment',
      'lifecycle-domain',
      JSON.stringify([{ kind: 'round', values: wallet }]),
    );
    const tokens = floatTokens(stdout);
    expect(tokens).toHaveLength(wallet.length);
    expect(wallet.map(pythonRound2).map(Number)).toEqual(tokens.map(Number));
    // The float tokens are float.__repr__ text, including 0.0, -0.0, 1.0 and e+308.
    wallet.forEach((value, index) => {
      const token = tokens[index]!;
      if (/[.e]/.test(token)) expect(pythonFloatRepr(pythonRound2(value))).toBe(token);
    });
    expect(tokens).toContain('-0.0');
  });

  it('repr(float): checkout/refund-amount, including the padded exponent 1e-07', () => {
    const values = [
      0.010000000000005116, 50.25, 2.675, 1.005, 0.005, 0.015, 199.99499999999998,
      1234.5650000000001, 349.00000000000006, 1e-7,
    ];
    const oracle = JSON.parse(
      goldenStdout(
        'checkout',
        'refund-amount',
        JSON.stringify({ operation: 'refund_amount', values }),
        ['refund_amount'],
      ),
    ) as { rounded: number[]; repr: string[] };
    expect(values.map(pythonFloatRepr)).toEqual(oracle.repr);
    expect(values.map(pythonRound2)).toEqual(oracle.rounded);
  });

  it('json.dumps: Paytm checksum bodies (checkout/payments) and hyperlocal request bodies', () => {
    const payments = JSON.parse(
      goldenStdout('checkout', 'payments', JSON.stringify({ operation: 'terminal_payloads' })),
    ) as { checksums: string[] };
    expect(payments.checksums).toHaveLength(2);
    for (const text of payments.checksums)
      expect(pythonJsonDumps(JSON.parse(text) as unknown)).toBe(text);

    const bodies: string[] = [];
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === 'object')
        for (const [key, item] of Object.entries(value))
          if (key === 'body' && typeof item === 'string' && item.startsWith('{')) bodies.push(item);
          else collect(item);
    };
    for (const invocation of loadGolden('legacy-fulfillment', 'lifecycle-domain').invocations)
      if (invocation.stdout?.startsWith('[{"calls"'))
        collect(JSON.parse(invocation.stdout) as unknown);
    expect(bodies.length).toBeGreaterThan(5);
    for (const text of bodies) expect(pythonJsonDumps(JSON.parse(text) as unknown)).toBe(text);
  });

  it('str(list): the hyperlocal transfer comment in legacy-fulfillment/lifecycle-domain', () => {
    const text = loadGolden('legacy-fulfillment', 'lifecycle-domain')
      .invocations.map((invocation) => invocation.stdout ?? JSON.stringify(invocation.output))
      .find((stdout) => stdout.includes('Transferred to the other stores'));
    expect(text).toContain(
      `Hyperlocal Order has been Transferred to the other stores, ${pythonRepr([2, 3])}"`,
    );
  });
});

// CPython 3.10 reference values (`repr`, `str`, `int`, `json.dumps` on the same inputs).
describe('python-compat CPython semantics', () => {
  it('repr(float) switches to exponent form below 1e-4 and from 1e16', () => {
    expect(
      [0, -0, 1, 100, 99.5, 0.1 + 0.2, 0.0001, 0.00001, 1.5e-5, 1e15, 1e16, 1.2345e17].map(
        pythonFloatRepr,
      ),
    ).toEqual([
      '0.0',
      '-0.0',
      '1.0',
      '100.0',
      '99.5',
      '0.30000000000000004',
      '0.0001',
      '1e-05',
      '1.5e-05',
      '1000000000000000.0',
      '1e+16',
      '1.2345e+17',
    ]);
    expect([Infinity, -Infinity, NaN].map(pythonFloatRepr)).toEqual(['inf', '-inf', 'nan']);
  });
  it('repr(str) picks the quote and escapes like CPython', () => {
    expect(pythonStringRepr("it's")).toBe('"it\'s"');
    expect(pythonStringRepr('x\'y"z')).toBe("'x\\'y\"z'");
    expect(pythonStringRepr('tab\there\u0085\u007f')).toBe("'tab\\there\\x85\\x7f'");
    expect(pythonStringRepr('ü')).toBe("'ü'");
  });
  it('str() of decoded JSON keeps ints, and floats when the source held floats', () => {
    expect(pythonRepr({ a: null, b: true, c: "it's", d: [1, 2.5], e: 10n })).toBe(
      `{'a': None, 'b': True, 'c': "it's", 'd': [1, 2.5], 'e': 10}`,
    );
    expect(pythonFloatDict({ 'tss point refunded': 0, 'tss money refunded': 12.5 })).toBe(
      "{'tss point refunded': 0.0, 'tss money refunded': 12.5}",
    );
  });
  it('int(str) accepts whitespace, a sign and single underscores between digits', () => {
    expect([' 1_0 ', '-007', '+5', '99999999999999999999'].map(pythonIntLiteral)).toEqual([
      '10',
      '-007',
      '+5',
      '99999999999999999999',
    ]);
    for (const value of ['', 'abc', '1.0', '1__0', '_1', '1_'])
      expect(pythonIntLiteral(value)).toBeNull();
  });
  it('json.dumps escapes to ASCII and prints non-finite floats as CPython does', () => {
    expect(pythonJsonDumps({ text: '🛵 ü\u007f"\\\n\b', list: [1, true, null] })).toBe(
      '{"text": "\\ud83d\\udef5 \\u00fc\\u007f\\"\\\\\\n\\b", "list": [1, true, null]}',
    );
    expect(pythonJsonDumps([NaN, Infinity, -Infinity])).toBe('[NaN, Infinity, -Infinity]');
  });
});
