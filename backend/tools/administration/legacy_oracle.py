"""Evaluate selected, side-effect-free statements from the unchanged source.

No Django imports, database access, network requests or supplied credentials.
"""
import ast
import datetime
import hashlib
from functools import lru_cache
import json
import re
import csv
from pathlib import Path
import sys
from types import SimpleNamespace

SOURCE = Path(__file__).resolve().parents[4] / 'backend-pos-web'
BACKEND = Path(__file__).resolve().parents[2]
SOURCE_HASHES = {item['path']:item['sha256'] for item in json.loads((BACKEND/'parity/legacy-inventory.json').read_text())['source_hashes']}


@lru_cache(maxsize=32)
def source_tree(file):
    data=(SOURCE/file).read_bytes()
    if hashlib.sha256(data).hexdigest()!=SOURCE_HASHES.get(file):
        raise ValueError(f'Source evidence changed since the recorded baseline: {file}')
    return ast.parse(data.decode())


def method(file, class_name, method_name):
    tree = source_tree(file)
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == class_name)
    return next(n for n in cls.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == method_name)


def run_statements(nodes, variables):
    module = ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[]))
    exec(compile(module, '<legacy-statements>', 'exec'), variables)
    return variables


def assignment(case):
    source = method('users/views.py', 'AssignStoreUserView', 'post')
    selected = []
    for node in source.body:
        if isinstance(node, ast.AugAssign) and isinstance(node.target, ast.Name) and node.target.id == 'submitted_set':
            selected.append(node)
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id in ('store_ids_to_remove', 'store_ids_to_add') for t in node.targets):
            selected.append(node)
        if isinstance(node, ast.If) and isinstance(node.test, ast.BoolOp) and ast.unparse(node.test) == 'store_ids_to_add and store_ids_to_remove':
            selected.append(node)
    scope = {'existing_set': set(case['existing']), 'submitted_set': set(case['submitted']), 'assignable_store_ids': set(case['assignable'])}
    run_statements(selected, scope)
    return {'add': sorted(scope['store_ids_to_add']), 'remove': sorted(scope['store_ids_to_remove']), 'message': scope['msg']}


def storage(case):
    source = method('stores/views.py', 'CreateStorageView', 'post')
    valid_branch = next(n for n in source.body if isinstance(n, ast.If))
    nodes = [n for n in valid_branch.body if isinstance(n, ast.Assign) and any((isinstance(t, ast.Name) and t.id in ('store_name', 'storage_name')) or (isinstance(t, ast.Attribute) and t.attr == 'storage_name') for t in n.targets)]
    target = SimpleNamespace(store=SimpleNamespace(store_name=case['storeName']), storage_name=case['name'])
    run_statements(nodes, {'store_storage': target})
    return target.storage_name


def counter(case):
    source = method('helpers/helpers.py', 'Helpers', 'create_counter')
    source.decorator_list = []
    captured = []
    class Query:
        def __bool__(self): return bool(case['existing'])
        def count(self): return case['existing']
    scope = {'StoreCounter': SimpleNamespace(objects=SimpleNamespace(filter=lambda **kw: Query(), create=lambda **kw: captured.append(kw)))}
    run_statements([source], scope)
    scope['create_counter'](1, 'fixture description')
    return captured[0]['counter_name']


def expiry(case):
    source = method('helpers/helpers.py', 'Helpers', 'time_until_end_of_day')
    source.decorator_list = []
    scope = {'datetime': datetime}
    run_statements([source], scope)
    now = datetime.datetime.fromisoformat(case['local'])
    return (now + datetime.timedelta(seconds=scope['time_until_end_of_day'](now) - 1)).isoformat(timespec='milliseconds')


