"""Pinned feedback bodies on genuine Django QuerySets and isolated native MySQL.

Only unused model fields are projected away. Field declarations, relations,
Meta and product display come from the immutable source AST; no ORM doubles.
Never imports the legacy app or starts its services.
"""
import ast
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import types
from types import SimpleNamespace
from urllib.parse import unquote, urlsplit

PIN = '78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'
ROOT = Path(os.environ['PRODUCT_FEEDBACK_SOURCE_ROOT']).resolve()


def source(path):
    return subprocess.check_output(
        ['git', '-C', str(ROOT), 'show', PIN + ':' + path],
        stderr=subprocess.DEVNULL,
    ).decode()


def definition(path, name):
    return next(n for n in ast.parse(source(path)).body
                if isinstance(n, ast.ClassDef) and n.name == name)


def main():
    body = json.load(sys.stdin)
    for path, route, view in [
        ('order/urls.py', 'ajax-add-feedback/', 'AjaxAddFeedback'),
        ('users/urls.py', 'order-feedback-form/<int:user_id>/<int:order_id>',
         'GetOrderFeedbackFormView'),
    ]:
        calls = [n for n in ast.walk(ast.parse(source(path)))
                 if isinstance(n, ast.Call) and n.args
                 and isinstance(n.args[0], ast.Constant) and n.args[0].value == route]
        assert len(calls) == 1 and view + '.as_view()' in ast.unparse(calls[0])
        owner = definition('order/views.py' if view == 'AjaxAddFeedback' else 'users/views.py', view)
        assert any(isinstance(base, ast.Name) and base.id == 'LoginRequiredMixin'
                   for base in owner.bases)
    url = urlsplit(body['url'])
    if (url.scheme != 'mysql' or url.hostname != '127.0.0.1'
            or not url.port or url.query or url.fragment
            or not re.fullmatch(r'pos_rewrite_feedback_workflow_[a-f0-9]{12}', url.path[1:])):
        raise ValueError('Only the isolated feedback workflow schema is allowed')
    import pymysql
    pymysql.install_as_MySQLdb()
    import django
    from django.conf import settings
    settings.configure(
        SECRET_KEY='synthetic-feedback-oracle-only', INSTALLED_APPS=[],
        USE_TZ=False, USE_I18N=False, TIME_ZONE='Asia/Kolkata',
        DATABASES={'default': {
            'ENGINE': 'django.db.backends.mysql', 'NAME': url.path[1:],
            'HOST': url.hostname, 'PORT': url.port,
            'USER': unquote(url.username or ''), 'PASSWORD': unquote(url.password or ''),
            'OPTIONS': {'charset': 'utf8mb4', 'init_command': "SET sql_mode='STRICT_TRANS_TABLES'"},
        }},
    )
    django.setup()
    from django.db import models, connection
    namespace = {'models': models, '__name__': __name__}

    def model(path, name, fields=None):
        node = definition(path, name)
        if fields is not None:
            node.body = [n for n in node.body if
                         isinstance(n, ast.Assign) and any(isinstance(t, ast.Name)
                         and t.id in fields for t in n.targets)
                         or isinstance(n, ast.ClassDef) and n.name == 'Meta'
                         or isinstance(n, ast.FunctionDef) and n.name == '__str__']
        exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])),
                     '<pinned-feedback-model>', 'exec'), namespace)

    model('order/models.py', 'MUser', {'id'})
    model('core/models.py', 'Product', {'id', 'product'})
    model('order/models.py', 'Order', {'id', 'user', 'order_amt'})
    model('order/models.py', 'HasProduct', {'id', 'order', 'product'})
    model('order/models.py', 'UserProductRating')
    namespace['JsonResponse'] = lambda value: value
    for path, cls, method in [
        ('users/views.py', 'GetOrderFeedbackFormView', 'get_order'),
        ('order/views.py', 'AjaxAddFeedback', 'post'),
    ]:
        node = next(n for n in definition(path, cls).body
                    if isinstance(n, ast.FunctionDef) and n.name == method)
        node.decorator_list = []
        exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])),
                     '<pinned-feedback-body>', 'exec'), namespace)
    query_count = [0]
    insert_count = [0]

    def count(execute, sql, params, many, context):
        query_count[0] += 1
        if sql.lstrip().upper().startswith('INSERT '):
            insert_count[0] += 1
        return execute(sql, params, many, context)

    with connection.execute_wrapper(count):
        if body['action'] == 'write':
            responses = [namespace['post'](None, SimpleNamespace(POST=payload))
                         for payload in body['submissions']]
            result = {'responses': responses}
        elif body['action'] == 'read':
            rows = namespace['get_order'](None, body['customerId'], body['orderId'])
            result = {'orders': [{
                'id': str(row['id']), 'orderAmount': row['order_amt'],
                'items': [{
                    'productId': str(item['id']), 'name': str(item['product']),
                    'feedback': [{'optionId': str(value['product_rating_option_id'])
                                 if value['product_rating_option_id'] is not None else None,
                                 'rating': value['rating'], 'platform': value['platform'],
                                 'comment': value['comment']} for value in item['feedback']],
                } for item in row['items']],
            } for row in rows]}
            # Render the exact feedback template's main block. The surrounding
            # application shell and unused mathfilters import are outside this
            # feature receipt; no CDN scripts or legacy transports execute.
            from django.template import Context, Engine, Library
            filters = types.ModuleType('feedback_oracle_unused_filters')
            filters.register = Library()
            sys.modules[filters.__name__] = filters
            engine = Engine(libraries={
                'mathfilters': filters.__name__, 'static': 'django.templatetags.static',
            }, loaders=[('django.template.loaders.locmem.Loader', {
                'admin/layouts/base.html': '{% block maincontent %}{% endblock %}',
            })])
            result['mainHtml'] = engine.from_string(source(
                'order/templates/order/add_order_feedback.html')).render(Context({
                    'orders': rows, 'user_id': body['customerId'],
                }))
        else:
            raise ValueError('Unknown bounded source action')
    connection.close()
    result['queries'] = query_count[0]
    result['nativeInserts'] = insert_count[0]
    result['sourceHashes'] = {path: hashlib.sha256(source(path).encode()).hexdigest()
                              for path in ['order/urls.py', 'users/urls.py',
                                           'order/models.py', 'core/models.py',
                                           'order/views.py', 'users/views.py',
                                           'order/templates/order/add_order_feedback.html']}
    print(json.dumps(result, ensure_ascii=True))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # No URLs, database diagnostics, request data or local credentials.
        print(json.dumps({'error': 'NATIVE_FEEDBACK_SOURCE_UNAVAILABLE'}))
        raise SystemExit(1)
