import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ReleaseNotes } from '../../src/components/release-notes';
import type { Principal } from '../../src/api/types';
import { goldenSpawnResult } from '../golden/load';

// Pinned users/templates/admin/includes/whatsnew.html (78d5b63) rendered per role by Django 4.2.5;
// replayed from tests/golden/global-reminders/release-notes.json.
const original = z.object({
  sourceCommit: z.literal('78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'),
  roles: z
    .array(
      z.object({
        role: z.number(),
        mappings: z.array(z.tuple([z.string(), z.string()])).length(3),
        headings: z.array(z.string()),
        reportNote: z.boolean(),
        updated: z.string(),
        dateTime: z.string(),
        newBadge: z.boolean(),
      }),
    )
    .length(5),
});
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
describe('What’s New informational notes', () => {
  it('shows the pinned role-name mappings, role-1 report note, date and New badge per role', () => {
    const rendered = goldenSpawnResult('global-reminders', 'release-notes');
    expect(rendered.status).toBe(0);
    const source = original.parse(JSON.parse(rendered.stdout) as unknown);
    for (const expected of source.roles) {
      const html = renderToStaticMarkup(
        createElement(ReleaseNotes, { role: expected.role as Principal['role'] }),
      );
      const rows = [...html.matchAll(/<tr><td>(.*?)<\/td><td>(.*?)<\/td><\/tr>/g)].map((match) => [
        text(match[1]!),
        text(match[2]!),
      ]);
      expect(rows, 'role ' + expected.role).toEqual(expected.mappings);
      const headings = [...html.matchAll(/<h3>(.*?)<\/h3>/g)].map((match) => text(match[1]!));
      expect(headings, 'role ' + expected.role).toEqual(expected.headings);
      expect(headings.some((value) => value.includes('Cashier Performance'))).toBe(
        expected.reportNote,
      );
      expect(html).toContain(`<time dateTime="${expected.dateTime}">${expected.updated}</time>`);
      expect(/What’s New <span>New<\/span>/.test(html)).toBe(expected.newBadge);
    }
  });
});