def catalog(case):
    class Query:
        def __init__(self, rows): self.rows = rows
        def using(self, alias): return self
        def filter(self, **kwargs):
            return Query([row for row in self.rows if all(row.get(key + '_id' if key == 'product' else key) == (value.id if key == 'product' else value) for key, value in kwargs.items())])
        def first(self): return SimpleNamespace(**self.rows[0]) if self.rows else None
        def exists(self): return bool(self.rows)
        def values_list(self, name, flat=False): return Values([row[name] for row in self.rows])
        def __iter__(self): return iter(SimpleNamespace(**row) for row in self.rows)
    class Values:
        def __init__(self, values): self.values = values
        def first(self): return self.values[0] if self.values else None
    product = SimpleNamespace(**case['product'])
    namespace = {'Product': SimpleNamespace(objects=Query(case['products'])), 'ProductBarcode': SimpleNamespace(objects=Query(case['barcodes'])), 'PriceList': SimpleNamespace(objects=Query(case['prices'])), 'json': json, 'READ_DB_ALIAS': 'fixture'}
    names = ['get_price', 'get_spl_price', 'get_exclusive_price']
    for name in names:
        selected = method('core/datatables/store_products_datatable.py', 'AjaxOrderProductsListView', name)
        selected.decorator_list = []
        run_statements([selected], namespace)
    for name in ['barcode', 'first_image_url']:
        selected = method('core/models.py', 'Product', name)
        selected.decorator_list = []
        run_statements([selected], namespace)
    parent = product.parent_prod_id or product.id
    return {'barcode': namespace['barcode'](product), 'price': product.price if not product.parent_prod_id else namespace['get_price'](None, parent), 'specialPrice': product.spl_price if not product.parent_prod_id else namespace['get_spl_price'](None, parent), 'exclusivePrice': namespace['get_exclusive_price'](None, parent), 'image': namespace['first_image_url'](product)}


def terminal(case):
    tree=source_tree('helpers/edc_machine_helpers.py')
    names={'normalize_edc_machine_name','extract_edc_machine_number','build_next_edc_machine_name','is_edc_machine_name_taken'}
    selected=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in names]
    scope={'re':re,'EDC_MACHINE_NAME_PREFIX':'Machine','EDC_MACHINE_NAME_RE':re.compile(r'^\s*machine\s*(\d+)\s*$',re.IGNORECASE)}
    run_statements(selected,scope)
    return {'name':scope['build_next_edc_machine_name'](case['names']),'taken':scope['is_edc_machine_name_taken'](case['name'],case['activeNames'])}


def product_sync(case):
    selected=method('helpers/helpers.py','Helpers','sync_pos_product')
    selected.decorator_list=[]
    calls=[]
    def post(url,**kwargs):
        calls.append({'url':url,'body':json.dumps(kwargs['json'],separators=(',',':')),'headers':kwargs['headers']})
        return SimpleNamespace(status_code=200)
    scope={'MIGRATION_TO_API_V2':case['migration'],'MAIN_API_V2_URL':case['mainBase'],'API_V2_URL':case['legacyBase'],'PRODUCT_SYNC_URI':case['uri'],'requests':SimpleNamespace(post=post),'logger':SimpleNamespace(error=lambda value:None)}
    run_statements([selected],scope)
    scope['sync_pos_product']([int(value) for value in case['productIds']],case.get('troubleshoot',False))
    return calls[0]


def asset_list(case):
    selected=method('core/views.py','DocumentationDetail','get')
    branch=next(node for node in selected.body if isinstance(node,ast.If))
    assignment=next(node for node in branch.body if isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id=='uploaded_document_paths' for target in node.targets))
    scope={'ast':ast,'current_document_object':SimpleNamespace(doc_link=case['value'])}
    run_statements([assignment],scope)
    return scope['uploaded_document_paths']


def order_buffer(case):
    selected = method('core/views.py', 'AjaxOrderBufferUpdate', 'post')
    nodes = [node for node in selected.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'ftr' for target in node.targets) or isinstance(node, ast.Assign) and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name) and node.value.func.id == 'sum']
    scope = {'value': case['value']}
    run_statements(nodes, scope)
    return scope['value']


