import type { Browser, Page } from '@playwright/test';

/** Finish cold development-server setup before timing individual workflows.
 * The throwaway page owns a fresh context; no storage or API state reaches tests. */
export async function prepareBrowserFixture(
  browser: Browser,
  load: (page: Page) => Promise<void>,
): Promise<void> {
  const page = await browser.newPage();
  try {
    await load(page);
  } finally {
    await page.close();
  }
}
