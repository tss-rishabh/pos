"""Compose narrow legacy cart grant hooks into already composed source bytes.

Called by source_hooks.legacy_changes; protected source trees stay read-only.
Only exact original requests.post expressions in the listed native helpers
change, with an unchanged passthrough when the origin selector is disabled.
"""
import ast

METHODS = {
    'CreateOrderView': {'get_user_cart'},
    'AjaxCartView': {'add_to_cart', 'delete_from_cart', 'set_to_cart', 'clear_cart'},
    'AjaxSyncCartView': {'sync_cart'},
    'AjaxFetchTheProducts': {'sync_cart'},
    'AjaxWalletView': {'wallet'},
    'AjaxPgDiscountView': {'pg_disc'},
    'AjaxStoreDiscountPGView': {'store_disc_pg'},
    'AjaxaExclusiveBenefitsView': {'store_exclusive'},
    'AjaxGiftVoucherView': {'gift_voucher'},
    'AjaxCouponView': {'coupon'},
    'AjaxValidateProcessOrderView': {'validatecheckout', 'processorder'},
}

BRIDGE = '''
def cart_post(request,url,payload,headers,**original_options):
    if not selected():
        import requests
        return requests.post(url,json=payload,headers=headers,**original_options)
    modules()
    from legacy_cart_client import post
    return post(request,url,payload,headers,**original_options)
'''

TEMPLATE = '''
{% if screening_origin_enabled %}
<script>
(function () {
  "use strict";
  var counter = "{{ counter_id|escapejs }}", store = "{{ store_id|escapejs }}";
  var paths = new Set([
    "{% url 'ajax-cart' %}", "{% url 'ajax-sync-cart' %}",
    "{% url 'ajax_fetch_the_products' %}", "{% url 'ajax-wallet' %}",
    "{% url 'ajax-pg-discount' %}", "{% url 'ajax-store-discount-pg' %}",
    "{% url 'ajax-exclusive-benefits' %}", "{% url 'ajax-gift-voucher' %}",
    "{% url 'ajax-coupon' %}", "{% url 'ajax-validate-process-order' %}",
    "{% url 'ajax-order' %}"
  ]);
  $.ajaxPrefilter(function (options, original, xhr) {
    var target = new URL(options.url, window.location.href);
    if (target.origin !== window.location.origin || !paths.has(target.pathname) ||
        (options.type || "GET").toUpperCase() !== "POST") return;
    if (!/^[1-9][0-9]{0,18}$/.test(counter) || !/^[1-9][0-9]{0,18}$/.test(store)) {
      xhr.abort(); return;
    }
    var data = typeof options.data === "string" ? new URLSearchParams(options.data) : null;
    if (!data || data.get("store_id") !== store) return;
    if (data.has("counter_id") && data.get("counter_id") !== counter) {
      xhr.abort(); return;
    }
    data.set("counter_id", counter);
    options.data = data.toString();
  });
}());
</script>
{% endif %}
'''


def apply(changes):
    changes = dict(changes)
    path = 'order/views.py'
    original, value = changes[path]
    tree = ast.parse(value)
    lines = value.splitlines(keepends=True)
    starts, position = [], 0
    for line in lines:
        starts.append(position)
        position += len(line.encode())
    raw = value.encode()
    edits, seen = [], set()
    for node in tree.body:
        if not isinstance(node, ast.ClassDef) or node.name not in METHODS:
            continue
        for method in node.body:
            if not isinstance(method, ast.FunctionDef) or method.name not in METHODS[node.name]:
                continue
            calls = [call for call in ast.walk(method) if isinstance(call, ast.Call)
                     and isinstance(call.func, ast.Attribute) and isinstance(call.func.value, ast.Name)
                     and call.func.value.id == 'requests' and call.func.attr == 'post']
            if len(calls) != 1:
                raise RuntimeError('Legacy cart transport boundary changed')
            call = calls[0]
            if (len(call.args) != 1 or not isinstance(call.args[0], ast.Name) or call.args[0].id != 'url'
                    or any(keyword.arg not in ('json', 'headers', 'timeout') for keyword in call.keywords)):
                raise RuntimeError('Legacy cart transport arguments changed')
            arguments = {keyword.arg: keyword.value for keyword in call.keywords}
            if (not isinstance(arguments.get('json'), ast.Name) or arguments['json'].id != 'payload'
                    or not isinstance(arguments.get('headers'), ast.Name) or arguments['headers'].id != 'headers'):
                raise RuntimeError('Legacy cart request shape changed')
            suffix = ''
            if 'timeout' in arguments:
                if not isinstance(arguments['timeout'], ast.Constant) or arguments['timeout'].value != 8:
                    raise RuntimeError('Legacy cart timeout changed')
                suffix = ', timeout=8'
            replacement = '_screening_cart_post(self.request, url, payload, headers'+suffix+')'
            edits.append((starts[call.lineno-1]+call.col_offset, starts[call.end_lineno-1]+call.end_col_offset, replacement.encode()))
            seen.add((node.name, method.name))
    expected = {(name, method) for name, methods in METHODS.items() for method in methods}
    if seen != expected:
        raise RuntimeError('Legacy cart helper set changed')
    for start, end, replacement in sorted(edits, reverse=True):
        raw = raw[:start]+replacement+raw[end:]
    value = raw.decode()
    marker = 'import requests\n'
    if value.count(marker) != 1:
        raise RuntimeError('Legacy cart import boundary changed')
    value = value.replace(marker, marker+'from pos_screening_origin_legacy import cart_post as _screening_cart_post\n', 1)
    changes[path] = (original, value)
    path = 'pos_screening_origin_legacy.py'
    original, value = changes[path]
    if 'def cart_post(' in value:
        raise RuntimeError('Legacy cart bridge already installed')
    changes[path] = (original, value+BRIDGE)
    path = 'order/templates/order/create_order.html'
    original, value = changes[path]
    marker = '{% endblock custom_script %}'
    if value.count(marker) != 1:
        raise RuntimeError('Legacy cart template boundary changed')
    changes[path] = (original, value.replace(marker, TEMPLATE+'\n'+marker, 1))
    return changes
