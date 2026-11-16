import type { Page } from '@playwright/test';
/** Intercept the app's actual print call even when a fresh srcDoc replaces its frame. */
export async function installInvoicePrintProbe(page: Page) {
  await page.addInitScript(() => {
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLIFrameElement.prototype,
      'contentWindow',
    );
    const original = descriptor?.get;
    if (!descriptor || !original) throw new Error('Invoice print probe unavailable');
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
      ...descriptor,
      get(this: HTMLIFrameElement) {
        const target = original.call(this) as Window | null;
        if (target && this.title.startsWith('Tax invoice')) {
          const parent = this.ownerDocument;
          Object.defineProperty(target, 'print', {
            configurable: true,
            value: () => {
              const before = Number(
                parent.documentElement.getAttribute('data-invoice-print-count') || '0',
              );
              parent.documentElement.setAttribute('data-invoice-print-count', String(before + 1));
              target.document.documentElement.setAttribute('data-print-requested', 'true');
              target.document.body.setAttribute('data-print-called', 'true');
            },
          });
        }
        return target;
      },
    });
  });
}
