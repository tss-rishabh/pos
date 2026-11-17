"""Pinned POS callback/task/helper execution. Network is always a local fake."""
import ast
import asyncio
import datetime
import json
import os
import pathlib
import re
import subprocess
import sys
import types
import textwrap
from urllib.parse import urlsplit, unquote

PIN='78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'
ROOT=pathlib.Path(os.environ.get('WHOLE_ORDER_STATUS_SOURCE_ROOT','../../backend-pos-web')).resolve()
def text(path):
    return subprocess.check_output(['git','-C',str(ROOT),'show',PIN+':'+path],stderr=subprocess.DEVNULL).decode()
def find(path,name):
    if ROOT.is_dir():
        source=text(path)
    else:
        snapshot=json.loads(pathlib.Path('compatibility/upstream/whole-order-status/pos-source.json').read_text())
        if snapshot['pin']!=PIN:raise ValueError('Pinned portable source mismatch.')
        source=textwrap.dedent(snapshot['fragments'][path][name])
    return next(node for node in ast.walk(ast.parse(source)) if isinstance(node,(ast.ClassDef,ast.FunctionDef,ast.AsyncFunctionDef)) and node.name==name)
def main():
    data=json.load(sys.stdin)
    connection=None
    if data.get('url'):
        if not ROOT.is_dir():raise ValueError('Native source parity requires the actual original pinned checkout.')
        url=urlsplit(data['url'])
        if url.scheme!='mysql' or url.hostname not in ['localhost','127.0.0.1'] or not re.fullmatch(r'pos_rewrite_whole_status_[a-zA-Z0-9_]+',url.path[1:]):
            raise ValueError('Use the isolated localhost fixture.')
        import pymysql
        pymysql.install_as_MySQLdb()
        from django.conf import settings
        settings.configure(INSTALLED_APPS=[],DATABASES={'default':{'ENGINE':'django.db.backends.mysql','NAME':url.path[1:],'USER':unquote(url.username or ''),'PASSWORD':unquote(url.password or ''),'HOST':url.hostname,'PORT':url.port or 3306,'OPTIONS':{'init_command':'SET SESSION TRANSACTION READ ONLY'}}},USE_TZ=False,USE_I18N=False,SECRET_KEY='synthetic-fixture')
        import django
        django.setup()
        from django.db import models,connection
        class HasProduct(models.Model):
            id=models.BigIntegerField(primary_key=True)
            order_id=models.BigIntegerField()
            class Meta:
                app_label='whole_status_oracle'
                managed=False
                db_table='has_products'
        with connection.cursor() as cursor:cursor.execute('SET SESSION TRANSACTION READ ONLY')
    results=[]
    for case in data['cases']:
        requests_seen=[]
        class RequestException(Exception):pass
        def post(url,**kwargs):
            requests_seen.append({'path':urlsplit(url).path,'body':kwargs['json'],'timeout':kwargs['timeout'],'headerNames':list(kwargs['headers'].keys())})
            if case.get('transportError'):raise RequestException('synthetic failure')
            def check():
                if case.get('httpStatus',200)>=400:raise RequestException('synthetic status failure')
            return types.SimpleNamespace(raise_for_status=check)
        class Manager:
            def filter(self,**query):
                values=[row for row in data.get('lines',[]) if str(row['orderId'])==str(query['order_id'])]
                return types.SimpleNamespace(values_list=lambda name,flat:[int(row['id']) for row in values])
        hp=HasProduct if connection else types.SimpleNamespace(objects=Manager())
        env={'json':json,'requests':types.SimpleNamespace(post=post,exceptions=types.SimpleNamespace(RequestException=RequestException)),
            'BACKEND_SYNC_API_BASE_URL':'' if case.get('missingEndpoint') else 'https://sync.synthetic.invalid',
            'BACKEND_SYNC_REPO_API_KEY':'synthetic-not-a-live-secret','logger':types.SimpleNamespace(warning=lambda *args:None,info=lambda *args:None,exception=lambda *args:None),
            'HasProduct':hp,'JsonResponse':lambda value:value}
        method=find('helpers/helpers.py','call_status_api')
        helper=ast.ClassDef(name='Helpers',bases=[],keywords=[],body=[method],decorator_list=[])
        exec(compile(ast.fix_missing_locations(ast.Module(body=[helper],type_ignores=[])),'<pinned-status-helper>','exec'),env)
        if case.get('kind')=='task':
            task=find('core/tasks.py','push_vinc_order_for_all');task.decorator_list=[]
            exec(compile(ast.fix_missing_locations(ast.Module(body=[task],type_ignores=[])),'<pinned-status-task>','exec'),env)
            env['push_vinc_order_for_all'](int(case['orderId']))
            result=None
        else:
            def sync_to_async(fn):
                async def wrapped(*args,**kwargs):return await asyncio.to_thread(fn,*args,**kwargs)
                return wrapped
            env['sync_to_async']=sync_to_async
            view=find('order/views.py','AjaxUpdateStatusVincView');view.bases=[];view.body=[node for node in view.body if getattr(node,'name',None)!='as_view']
            exec(compile(ast.fix_missing_locations(ast.Module(body=[view],type_ignores=[])),'<pinned-status-callback>','exec'),env)
            request=types.SimpleNamespace(POST={'order_id':case.get('orderId',0),'platform':case.get('platform','')})
            result=asyncio.run(env['AjaxUpdateStatusVincView']().post(request))
        results.append({'callback':result,'requests':requests_seen})
    if connection:connection.close()
    print(json.dumps(results,ensure_ascii=True))
if __name__=='__main__':
    try:main()
    except Exception:
        sys.stderr.write('WHOLE_ORDER_STATUS_SOURCE_ORACLE_FAILED\n')
        sys.exit(1)
