import { expect, it } from 'vitest';
import {
  expect as browserExpect,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import {
  feedbackCommand,
  feedbackComment,
  feedbackOrder,
  feedbackSafeOrder,
  nativeFeedbackFixture,
} from '../../../backend/tools/product-feedback/native-workflow-fixture';

type Fixture = Awaited<ReturnType<typeof nativeFeedbackFixture>>;
type SourceCall = { url: string; method: string; payload: Record<string, string> };
type SourceJQuery = {
  ajaxPrefilter: (observe: (options: { url: string; type: string; data: unknown }) => void) => void;
};
declare global {
  interface Window {
    feedbackSourceProbe: { calls: SourceCall[]; consoleLogs: number; lookupIds: string[] };
  }
}

export function registerSourceBrowserWorkflows(environment: {
  fixture: () => Fixture;
  browser: () => Browser;
  contexts: BrowserContext[];
  candidate: (orderId?: string) => Promise<{ page: Page }>;
}) {
  const current = () => environment.fixture();
  async function sourcePage(orderId = feedbackSafeOrder) {
    const context = await environment.browser().newContext({ serviceWorkers: 'block' });
    environment.contexts.push(context);
    // Unused CDN plugins are outside this feature. The exact pinned local
    // jQuery, inline script and source DOM execute; no API replies are mocked.
    await context.route('https://**', (route) => route.abort());
    await context.addInitScript(() => {
      window.feedbackSourceProbe = { calls: [], consoleLogs: 0, lookupIds: [] };
      console.log = () => {
        window.feedbackSourceProbe.consoleLogs += 1;
      };
    });
    const page = await context.newPage();
    await page.goto(current().origin + current().sourcePath(orderId));
    await page.evaluate(() => {
      const jquery = (window as typeof window & { jQuery: SourceJQuery }).jQuery;
      const lookup = document.getElementById.bind(document);
      document.getElementById = (id) => {
        window.feedbackSourceProbe.lookupIds.push(id);
        return lookup(id);
      };
      jquery.ajaxPrefilter((options) => {
        if (options.type !== 'POST') return;
        if (typeof options.data !== 'string')
          throw new Error('Source form was not serialized by jQuery');
        const fields = new URLSearchParams(options.data);
        fields.delete('csrfmiddlewaretoken');
        window.feedbackSourceProbe.calls.push({
          url: options.url,
          method: options.type,
          payload: Object.fromEntries(fields),
        });
      });
    });
    return page;
  }
  function sourceInput(page: Page, orderId: string, option: number, occurrence: number) {
    return page.locator(`[id="${option}-${orderId}-10"]`).nth(occurrence);
  }
  async function sourceValues(
    page: Page,
    orderId: string,
    occurrence: number,
    values: { overall: string; size?: string; comment?: string },
  ) {
    await sourceInput(page, orderId, 0, occurrence).fill(values.overall);
    if (values.size !== undefined)
      await sourceInput(page, orderId, 2, occurrence).fill(values.size);
    if (values.comment !== undefined)
      await sourceInput(page, orderId, 4, occurrence).fill(values.comment);
  }
  async function invokeSource(page: Page, formIndex: number, expectedTotal: number) {
    const returned = await page.evaluate((index) => {
      const form = document.forms.item(index);
      if (!form?.onsubmit) throw new Error('Expected the actual source form submit handler');
      return form.onsubmit.call(
        form,
        new SubmitEvent('submit', { bubbles: true, cancelable: true }),
      );
    }, formIndex);
    expect(returned).toBeUndefined();
    await browserExpect
      .poll(() => current().sourceTraffic.length, { timeout: 20000 })
      .toBe(expectedTotal);
    await browserExpect
      .poll(() => page.evaluate(() => window.feedbackSourceProbe.consoleLogs), { timeout: 20000 })
      .toBe(expectedTotal * 2);
    await current().drainSource();
  }
  async function saveCandidate(
    page: Page,
    lineId: string,
    occurrence: number,
    values: { overall: string; size?: string; comment?: string },
  ) {
    await page.getByLabel(`Overall rating for line ${lineId}`).fill(values.overall);
    if (values.size !== undefined)
      await page.getByLabel(`Product size for line ${lineId}`).fill(values.size);
    if (values.comment !== undefined)
      await page.getByLabel(`Comment for line ${lineId}`).fill(values.comment);
    await page.getByRole('button', { name: 'Save feedback', exact: true }).nth(occurrence).click();
  }

  for (const [label, size, comment] of [
    ['blank optional ratings and comment', undefined, ''],
    ['nonempty size and escaped comment', '3.2', feedbackComment],
  ] as const) {
    it(`executes exact source script serialization for ${label} and matches actual candidate native rows`, async () => {
      const source = await sourcePage();
      await sourceValues(source, feedbackSafeOrder, 0, { overall: '4.5', size, comment });
      await invokeSource(source, 0, 4);
      const observed = await source.evaluate(() => window.feedbackSourceProbe.calls);
      expect(observed).toHaveLength(4);
      expect(observed.map((call) => call.payload.product_rating_option)).toEqual([
        '0',
        '1',
        '2',
        '3',
      ]);
      expect(observed.map((call) => call.payload.rating)).toEqual(['4.5', '0', size ?? '0', '0']);
      expect(observed.map((call) => call.payload.comment)).toEqual([comment, '', '', '']);
      expect(current().sourceTraffic.map((request) => request.payload)).toEqual(
        observed.map((call) => call.payload),
      );
      expect(
        current().sourceTraffic.every(
          (request) =>
            request.csrfTokenPresent &&
            request.csrfTokenFormatValid &&
            request.status === 200 &&
            request.sourceStatus === '200',
        ),
      ).toBe(true);
      for (const request of current().sourceTraffic)
        expect(Object.fromEntries(new URLSearchParams(request.serializedBusiness))).toEqual(
          request.payload,
        );
      const expectedRows = await current().rows();
      await current().reset();
      const candidate = await environment.candidate(feedbackSafeOrder);
      await saveCandidate(candidate.page, '101', 0, { overall: '4.5', size, comment });
      await browserExpect(
        candidate.page.getByText('Product feedback saved.', { exact: true }),
      ).toBeVisible();
      expect(await current().rows()).toEqual(expectedRows);
    });
  }
  it('executes the second source form alias bug while the candidate uses the selected line controls', async () => {
    const source = await sourcePage();
    await sourceValues(source, feedbackSafeOrder, 0, { overall: '1.2', comment: 'first form' });
    await sourceValues(source, feedbackSafeOrder, 1, {
      overall: '4.5',
      size: '3.2',
      comment: 'selected second form',
    });
    await invokeSource(source, 1, 4);
    expect(current().sourceTraffic[0]?.payload).toMatchObject({
      rating: '1.2',
      comment: 'first form',
    });
    expect(
      (await current().rows()).find((row) => row.product_rating_option_id === '0'),
    ).toMatchObject({ rating: 1.2, comment: 'first form' });
    await current().reset();
    const candidate = await environment.candidate(feedbackSafeOrder);
    await candidate.page.getByLabel('Overall rating for line 101').fill('1.2');
    await candidate.page.getByLabel('Comment for line 101').fill('first form');
    await saveCandidate(candidate.page, '102', 1, {
      overall: '4.5',
      size: '3.2',
      comment: 'selected second form',
    });
    await browserExpect(
      candidate.page.getByText('Product feedback saved.', { exact: true }),
    ).toBeVisible();
    expect(
      (await current().rows()).find((row) => row.product_rating_option_id === '0'),
    ).toMatchObject({ rating: 4.5, comment: 'selected second form' });
  });
  it('executes source numeric-literal precision loss while the candidate preserves the exact order ID', async () => {
    const source = await sourcePage(feedbackOrder);
    await sourceValues(source, feedbackOrder, 0, { overall: '4.5' });
    await expect(
      source.evaluate(() => {
        const form = document.forms.item(0);
        if (!form?.onsubmit) throw new Error('Expected the source submit handler');
        form.onsubmit.call(form, new SubmitEvent('submit'));
      }),
    ).rejects.toThrow('Cannot read properties of null');
    const probe = await source.evaluate(() => window.feedbackSourceProbe);
    expect(probe.lookupIds).toContain('0-9007199254740992-10');
    expect(probe.lookupIds).toContain('4-9007199254740992-10');
    expect(probe.calls).toHaveLength(0);
    expect(current().sourceTraffic).toHaveLength(0);
    expect(await current().rows()).toEqual([]);
    await current().reset();
    const candidate = await environment.candidate();
    await saveCandidate(candidate.page, '9007199254740997', 0, { overall: '4.5' });
    await browserExpect(
      candidate.page.getByText('Product feedback saved.', { exact: true }),
    ).toBeVisible();
    expect((await current().rows()).every((row) => row.order_id === feedbackOrder)).toBe(true);
  });
  it('executes native form validation on both source and candidate without dispatching invalid ratings', async () => {
    const source = await sourcePage();
    const candidate = await environment.candidate(feedbackSafeOrder);
    for (const [page, input, button] of [
      [
        source,
        sourceInput(source, feedbackSafeOrder, 0, 0),
        source.getByRole('button', { name: 'Save', exact: true }).first(),
      ],
      [
        candidate.page,
        candidate.page.getByLabel('Overall rating for line 101'),
        candidate.page.getByRole('button', { name: 'Save feedback', exact: true }).first(),
      ],
    ] as const) {
      await page
        .locator('html')
        .evaluate((element) => element.setAttribute('data-validation-document', 'same-document'));
      for (const value of ['', '5.1', '3.25']) {
        await input.fill(value);
        expect(
          await input.evaluate(
            (element) => element instanceof HTMLInputElement && element.checkValidity(),
          ),
        ).toBe(false);
        await button.click();
      }
      await browserExpect(page.locator('html')).toHaveAttribute(
        'data-validation-document',
        'same-document',
      );
    }
    expect(current().sourceTraffic).toHaveLength(0);
    expect(current().traffic.filter((request) => request.method === 'POST')).toHaveLength(0);
    expect(await current().rows()).toEqual([]);
  });
  it('executes repeated source handlers as eight inserts while the candidate confirms once and hides both forms', async () => {
    const source = await sourcePage();
    await sourceValues(source, feedbackSafeOrder, 0, { overall: '4.5' });
    await invokeSource(source, 0, 4);
    await invokeSource(source, 1, 8);
    expect(await current().rows()).toHaveLength(8);
    await current().reset();
    const candidate = await environment.candidate(feedbackSafeOrder);
    await saveCandidate(candidate.page, '101', 0, { overall: '4.5' });
    await browserExpect(
      candidate.page.getByText('Product feedback saved.', { exact: true }),
    ).toBeVisible();
    await browserExpect(
      candidate.page.getByRole('button', { name: 'Save feedback', exact: true }),
    ).toHaveCount(0);
    expect(await current().rows()).toHaveLength(4);
    expect(current().traffic.filter((request) => request.method === 'POST')).toHaveLength(1);
  });
  it('observes the source default form navigation and the candidate explicit in-page completion', async () => {
    const source = await sourcePage();
    await sourceValues(source, feedbackSafeOrder, 0, { overall: '4.5' });
    const initial = current().sourceNavigationCount();
    await Promise.all([
      source.waitForEvent('framenavigated', {
        predicate: (frame) => frame === source.mainFrame(),
        timeout: 10000,
      }),
      source.getByRole('button', { name: 'Save', exact: true }).first().click(),
    ]);
    await source.waitForLoadState('networkidle');
    await current().drainSource();
    expect(current().sourceNavigationCount()).toBeGreaterThan(initial);
    const committed = current().sourceTraffic.filter(
      (request) => request.status === 200 && request.sourceStatus === '200',
    );
    expect(committed.length).toBeLessThanOrEqual(4);
    expect(await current().rows()).toHaveLength(committed.length);
    await current().reset();
    const candidate = await environment.candidate(feedbackSafeOrder),
      address = candidate.page.url();
    await saveCandidate(candidate.page, '101', 0, { overall: '4.5' });
    await browserExpect(
      candidate.page.getByText('Product feedback saved.', { exact: true }),
    ).toBeVisible();
    expect(candidate.page.url()).toBe(address);
    expect(await current().rows()).toHaveLength(4);
  });
  it('executes source dispatch validation/partial failures and candidate atomic recovery from a native fourth-insert failure', async () => {
    const empty = current().dispatchSource('POST', '/orders/ajax-add-feedback/');
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ status: '400' });
    const invalid = current().dispatchSource(
      'POST',
      '/orders/ajax-add-feedback/',
      new URLSearchParams({
        user_id: '777',
        order_id: feedbackSafeOrder,
        prod_id: '10',
        product_rating_option: 'invalid',
        rating: '4.5',
      }).toString(),
    );
    expect(invalid.status).toBe(500);
    expect(invalid.exceptionType).toBe('ValueError');
    expect(current().dispatchSource('GET', current().sourcePath(), '', false).status).toBe(302);
    expect((await fetch(current().origin + current().api)).status).toBe(401);
    const cookie = await current().cookie();
    const rejected = await fetch(current().origin + current().api, {
      method: 'POST',
      headers: {
        Cookie: `${cookie.name}=${cookie.value}`,
        Origin: current().origin,
        'X-Operator-Id': '7',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...feedbackCommand, product_rating_option: 'invalid' }),
    });
    expect(rejected.status).toBe(400);
    expect(await current().rows()).toEqual([]);
    await current().rejectQuality();
    const source = await sourcePage();
    await sourceValues(source, feedbackSafeOrder, 0, {
      overall: '4.5',
      size: '3.2',
      comment: feedbackComment,
    });
    await invokeSource(source, 0, 4);
    expect(current().sourceTraffic.map((request) => request.sourceStatus)).toEqual([
      '200',
      '200',
      '200',
      '400',
    ]);
    const partial = await current().rows();
    expect(partial).toHaveLength(3);
    await current().reset();
    await current().rejectQuality();
    const candidate = await environment.candidate(feedbackSafeOrder);
    await saveCandidate(candidate.page, '101', 0, {
      overall: '4.5',
      size: '3.2',
      comment: feedbackComment,
    });
    await browserExpect(
      candidate.page.getByText('The result is unknown. Check this submission before trying again.'),
    ).toBeVisible();
    expect(await current().rows()).toHaveLength(0);
    await candidate.page.getByRole('button', { name: 'Check submission', exact: true }).click();
    await browserExpect(
      candidate.page.getByRole('button', { name: 'Retry saved feedback', exact: true }),
    ).toBeVisible();
    await current().allowQuality();
    await candidate.page.getByRole('button', { name: 'Retry saved feedback', exact: true }).click();
    await browserExpect(
      candidate.page.getByText('Product feedback saved.', { exact: true }),
    ).toBeVisible();
    const complete = await current().rows();
    expect(complete).toHaveLength(4);
    expect(complete.filter((row) => row.product_rating_option_id !== '3')).toEqual(partial);
    expect(
      current()
        .traffic.filter((request) => request.method === 'POST')
        .map((request) => request.status),
    ).toEqual([500, 200]);
  });
}
