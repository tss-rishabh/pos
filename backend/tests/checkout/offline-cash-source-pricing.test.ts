import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { cashPriceSnapshotSchema } from '../../src/modules/checkout/offline-cash/contracts.js';
import { pinnedSourceEnvironment } from '../../tools/pinned-source-env.js';
import { goldenStdout } from '../golden/load.js';

const script = fileURLToPath(
  new URL(
    '../../compatibility/upstream/offline-cash-pricing/test_source_pricing.py',
    import.meta.url,
  ),
);
function sourceRuntimeChecks(filename: string) {
  return execFileSync(
    'uv',
    [
      'run',
      '--project',
      dirname(script),
      '--frozen',
      'python',
      join(dirname(script), filename),
      '-q',
    ],
    {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...pinnedSourceEnvironment(),
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        UV_PROJECT_ENVIRONMENT: join(tmpdir(), 'pos-offline-pricing-runtime'),
        PYTHONDONTWRITEBYTECODE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}
export function sourcePricingFixture(mode: '--snapshot' | '--tax-plan') {
  return execFileSync('python3', [script, mode], {
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: 8_000_000,
    env: {
      ...pinnedSourceEnvironment(),
      PATH: process.env.PATH,
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONWARNINGS: 'ignore',
      PYTHONHASHSEED: '0',
    },
  });
}
describe('source-executed private offline cash pricing', () => {
  it('preserves source basket rounding, hydration, scope and closed logging', () => {
    const result = execFileSync('python3', [script, '-q'], {
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        ...pinnedSourceEnvironment(),
        PATH: process.env.PATH,
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONWARNINGS: 'ignore',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(result).toBe('');
  });
  it('returns the exact strict TypeScript grant pricing contract without coercion', () => {
    // Captured `test_source_pricing.py --snapshot` output over backend-tss-api_v2@2960acb.
    const raw: unknown = JSON.parse(
      goldenStdout('checkout', 'offline-cash-source-pricing.snapshot'),
    );
    const result = cashPriceSnapshotSchema.parse(raw);
    expect(result).toEqual(raw);
    expect(result.products[0]?.quantities.map((row) => row.quantity)).toEqual([1, 2, 3, 5, 20]);
    expect(result.products[0]?.quantities[2]?.mainSubtotalCents).toBe(23738);
    expect(result.products[0]?.cachedStock).toBe(50);
    expect(result.products[1]?.quantities[0]?.unitPrice).toBe('300.0');
    expect(result.lineItemsEnabled).toBe(true);
  });
  it('executes source-only order constructors with signed frozen cash evidence and private logs', () => {
    expect(sourceRuntimeChecks('test_source_template.py')).toBe('');
  });
  it('independently compares the original and corrected source refund SQL', () => {
    expect(sourceRuntimeChecks('test_source_refund_query.py')).toBe('');
  });
});