def settings_notice(case):
    definitions = {
        'buffer.notice': ('AjaxOrderBufferUpdate', 'update_value'),
        'slot.timing.notice': ('PosDeliveryTimingEdit', 'post'),
        'slot.availability.notice': ('AjaxDeliveryTimingUpdate', 'post'),
        'ecommerce.threshold.notice': ('AjaxEcomSettingUpdate', 'update_value'),
        'ecommerce.availability.notice': ('AjaxEcomSettingUpdate', 'update_ecom_delivery'),
    }
    cls, name = definitions[case['kind']]
    selected = method('core/views.py', cls, name)
    statement = next(node for node in ast.walk(selected) if isinstance(node, ast.Assign) and isinstance(node.value, ast.JoinedStr) and any(isinstance(target, ast.Name) and target.id == 'message' for target in node.targets))
    scope = dict(case['variables'])
    scope['self'] = SimpleNamespace(request=SimpleNamespace(user=SimpleNamespace(first_name=case['firstName'], last_name=case['lastName'])))
    run_statements([statement], scope)
    return scope['message']


def stock_csv_template(case):
    selected = method('core/views.py', 'ProductsStockBulkUploadView', 'post')
    return [ast.literal_eval(node.args[0]) for node in ast.walk(selected) if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name) and node.func.value.id == 'csv_data_list' and node.func.attr == 'append']


def stock_csv_reader(case):
    selected = method('helpers/task_helpers.py', 'ProductStockParseCSV', 'product_stock_bulk_csv_import')
    statement = next(node for node in selected.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'cr' for target in node.targets))
    scope = {'csv': csv, 'lines': case['csv'].splitlines(True)}
    run_statements([statement], scope)
    return list(scope['cr'])


def stock_csv_branches(case):
    selected = method('helpers/task_helpers.py', 'ProductStockParseCSV', 'product_stock_bulk_csv_import')
    branch = next(node for node in ast.walk(selected) if isinstance(node, ast.If) and ast.unparse(node.test) == "is_hold != '' and hold_unhold_qty != ''")
    scope = {'is_hold': case['isHold'], 'hold_unhold_qty': case['quantity']}
    first = eval(compile(ast.fix_missing_locations(ast.Expression(branch.test)), '<legacy-stock-hold-guard>', 'eval'), scope)
    second = not first and eval(compile(ast.fix_missing_locations(ast.Expression(branch.orelse[0].test)), '<legacy-stock-unhold-guard>', 'eval'), scope)
    return {'hold': bool(first), 'unhold': bool(second)}


def postal_lookup(case):
    captured = {}
    class Cursor:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def execute(self, statement, parameters): captured.update(statement=statement, parameters=parameters)
        def fetchone(self): return case.get('row')
    selected = method('core/views.py', 'GetLocationByPincodeView', 'get')
    scope = {'connection':SimpleNamespace(cursor=lambda:Cursor()), 'json':json, 'HttpResponse':lambda value,**kwargs:json.loads(value)}
    run_statements([selected], scope)
    response = scope['get'](None, SimpleNamespace(GET={'pincode':case.get('pincode')}))
    return {'response':response, **captured}


def slack_authorize(case):
    tree = source_tree('helpers/slack_helpers.py')
    nodes = [node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in ['slack_redirect_uri','build_slack_authorize_url']]
    from urllib.parse import urlencode
    captured = {}
    def signed(value, salt):
        captured.update(state=value, salt=salt)
        return case['state']
    scope = {'SLACK_CLIENT_ID':case['clientId'],'SLACK_OAUTH_REDIRECT_URI':case['redirectUri'],'SLACK_OAUTH_SALT':'stores.slack.oauth','SLACK_OAUTH_AUTHORIZE_URL':'https://slack.com/oauth/v2/authorize','signing':SimpleNamespace(dumps=signed),'urlencode':urlencode}
    run_statements(nodes, scope)
    url = scope['build_slack_authorize_url'](SimpleNamespace(user=SimpleNamespace(id=case['actorId'])), case['nonce'])
    return {'url':url, **captured}


if __name__ == '__main__':
    payload = json.load(sys.stdin)
    handlers = {'postal-lookup':postal_lookup,'slack-authorize':slack_authorize,'assignment': assignment, 'storage': storage, 'counter': counter, 'expiry': expiry, 'catalog': catalog,'terminal':terminal,'product-sync':product_sync,'asset-list':asset_list,'order-buffer':order_buffer,'settings-notice':settings_notice,'stock-csv-template':stock_csv_template,'stock-csv-reader':stock_csv_reader,'stock-csv-branches':stock_csv_branches}
    result = [handlers[payload['operation']](case) for case in payload['cases']]
    json.dump(result, sys.stdout)
