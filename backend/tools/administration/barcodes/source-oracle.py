"""Pinned source execution; writes ONLY a fresh synthetic localhost fixture schema."""
import ast
import datetime
import hashlib
import json
from pathlib import Path
import re
import sys
from types import SimpleNamespace
from urllib.parse import urlparse, unquote


def main():
    payload=json.load(sys.stdin);url=urlparse(payload['database']);schema=url.path.lstrip('/')
    if url.scheme!='mysql' or url.hostname not in ['127.0.0.1','localhost'] or not re.fullmatch(r'pos_rewrite_barcodes_[a-f0-9]{12}',schema):raise ValueError('ISOLATED_LOCAL_SCHEMA_REQUIRED')
    import django
    import pymysql
    if django.get_version()!='4.2.5':raise ValueError('PINNED_SOURCE_DJANGO_REQUIRED')
    pymysql.install_as_MySQLdb()
    from django.conf import settings
    settings.configure(SECRET_KEY='barcode-fixture',USE_TZ=False,USE_I18N=False,INSTALLED_APPS=[],DATABASES={'default':{'ENGINE':'django.db.backends.mysql','NAME':schema,'HOST':url.hostname,'PORT':str(url.port or 3306),'USER':unquote(url.username or ''),'PASSWORD':unquote(url.password or ''),'OPTIONS':{'charset':'utf8mb4','init_command':"SET sql_mode='STRICT_TRANS_TABLES'"}}})
    django.setup()
    from django.db import models,connection
    from django.http import HttpResponse
    from django.utils import timezone
    timezone.now=lambda:datetime.datetime(2026,6,15,12,0,0)
    class Product(models.Model):
        id=models.BigIntegerField(primary_key=True)
        class Meta:
            app_label='barcode_oracle';db_table='products';managed=False
    class ProductBarcode(models.Model):
        id=models.BigIntegerField(default=0,primary_key=True)
        product=models.ForeignKey(Product,on_delete=models.DO_NOTHING)
        gtin=models.BigIntegerField(default=0)
        created_at=models.DateTimeField(auto_now_add=True)
        updated_at=models.DateTimeField(auto_now=True)
        class Meta:
            app_label='barcode_oracle';db_table='products_gs1';managed=False
    class Activity(models.Model):
        id=models.BigIntegerField(default=0,primary_key=True)
        pos_user_id=models.BigIntegerField(default=0)
        platform=models.CharField(max_length=255)
        comment=models.CharField(max_length=255,null=True,blank=True)
        recipient=models.CharField(max_length=45,default='',null=True,blank=True)
        created_at=models.DateTimeField(auto_now_add=True)
        updated_at=models.DateTimeField(auto_now=True)
        class Meta:
            app_label='barcode_oracle';db_table='pos_special_permission_activity_log';managed=False
    class Country(models.Model):
        id=models.BigIntegerField(primary_key=True)
        name=models.CharField(max_length=255)
        sec_status=models.IntegerField(default=0)
        class Meta:
            app_label='barcode_oracle';db_table='countries';managed=False
    backend=Path(__file__).resolve().parents[3];source=backend.parent.parent/'backend-pos-web'
    hashes={row['path']:row['sha256'] for row in json.loads((backend/'parity/legacy-inventory.json').read_text())['source_hashes']}
    def pinned(filename):
        data=(source/filename).read_bytes()
        if hashlib.sha256(data).hexdigest()!=hashes[filename]:raise ValueError('SOURCE_BASELINE_CHANGED')
        return ast.parse(data)
    views=pinned('core/views.py');helpers=pinned('helpers/helpers.py')
    def source_class(name):
        original=next(row for row in views.body if isinstance(row,ast.ClassDef) and row.name==name)
        return ast.ClassDef(name=name,bases=[],keywords=[],body=[row for row in original.body if isinstance(row,ast.FunctionDef)],decorator_list=[])
    helper_class=next(row for row in helpers.body if isinstance(row,ast.ClassDef) and row.name=='Helpers')
    logger=next(row for row in helper_class.body if isinstance(row,ast.FunctionDef) and row.name=='special_permission_activity_logger')
    helper=ast.ClassDef(name='Helpers',bases=[],keywords=[],body=[logger],decorator_list=[])
    namespace={'Product':Product,'ProductBarcode':ProductBarcode,'PosSpecialPermissionActivityLog':Activity,'Country':Country,'HttpResponse':HttpResponse,'json':json,'logger':SimpleNamespace(exception=lambda *args:None)}
    exec(compile(ast.fix_missing_locations(ast.Module(body=[helper,source_class('AjaxAddBarcodeView'),source_class('GetCountryNameView')],type_ignores=[])),'<pinned-barcode-country-source>','exec'),namespace)
    results=[]
    for case in payload.get('barcodes',[]):
        request=SimpleNamespace(user=SimpleNamespace(id=int(case.get('operatorId','900001'))),POST={'product_id':case['productId'],'barcode':case['barcode']})
        view=namespace['AjaxAddBarcodeView']();view.request=request
        results.append(json.loads(view.post(request).content))
    countries=[]
    for search in payload.get('countries',[]):
        response=namespace['GetCountryNameView']().get(SimpleNamespace(GET={} if search is None else {'q':search}))
        value=json.loads(response.content)
        for row in value['data'].get('country',[]):row['id']=str(row['id'])
        countries.append(value)
    audits=list(Activity.objects.order_by('id').values('platform','comment','recipient','pos_user_id'))
    for audit in audits:audit['pos_user_id']=str(audit['pos_user_id'])
    connection.close()
    json.dump({'hashes':{key:hashes[key]for key in ['core/views.py','helpers/helpers.py']},'barcodes':results,'countries':countries,'audits':audits},sys.stdout)


if __name__=='__main__':
    try:main()
    except Exception as error:
        json.dump({'error':'BARCODE_COUNTRY_SOURCE_ORACLE_FAILED','kind':type(error).__name__},sys.stdout);sys.exit(1)
