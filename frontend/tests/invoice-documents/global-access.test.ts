import { expect, it } from 'vitest';
import { invoiceAccessQuery, invoicePreviewPath } from '../../src/pages/invoice-documents/client';
it('keeps source global invoice selection explicit in protected navigation', () => {
  expect(invoiceAccessQuery()).toBe('');
  expect(invoiceAccessQuery('global-online')).toBe('?access=global-online');
  expect(() =>
    invoicePreviewPath('7', '1', '9007199254740993', 'store', 'global-online'),
  ).toThrow();
  expect(() =>
    invoicePreviewPath('7', '1', '9007199254740993', 'express', 'global-online'),
  ).toThrow();
  const base = invoicePreviewPath('7', '1', '9007199254740993', 'online');
  expect(base).not.toContain('?');
  expect(invoicePreviewPath('7', '1', '9007199254740993', 'online', 'global-online')).toBe(
    base + '?access=global-online',
  );
});
