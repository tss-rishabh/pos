"""Execute pinned source datatable methods on an explicitly isolated local MySQL fixture only."""
import ast
import datetime
import hashlib
import json
from pathlib import Path
import re
import sys
import warnings
from types import SimpleNamespace
from urllib.parse import urlparse, unquote


def main():
    payload=json.load(sys.stdin)
    url=urlparse(payload['database'])
    schema=url.path.lstrip('/')
    if url.scheme!='mysql' or url.hostname not in ['127.0.0.1','localhost'] or not re.fullmatch(r'pos_rewrite_activity_history_test_[a-z0-9_]+',schema):
        raise ValueError('ISOLATED_LOCAL_SCHEMA_REQUIRED')
    import django
    import pymysql
    if django.get_version()!='4.2.5':raise ValueError('PINNED_SOURCE_DJANGO_REQUIRED')
    pymysql.install_as_MySQLdb()
    from django.conf import settings
    settings.configure(SECRET_KEY='isolated-history-oracle',USE_TZ=False,USE_I18N=False,INSTALLED_APPS=[],DATABASES={'default':{'ENGINE':'django.db.backends.mysql','NAME':schema,'HOST':url.hostname,'PORT':str(url.port or 3306),'USER':unquote(url.username or ''),'PASSWORD':unquote(url.password or ''),'OPTIONS':{'charset':'utf8mb4'}}})
    django.setup()
    from django.db import models,connection
    from django.db.models import Q
    from django.core.paginator import Paginator,EmptyPage,PageNotAnInteger,UnorderedObjectListWarning
    from django.core.serializers.json import DjangoJSONEncoder
    warnings.filterwarnings('ignore',category=UnorderedObjectListWarning)
    class Activity(models.Model):
        id=models.BigIntegerField(primary_key=True)
        pos_user_id=models.BigIntegerField()
        platform=models.CharField(max_length=255,db_collation='latin1_swedish_ci')
        comment=models.CharField(max_length=255,db_collation='latin1_swedish_ci')
        recipient=models.CharField(max_length=45,null=True,db_collation='latin1_swedish_ci')
        created_at=models.DateTimeField()
        class Meta:
            app_label='isolated_activity_oracle';db_table='pos_special_permission_activity_log';managed=False
    class Operator(models.Model):
        id=models.BigIntegerField(primary_key=True)
        first_name=models.CharField(max_length=150)
        last_name=models.CharField(max_length=150)
        class Meta:
            app_label='isolated_activity_oracle';db_table='pos_user';managed=False
    backend=Path(__file__).resolve().parents[2]
    source=backend.parent.parent/'backend-pos-web'
    name='core/datatables/special_permition_datatable.py'
    data=(source/name).read_bytes()
    expected={item['path']:item['sha256'] for item in json.loads((backend/'parity/legacy-inventory.json').read_text())['source_hashes']}
    if hashlib.sha256(data).hexdigest()!=expected[name]:raise ValueError('SOURCE_BASELINE_CHANGED')
    original=next(node for node in ast.parse(data.decode()).body if isinstance(node,ast.ClassDef) and node.name=='special_permition_datatable_view')
    class RemoveSourcePrint(ast.NodeTransformer):
        def visit_Expr(self,node):
            if isinstance(node.value,ast.Call) and isinstance(node.value.func,ast.Name) and node.value.func.id=='print':return None
            return self.generic_visit(node)
    methods=[RemoveSourcePrint().visit(node) for node in original.body if isinstance(node,ast.FunctionDef) and node.name in ['datatables','get_username_by_id']]
    fixture_class=ast.ClassDef(name='SourceActivityDatatable',bases=[],keywords=[],body=methods,decorator_list=[])
    module=ast.fix_missing_locations(ast.Module(body=[fixture_class],type_ignores=[]))
    namespace={'PosSpecialPermissionActivityLog':Activity,'User':Operator,'Q':Q,'Paginator':Paginator,'EmptyPage':EmptyPage,'PageNotAnInteger':PageNotAnInteger,'datetime':datetime}
    exec(compile(module,'<pinned-source-activity>','exec'),namespace)
    connection.ensure_connection()
    with connection.cursor() as cursor:cursor.execute('SET SESSION TRANSACTION READ ONLY')
    results=[]
    for case_index,case in enumerate(payload['cases']):
        platforms=case.get('platforms',[])
        date_range=''
        if case.get('from') is not None:
            date_range=datetime.date.fromisoformat(case['from']).strftime('%m/%d/%Y')+' - '+datetime.date.fromisoformat(case['to']).strftime('%m/%d/%Y')
        values={'search[value]':case.get('search',''),'order[0][column]':str(case.get('order',{}).get('column',0)),'order[0][dir]':case.get('order',{}).get('direction','asc'),'columns[0][data]':'id','start':str(case.get('start',0)),'draw':str(case.get('draw',1)),'length':str(case.get('length',50)),'platform':'['+', '.join('&#x27;'+name+'&#x27;' for name in platforms)+']','date_range_val':date_range}
        query_count=[0]
        def count_query(execute,sql,params,many,context):query_count[0]+=1;return execute(sql,params,many,context)
        try:
            with connection.execute_wrapper(count_query):result=namespace['SourceActivityDatatable']().datatables(SimpleNamespace(POST=values))
        except Exception as error:
            error.case_index=case_index
            raise
        result['recordsTotal']=str(result['recordsTotal']);result['recordsFiltered']=str(result['recordsFiltered'])
        for row in result['data']:row['id']=str(row['id'])
        result['queryCount']=query_count[0]
        results.append(json.loads(json.dumps(result,cls=DjangoJSONEncoder)))
    connection.close()
    json.dump({'djangoVersion':django.get_version(),'sourceHash':expected[name],'cases':results},sys.stdout)


if __name__=='__main__':
    try:main()
    except Exception as error:
        json.dump({'error':'SOURCE_ACTIVITY_ORACLE_FAILED','kind':type(error).__name__,'caseIndex':getattr(error,'case_index',None)},sys.stdout)
        sys.exit(1)
