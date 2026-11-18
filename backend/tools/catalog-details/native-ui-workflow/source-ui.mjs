import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

/** Execute the actual rendered source scripts with explicit plugin/DOM ports.
 * DataTables configuration and row-action construction execute; the third-party
 * plugin, external assets, mutation callbacks and full legacy browser do not.
 */
export function sourceUiContract(page, html) {
  assert.equal(typeof html, 'string');
  assert(html.length < 200000);
  let configuration;
  const explicitVisibility = {};
  const chain = new Proxy(function () {}, {
    get(_target, key) {
      if (key === 'column')
        return (index) => ({
          visible(value) {
            explicitVisibility[index] = value;
            return chain;
          },
        });
      if (key === 'DataTable')
        return (options) => {
          assert.equal(configuration, undefined);
          configuration = options;
          return chain;
        };
      return () => chain;
    },
    apply: () => chain,
  });
  const jquery = (value) => {
    if (typeof value === 'function') value();
    return chain;
  };
  jquery.inArray = (value, array) => array.indexOf(value);
  jquery.ajax = () => assert.fail('Source mutation transport is outside this read proof');
  const context = {
    $: jquery,
    jQuery: jquery,
    bsCustomFileInput: { init() {} },
    window: { location: { href: 'http://fixture.invalid/' } },
    console: { log() {} },
  };
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
  assert(scripts.length > 0);
  for (const script of scripts)
    if (script[1].trim()) runInNewContext(script[1], context, { timeout: 1000 });
  assert(configuration);
  const result = {
    ajaxPath: configuration.ajax.url,
    ajaxMethod: configuration.ajax.type,
    columns: configuration.columns.map((column) => column.data ?? column.title),
    lengthOptions: Array.from(configuration.lengthMenu[0]),
    buttons: Array.from(configuration.buttons, (button) =>
      typeof button === 'string' ? button : button.extend,
    ),
    stateSave: configuration.stateSave,
    visibleCsv: configuration.buttons.some(
      (button) =>
        typeof button === 'object' &&
        button.extend === 'csv' &&
        button.exportOptions.columns === ':visible',
    ),
    explicitVisibility,
  };
  assert.equal(
    result.ajaxPath,
    page === 'catalog' ? '/ajax-products-list/' : '/ajax-product-stock-list/',
  );
  assert.equal(result.ajaxMethod, 'POST');
  assert.equal(result.stateSave, true);
  assert(result.buttons.includes('pageLength') && result.buttons.includes('colvis'));
  assert.equal(result.visibleCsv, page === 'catalog');
  assert.equal(explicitVisibility[page === 'catalog' ? 8 : 3], true);
  if (page === 'catalog') {
    const action = configuration.columnDefs.find((definition) => definition.targets === 8);
    const actions = action.render(null, 'display', { DT_RowId: '9007199254740993' }, {});
    assert(actions.includes('/products/9007199254740993/show'));
    assert(actions.includes('/products/9007199254740993/inventory-logs'));
    result.detailAndAuditLinksPreserveHighId = true;
  }
  return result;
}
