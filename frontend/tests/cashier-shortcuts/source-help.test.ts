import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CashierShortcutReferenceContent } from '../../src/pages/cashier-shortcuts/help';
import { cashierShortcutDescriptions } from '../../src/pages/cashier-shortcuts/shortcuts';
import { goldenSpawnResult } from '../golden/load';

// Pinned order/views.py keyShortcutsView + order/templates/order/shortcuts.html (78d5b63) served
// through Django 4.2.5's real signed-cookie auth at both mounts (order/urls.py:57 under
// POSAdmin/urls.py); replayed from tests/golden/cashier-shortcuts/source-help.json.
const source = z.object({
  sourceCommit: z.literal('78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'),
  rows: z.array(z.tuple([z.string(), z.string(), z.string()])).length(9),
  cases: z
    .array(
      z.object({
        mount: z.enum(['api/v1/orders/', 'orders/']),
        authenticatedGet: z.literal(200),
        authenticatedHead: z.literal(200),
        authenticatedPost: z.literal(405),
        missingCsrfPost: z.literal(403),
        tamperedCookie: z.literal(302),
      }),
    )
    .length(10),
  anonymousStatus: z.literal(302),
  databaseUsed: z.literal(false),
});
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
describe('cashier shortcut reference against the pinned help page', () => {
  const rendered = goldenSpawnResult('cashier-shortcuts', 'source-help');
  const legacy = source.parse(JSON.parse(rendered.stdout) as unknown);
  it('lists the same nine keys and descriptions in source order', () => {
    expect(rendered.status).toBe(0);
    expect(legacy.rows.map(([index]) => index)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
    ]);
    expect(cashierShortcutDescriptions.map(([key, description]) => [key, description])).toEqual(
      legacy.rows.map(([, key, description]) => [key, description]),
    );
    const html = renderToStaticMarkup(
      createElement(CashierShortcutReferenceContent, { enabled: true, onChange: () => undefined }),
    );
    const rows = [...html.matchAll(/<tr><th><kbd>(.*?)<\/kbd><\/th><td>(.*?)<\/td><\/tr>/g)].map(
      (match) => [text(match[1]!), text(match[2]!)],
    );
    expect(rows).toEqual(legacy.rows.map(([, key, description]) => [key, description]));
  });
  it('records the legacy login-required help page at both order mounts', () => {
    // Legacy redirects anonymous users (302) and serves the page to every role; the rewrite's
    // reference is a static page inside the authenticated shell (no server route).
    expect(legacy.anonymousStatus).toBe(302);
    expect(new Set(legacy.cases.map((value) => value.mount))).toEqual(
      new Set(['api/v1/orders/', 'orders/']),
    );
  });
});
