import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
const root = process.env.POS_PARITY_SOURCE_ROOT;
assert(root, 'POS_PARITY_SOURCE_ROOT is required');
// source-defaults.json is the golden capture of tests/finance/source-defaults.py run
// against the pinned source (re-verified identical under CPython 3.10.22 before removal).
const retained = JSON.parse(await readFile(resolve('tests/finance/source-defaults.json'), 'utf8'));
const defaults = retained.cases;
for (const [path, digest] of Object.entries(retained.sha256))
  assert.equal(
    createHash('sha256')
      .update(await readFile(resolve(root, path)))
      .digest('hex'),
    digest,
  );
const template = await readFile(
  resolve(root, 'report/templates/daily_store_report/index.html'),
  'utf8',
);
const script = template.slice(template.indexOf('<script>') + 8, template.lastIndexOf('</script>'));
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
    (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : undefined),
});
try {
  for (const value of defaults) {
    const page = await browser.newPage({ timezoneId: 'Asia/Kolkata' });
    await page.clock.install({ time: new Date(value.at) });
    await page.setContent(
      '<input class="order-date-range" id="order-date-range"><select id="stores" multiple><option value="1" selected>Fixture</option></select><input type="checkbox" id="selectAllStores"><table id="daily-store-report-datatable"></table>',
    );
    await page.locator('#order-date-range').fill(value.range);
    for (const path of [
      'jquery/jquery.min.js',
      'moment/moment.min.js',
      'daterangepicker/daterangepicker.js',
    ])
      await page.addScriptTag({ path: resolve(root, 'static/adminlte/plugins', path) });
    await page.evaluate(() => {
      window.__captured = null;
      window.jQuery.fn.select2 = function () {
        return this;
      };
      window.jQuery.alert = () => {
        throw new Error('Unexpected source alert');
      };
      window.jQuery.fn.DataTable = function (options) {
        window.__captured = options.ajax.data;
        return { destroy() {} };
      };
    });
    const rendered = script
      .replace(
        /\{% if order_date_range %\}.*?\{% else %\}.*?\{% endif %\}/gs,
        JSON.stringify(value.range),
      )
      .replaceAll('{{selected_stores|safe}}', JSON.stringify(value.selected))
      .replace(/\{% url [^%]+%\}/g, '/fixture-read')
      .replace(/\{\{[^}]+\}\}/g, 'fixture');
    await page.addScriptTag({ content: rendered });
    await page.waitForFunction(() => window.__captured !== null);
    const observed = await page.evaluate(() => ({
      input: document.getElementById('order-date-range').value,
      request: window.__captured.order_date_range,
      pickerEnd: window
        .jQuery('#order-date-range')
        .data('daterangepicker')
        .endDate.format('MM/DD/YYYY'),
    }));
    assert.equal(observed.input, value.range);
    assert.equal(observed.request, value.range);
    assert.equal(observed.pickerEnd, value.range.split(' - ')[1]);
    await page.close();
  }
  const closeTemplate = await readFile(
    resolve(root, 'report/templates/day_close/index.html'),
    'utf8',
  );
  for (const revision of [false, true]) {
    const page = await browser.newPage();
    const closeScript = closeTemplate
      .slice(closeTemplate.indexOf('<script>') + 8, closeTemplate.lastIndexOf('</script>'))
      .replace(/\{% url '([^']+)' %\}/g, '/fixture-$1')
      .replace(/\{\{[^}]+\}\}/g, 'fixture');
    const html = closeTemplate
      .slice(0, closeTemplate.indexOf('<script>'))
      .replace(/\{%[^%]+%\}/g, '')
      .replace(/\{\{[^}]+\}\}/g, 'fixture');
    await page.setContent(html);
    await page.addScriptTag({
      path: resolve(root, 'static/adminlte/plugins/jquery/jquery.min.js'),
    });
    await page.evaluate((revision) => {
      window.__writes = [];
      window.__confirmation = null;
      const split = {
        system: '0',
        actual: '0',
        manual_punched: '0',
        manual_created: '0',
        difference: '0',
        reason: '',
        comment: '',
      };
      const close = {
        version: 2,
        status: 'CLOSED',
        closed_at: '2026-11-18 22:01',
        cash: { ...split, refund: '0' },
        card: split,
        banking_amount: '0',
      };
      window.jQuery.confirm = (options) => {
        window.__confirmation = options;
      };
      window.jQuery.alert = () => {};
      window.jQuery.ajax = (options) => {
        if (options.url.includes('submit')) {
          window.__writes.push(options.data);
          options.success({ status: 200, data: close });
        } else
          options.success({
            status: 200,
            data: {
              system: {
                cash: '0',
                cash_refund: '0',
                total_online: '0',
                card_upi: '0',
                online_other: '0',
                district: '0',
                total_collection: '0',
              },
              window: { allowed: true, state: 'OPEN', opens_at: '', closes_at: '' },
              close: revision ? close : null,
              tolerance: 0,
            },
          });
      };
    }, revision);
    await page.addScriptTag({ content: closeScript });
    await page.waitForFunction(() => document.getElementById('btn-close-day').disabled === false);
    const required = [
      'cash-actual',
      'card-actual',
      'banking-amount',
      'cash-manual-punched',
      'cash-manual-created',
      'card-manual-punched',
      'card-manual-created',
    ];
    if (!revision)
      for (const id of required) assert.equal(await page.locator('#' + id).inputValue(), '');
    await page.locator('#btn-close-day').click();
    if (!revision) assert.equal(await page.evaluate(() => window.__confirmation), null);
    for (const id of required) await page.locator('#' + id).fill('0');
    await page.locator('#card-manual-created').dispatchEvent('input');
    await page.locator('#btn-close-day').click();
    const observed = await page.evaluate(() => ({
      title: window.__confirmation.title,
      content: window.__confirmation.content,
      cancel: window.__confirmation.buttons.cancel.text,
      writes: window.__writes.length,
    }));
    assert.equal(observed.title, revision ? 'Revise this close?' : 'File this close?');
    assert.equal(observed.cancel, 'Cancel');
    assert.equal(observed.writes, 0);
    for (const name of ['System', 'Actual', 'Result', 'Cash', 'Total Online', 'Banking'])
      assert(observed.content.includes(name));
    assert.equal(observed.content.includes('the original is kept'), revision);
    await page.evaluate(() => window.__confirmation.buttons.confirm.action());
    assert.equal(await page.evaluate(() => window.__writes.length), 1);
    await page.close();
  }
  console.log(
    'PASS: 5 pinned source GET → actual shipped date-widget → AJAX request cases, including tomorrow at23:59. plus 2 active source close-entry/review/explicit-confirm flows. DataTable/AJAX transports captured; no DB/provider access.',
  );
} finally {
  await browser.close();
}
