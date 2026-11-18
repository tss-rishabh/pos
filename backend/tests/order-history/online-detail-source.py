"""Literal source timeline plus native ORM projections; no providers or writes.

This is a bounded read-method oracle, not full ShowOnline/template admission.
"""
import ast
import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import types
from urllib.parse import urlsplit, unquote

PIN = '78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'

def main():
    if sys.version_info[:2] != (3, 10):
        raise RuntimeError('DEPLOYMENT_SOURCE_PYTHON_REQUIRED')
    body = json.load(sys.stdin)
    url = urlsplit(body['url'])
    if (url.scheme != 'mysql' or url.hostname != '127.0.0.1' or not url.port
            or url.port == 54777 or not re.fullmatch(r'/pos_rewrite_order_search_[A-Za-z0-9_]+', url.path)):
        raise ValueError('OWNED_NATIVE_SOURCE_REQUIRED')
    root = Path(os.environ['ORDER_SEARCH_SOURCE_ROOT']).resolve()
    raw = subprocess.check_output(['git', '-C', str(root), 'show', PIN + ':helpers/helpers.py'], stderr=subprocess.DEVNULL)
    original = next(node for node in ast.parse(raw).body if isinstance(node, ast.ClassDef) and node.name == 'Helpers')
    original.body = [node for node in original.body if isinstance(node, ast.FunctionDef)
                     and node.name in ['get_online_transaction_log', 'get_order_status_name']]
    import pymysql
    pymysql.install_as_MySQLdb()
    import django
    from django.conf import settings
    from django.apps import AppConfig
    class NativeApp(AppConfig):
        name = 'online_detail_original'
        path = str(Path(__file__).parent)
    package = types.ModuleType('online_detail_original')
    package.__path__ = [str(Path(__file__).parent)]
    apps = types.ModuleType('online_detail_original.apps')
    apps.NativeApp = NativeApp
    sys.modules[package.__name__] = package
    sys.modules[apps.__name__] = apps
    settings.configure(USE_TZ=False, USE_I18N=False, INSTALLED_APPS=['online_detail_original.apps.NativeApp'], DATABASES={'default': {
        'ENGINE':'django.db.backends.mysql', 'NAME':url.path[1:], 'HOST':url.hostname, 'PORT':url.port,
        'USER':unquote(url.username or ''), 'PASSWORD':unquote(url.password or ''),
        'OPTIONS':{'init_command':"SET sql_mode='STRICT_TRANS_TABLES'"}}})
    django.setup()
    from django.db import models, connection
    from django.template.defaultfilters import floatformat
    namespace = {'json':json}
    def model(name, table, fields):
        result = type(name, (models.Model,), {'__module__':__name__, 'Meta':type('Meta', (), {
            'app_label':'online_detail_original', 'db_table':table, 'managed':False}),
            'id':models.BigIntegerField(primary_key=True), **fields})
        namespace[name] = result
        return result
    text = lambda: models.CharField(max_length=255)
    method = model('PaymentMethod','payment_method',{'name':text()})
    model('OrderStatus','order_status',{'order_status':text()})
    user = model('MUser','users',{**{name:text() for name in ['firstname','lastname','email','telephone']},
        'tss_money':models.FloatField(),'tss_points':models.FloatField()})
    order = model('Order','orders',{'payment_methods':models.ForeignKey(method,db_column='payment_method',on_delete=models.DO_NOTHING),
        'user':models.ForeignKey(user,db_column='user_id',on_delete=models.DO_NOTHING),'created_at':models.DateTimeField(),
        **{name:models.FloatField() for name in ['order_amt','pay_amt','tss_money_used','tss_points_used','voucher_amt_used','coupon_amt_used']}})
    model('PosTransactionLog','pos_transaction_logs',{'order_id':models.BigIntegerField(),'store_id':models.BigIntegerField(),
        'order_status':models.BigIntegerField(),'payment_status':models.BigIntegerField(),'user_id':models.BigIntegerField(),
        'pos_user_id':models.BigIntegerField(),'comment':text(),'pay_dict':models.TextField(),'created_at':models.DateTimeField()})
    product = model('Product','products',{'product':text(),'parent_prod_id':models.BigIntegerField()})
    platform = model('OrderPlatform','order_platform',{'name':text()})
    line = model('HasProduct','has_products',{'order':models.ForeignKey(order,db_column='order_id',on_delete=models.DO_NOTHING),
        'product':models.ForeignKey(product,db_column='prod_id',on_delete=models.DO_NOTHING),
        'order_platform':models.ForeignKey(platform,db_column='order_platform_id',on_delete=models.DO_NOTHING),
        'qty':models.BigIntegerField(),'price':models.FloatField(),'gst':models.FloatField(),'status':text()})
    exec(compile(ast.fix_missing_locations(ast.Module(body=[original],type_ignores=[])), '<pinned-original-online-timeline>', 'exec'), namespace)
    with connection.cursor() as cursor:
        cursor.execute('SET SESSION TRANSACTION READ ONLY')
    native = order.objects.get(id=body['orderId'])
    timeline = namespace['Helpers'].get_online_transaction_log(native.id)
    lines = [{'id':str(item.id),'productId':str(item.product_id),'parentProductId':str(item.product.parent_prod_id),
        'name':item.product.product,'quantity':str(item.qty),'amount':item.price,'gst':item.gst,
        'status':item.status,'platform':{'id':str(item.order_platform_id),'name':item.order_platform.name}}
        for item in line.objects.filter(order_id=native.id).order_by('id')]
    result = {'amount':native.order_amt,'payAmount':native.pay_amt,'customerId':str(native.user_id), 'lines':lines,
        'wallet':{'money':str(floatformat(native.user.tss_money,2)), 'points':str(floatformat(native.user.tss_points,2))},
        'timeline':[{'comment':event['comment'],'createdAt':event['created_at'].isoformat(sep=' '),
            'payments':event['pay_dict']} for event in timeline]}
    connection.close()
    print(json.dumps(result))

if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.stderr.write('ORIGINAL_ONLINE_DETAIL_READ_UNAVAILABLE\n')
        raise SystemExit(1)
