import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/domain/errors.js';
import {
  backendEventIds,
  clientEventIds,
  isRegisteredEventId,
} from '../../src/observability/event-registry.js';
import { errorClassification, mapError, withCause } from '../../src/observability/errors.js';

/** Workstream D: one `as const` event registry for the backend processes; no free-form IDs. */
const source = fileURLToPath(new URL('../../src', import.meta.url));
function files(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
  });
}
const modules = files(source).map((path) => ({
  path: path.slice(source.length + 1),
  text: readFileSync(path, 'utf8'),
}));

describe('backend event registry', () => {
  it('lists unique, well-formed IDs', () => {
    const ids = [...backendEventIds, ...clientEventIds];
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*(\.[a-z0-9-]+){1,3}$/);
  });
  it('registers every literal event ID logged in src, and builds none by concatenation', () => {
    const literal = /eventId:\s*'([^']+)'/g,
      builder =
        /\b(?:event|lifecycle)\(\s*(?:job|context|user|uploadId|[\w.?]+)?(?:,\s*[^,()]+?)*?,?\s*'([a-z][a-z0-9-]*\.[a-z0-9.-]+)'/g;
    const unregistered: string[] = [];
    for (const { path, text } of modules) {
      for (const match of text.matchAll(literal))
        if (!isRegisteredEventId(match[1])) unregistered.push(`${path}: ${match[1]}`);
      for (const match of text.matchAll(builder))
        if (!isRegisteredEventId(match[1])) unregistered.push(`${path}: ${match[1]}`);
      // Concatenated or lower-cased IDs cannot be checked by the compiler.
      expect(text, path).not.toMatch(/eventId:\s*'[^']*'\s*\+/);
      expect(text, path).not.toMatch(/eventId:\s*[^,\n]*\.toLowerCase\(\)/);
      // A template ID must be narrowed (`as const`) so the typed logger checks it. The one
      // exceptions are the two derived families: request completion events (route event
      // catalog) and the `<module>.<resource>.log` fallback.
      if ([join('observability', 'events.ts'), join('observability', 'logger.ts')].includes(path))
        continue;
      for (const match of text.matchAll(/eventId:\s*(`[^`]*`)([^,\n]*)/g))
        expect(match[2], `${path}: ${match[1]}`).toMatch(/^\s*as const/);
    }
    expect(unregistered).toEqual([]);
  });
  it('accepts exactly the renderer IDs the frontend registers', () => {
    const frontend = readFileSync(
      fileURLToPath(new URL('../../../frontend/src/observability/ui-events.ts', import.meta.url)),
      'utf8',
    );
    const block = /export const uiEvents = \{([\s\S]*?)\} as const;/.exec(frontend)?.[1] ?? '';
    const ids = [...block.matchAll(/'(ui\.[a-z0-9.-]+)':/g)].map((match) => match[1]);
    expect(ids.sort()).toEqual([...clientEventIds].sort());
  });
});

describe('original error codes behind a replacement AppError', () => {
  it('keeps the cause classification as causeCode without exposing it in the response', () => {
    const driver = Object.assign(new Error('Deadlock found; SELECT secret_canary'), {
      code: 'ER_LOCK_DEADLOCK',
    });
    const replaced = withCause(
      new AppError(409, 'OFFLINE_CONFLICT_OUTCOME_UNKNOWN', 'A manager must check Orders.'),
      driver,
    );
    const mapped = mapError(replaced, '6f1c1d3e-2f0a-4b8e-9c55-3a1d2b4c5e6f');
    expect(mapped).toMatchObject({ logCode: 'OFFLINE_CONFLICT_OUTCOME_UNKNOWN' });
    expect(mapped.causeCode).toBe('ER_LOCK_DEADLOCK');
    expect(JSON.stringify(mapped.body)).not.toContain('ER_LOCK_DEADLOCK');
    expect(JSON.stringify(replaced)).not.toContain('secret_canary');
    expect(Object.keys(replaced)).not.toContain('cause');
    expect(mapError(new AppError(409, 'X', 'x'), 'r').causeCode).toBeUndefined();
  });
  it('classifies causes by code or class name, never by message', () => {
    expect(errorClassification(new AppError(502, 'CHECKOUT_SUBMIT_FAILED', 'x'))).toBe(
      'CHECKOUT_SUBMIT_FAILED',
    );
    expect(errorClassification(new TypeError('customer 9876543210'))).toBe('TypeError');
    expect(errorClassification('customer 9876543210')).toBe('UNKNOWN_ERROR');
    expect(
      errorClassification(Object.assign(new Error('x'), { name: 'customer 9876543210' })),
    ).toBe('UNKNOWN_ERROR');
  });
});
