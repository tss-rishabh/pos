import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createContext, Script } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const sourceRoot = process.env.SOURCE_POS_ROOT || '/Users/rishabhbhatia/code/backend-pos-web';
const pin = '78d5b63d6a149a6bf2c748fa1d191799c59ecb8a';
const sourcePath = 'order/templates/order/create_order.html';
const sourceHash = '3ddf48d6ac77c12953369459cc247b889be99b0915602fdd23d68d63d27bd5f7';
interface JQueryFixture {
  length: number;
  find(selector: string): JQueryFixture;
  val(value?: unknown): string | JQueryFixture;
  text(value?: unknown): string | JQueryFixture;
  prop(name: string): boolean;
  [method: string]: unknown;
}
interface AjaxCall {
  url: string;
  type: string;
  data: Record<string, unknown>;
  success?: (data: unknown, status?: string, xhr?: unknown) => unknown;
}
interface DialogFixture {
  buttons: { Submit: { action(this: { $content: JQueryFixture }): unknown } };
}
function sourceFunctions() {
  const raw = execFileSync('git', ['-C', sourceRoot, 'show', pin + ':' + sourcePath]);
  expect(createHash('sha256').update(raw).digest('hex')).toBe(sourceHash);
  const rendered = raw
    .toString('utf8')
    .replace(/\{%\s*comment\s*%\}[\s\S]*?\{%\s*endcomment\s*%\}/g, '')
    .replace(/\{%\s*url\s+'([^']+)'[\s\S]*?%\}/g, '/fixture/$1')
    .replace(/\{%[\s\S]*?%\}/g, '')
    .replace(/\{\{\s*tab_id\s*\}\}/g, '1')
    .replace(/\{\{[\s\S]*?\}\}/g, '0');
  const extract = (name: string) => {
    const start = rendered.indexOf('function ' + name + '(');
    if (start < 0) throw new Error('Pinned source form function missing.');
    const file = ts.createSourceFile(
      'pinned-source-form.js',
      rendered.slice(start),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const node = file.statements.find(
      (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name,
    );
    if (!node || !ts.isFunctionDeclaration(node))
      throw new Error('Pinned source form function invalid.');
    const script = node.getText(file);
    new Script(script);
    return script;
  };
  const initial = /var performance_json\s*=\s*(\{[\s\S]*?\})/.exec(rendered)?.[1];
  if (!initial) throw new Error('Pinned source performance initializer missing.');
  return {
    cash: extract('fast_checkout_button_press'),
    prepaid: extract('PayProceedButtonFast'),
    initial,
  };
}
function fixture() {
  const code = sourceFunctions(),
    calls: { url: string; data: Record<string, unknown> }[] = [];
  let payable = '100',
    validationSuccess = true,
    performanceTick = 0;
  const jquery = (selector: string): JQueryFixture => {
    const object: JQueryFixture = {
      length: selector.includes('tbl-add-product-cart-thead') ? 1 : 0,
      find: (query) => jquery(selector + ' ' + query),
      val: (value) =>
        value !== undefined
          ? object
          : selector.includes('salesperson')
            ? '5'
            : selector.includes('order-msg')
              ? 'Synthetic cash note'
              : selector.includes('fast_cash_recieved')
                ? '100'
                : '0',
      text: (value) => (value !== undefined ? object : payable),
      prop: () => true,
    };
    for (const method of [
      'show',
      'hide',
      'css',
      'html',
      'append',
      'remove',
      'attr',
      'on',
      'change',
    ])
      object[method] = () => object;
    return object;
  };
  const dollar = Object.assign(jquery, {
    alert: () => undefined,
    confirm: (dialog: DialogFixture) =>
      dialog.buttons.Submit.action.call({ $content: jquery('modal') }),
    ajax: (input: AjaxCall) => {
      calls.push({ url: input.url, data: structuredClone(input.data) });
      if (input.url === '/fixture/ajax-validate-process-order')
        input.success?.(
          {
            status: validationSuccess ? 200 : 400,
            message: 'Synthetic validation result',
            data: {
              meta: {
                items: [
                  {
                    name: 'calculations',
                    total: Number(payable),
                    rounding_off: 0,
                    total_savings: 0,
                    coupon_discount: 0,
                    exclusive_savings: 0,
                    gst_total: 0,
                    products_total: 100,
                    gift_voucher_value: 0,
                    used_pg_discount: 0,
                    used_store_discount_pg: 0,
                    used_tss_points: 0,
                    used_tss_money: 0,
                    app_cashback: 0,
                  },
                ],
              },
              products: { items: [{ prod_type: 1 }] },
              giftvouchers: { items: [] },
            },
          },
          'success',
          {},
        );
      // Deliberately stop at the request boundary. Never execute an order,
      // payment, remote success callback, source startup or browser navigation.
    },
  });
  const context = createContext({
    $: dollar,
    ButtonStateManager: { disableAll: () => undefined, enableAll: () => undefined },
    toast_message: () => undefined,
    document: {
      getElementById: (id: string) => ({
        value: id.includes('remark') || id.includes('reason') ? '' : '0',
        style: {},
      }),
    },
    localStorage: { getItem: () => '1000' },
    Date: { now: () => 5000 },
    performance: { now: () => (performanceTick++ === 0 ? 10 : 45.5) },
    console: { log: () => undefined },
    isExclusiveUser: false,
    window: { orderProcessing: false },
  });
  new Script(
    'var performance_json=' + code.initial + ';' + code.prepaid + '\n' + code.cash,
  ).runInContext(context, { timeout: 1000 });
  return {
    calls,
    cash: (): void => {
      new Script('fast_checkout_button_press();').runInContext(context, { timeout: 1000 });
    },
    payProceed: (): void => {
      new Script('PayProceedButtonFast();').runInContext(context, { timeout: 1000 });
    },
    snapshot: () =>
      z
        .record(z.string(), z.unknown())
        .parse(
          JSON.parse(
            new Script('JSON.stringify(performance_json)').runInContext(context) as string,
          ) as unknown,
        ),
    price: (value: string) => {
      payable = value;
    },
    failure: () => {
      validationSuccess = false;
    },
  };
}
describe.skipIf(!existsSync(sourceRoot))(
  'pinned source form performance serialization boundaries',
  () => {
    it('fresh positive fast cash serializes the four initial fields and no fast_payment timing', () => {
      const source = fixture();
      source.cash();
      const request = source.calls.find((call) => call.url === '/fixture/ajax-fast-checkout');
      expect(request).toBeDefined();
      expect(JSON.parse(String(request!.data.performance_json)) as unknown).toEqual({
        product_main_list: '',
        user_behaviour: '',
        add_to_cart: '',
        proceed_to_payment: '',
      });
      expect(request!.data.overall_performance_time).toBe(4000);
      expect(source.calls).toHaveLength(1);
    });
    it('the fresh PayProceed inner order serializes before its fast_payment assignment', () => {
      const source = fixture();
      source.payProceed();
      const request = source.calls.find((call) => call.url === '/fixture/ajax-order');
      expect(request).toBeDefined();
      expect(
        JSON.parse(String(request!.data.performance_json)) as Record<string, unknown>,
      ).not.toHaveProperty('fast_payment');
      expect(source.snapshot().fast_payment).toBe('35.50');
    });
    it('zero-payable fast checkout delegates to the actual PayProceed source path', () => {
      const source = fixture();
      source.price('0');
      source.cash();
      expect(source.calls[0]?.url).toBe('/fixture/ajax-validate-process-order');
      expect(source.calls.some((call) => call.url === '/fixture/ajax-order')).toBe(true);
      expect(source.calls.some((call) => call.url === '/fixture/ajax-fast-checkout')).toBe(false);
    });
    it('a prior failed PayProceed leaves fast_payment on the shared global for a later cash serialization', () => {
      const source = fixture();
      source.failure();
      source.payProceed();
      expect(source.snapshot().fast_payment).toBe('35.50');
      expect(source.calls.some((call) => call.url === '/fixture/ajax-order')).toBe(false);
      source.cash();
      const request = source.calls.find((call) => call.url === '/fixture/ajax-fast-checkout');
      expect(
        JSON.parse(String(request!.data.performance_json)) as Record<string, unknown>,
      ).toHaveProperty('fast_payment', '35.50');
    });
  },
);
