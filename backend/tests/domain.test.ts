import { describe, expect, it } from 'vitest';
import { Temporal } from '@js-temporal/polyfill';
import { routeRead, businessRange } from '../src/domain/routing.js';
import { draftTotal, minorUnits } from '../src/domain/money.js';
import { verifyDjangoPassword, seal, unseal } from '../src/auth/crypto.js';
import { pbkdf2Sync } from 'node:crypto';

describe('routing and financial boundaries', () => {
  const now = Temporal.Instant.from('2026-11-16T06:00:00Z');
  it('routes operational reads to the primary, today to data, historical and mixed to BigQuery', () => {
    expect(routeRead({ kind: 'interactive' }, now)).toBe('primary');
    expect(routeRead({ kind: 'report', range: businessRange('2026-11-16') }, now)).toBe('data');
    expect(routeRead({ kind: 'report', range: businessRange('2026-11-15') }, now)).toBe('bigquery');
    expect(
      routeRead(
        { kind: 'report', range: { start: '2026-11-15T18:29:59Z', end: '2026-11-16T18:30:00Z' } },
        now,
      ),
    ).toBe('bigquery');
  });
  it('handles the exact Indian midnight boundary and DST calendar days', () => {
    expect(businessRange('2026-11-16')).toEqual({
      start: '2026-11-15T18:30:00Z',
      end: '2026-11-16T18:30:00Z',
    });
    const range = businessRange('2026-03-08', 'America/New_York');
    expect(
      Temporal.Instant.from(range.end).epochMilliseconds -
        Temporal.Instant.from(range.start).epochMilliseconds,
    ).toBe(23 * 3600000);
  });
  it('rejects missing offsets, reversed ranges and unbounded scans', () => {
    for (const range of [
      { start: '2026-01-01', end: '2026-01-02' },
      { start: '2026-01-02T00:00Z', end: '2026-01-01T00:00Z' },
      { start: '2025-01-01T00:00Z', end: '2026-01-01T00:00Z' },
    ])
      expect(() => routeRead({ kind: 'report', range }, now)).toThrow();
  });
  it('uses exact minor units for quantity totals and rejects malformed amounts', () => {
    expect(
      draftTotal([
        { unitPrice: '0.10', quantity: 3 },
        { unitPrice: '0.20', quantity: 1 },
      ]),
    ).toBe('0.50');
    expect(minorUnits('9007199254740993.12')).toBe(900719925474099312n);
    for (const bad of ['-1', '1e10', '1.001', 'Infinity', 'NaN'])
      expect(() => minorUnits(bad)).toThrow();
  });
});
describe('credential compatibility', () => {
  it('checks Django PBKDF2 hashes without accepting other formats', async () => {
    const encoded = `pbkdf2_sha256$1000$fixture-salt$${pbkdf2Sync('passphrase', 'fixture-salt', 1000, 32, 'sha256').toString('base64')}`;
    expect(await verifyDjangoPassword('passphrase', encoded)).toBe(true);
    expect(await verifyDjangoPassword('wrong', encoded)).toBe(false);
    expect(await verifyDjangoPassword('passphrase', 'plain$passphrase')).toBe(false);
  });
  it('rejects cookie tampering and does not expose the plaintext payload', () => {
    const secret = 'x'.repeat(32),
      token = seal({ id: '1', private: 'test-secret' }, secret);
    expect(token).not.toContain('test-secret');
    expect(unseal(token, secret)).toEqual({ id: '1', private: 'test-secret' });
    const changed = Buffer.from(token, 'base64url');
    changed[28] = changed[28]! ^ 1;
    expect(() => unseal(changed.toString('base64url'), secret)).toThrow();
  });
});
