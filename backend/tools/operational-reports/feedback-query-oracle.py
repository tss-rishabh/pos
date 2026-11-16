"""Extract the pinned source NPS SQL through its real datatable method; no I/O adapters."""
import ast
import datetime
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

root=Path(__file__).resolve().parents[4]/'backend-pos-web'
revision='78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'
source=subprocess.check_output(['git','-C',str(root),'show',revision+':report/datatables/nps_datatable.py'],text=True)
cls=next(node for node in ast.parse(source).body if isinstance(node,ast.ClassDef) and node.name=='AjaxNpsDataListView')
method=next(node for node in cls.body if isinstance(node,ast.FunctionDef) and node.name=='datatables')
method.decorator_list=[]
class Form(dict):
    def getlist(self,key):return self.get(key,[])
class Cursor:
    description=[]
    def __enter__(self):return self
    def __exit__(self,*_):return False
    def execute(self,statement):self.statement=statement
    def fetchall(self):return []
class Paginator:
    def __init__(self,*_):pass
    def page(self,*_):return SimpleNamespace(object_list=[])
class EmptyPage(Exception):pass
class PageNotAnInteger(Exception):pass
queries=[]
for item in json.load(sys.stdin):
    cursor=Cursor()
    user=SimpleNamespace(id=44,user_type=item.get('userType',1))
    form=Form({'order_ids':','.join(item.get('orderIds',[])),'selected_stores[]':item.get('storeIds',[]),'email':item.get('email',''),'order_date_range':'11/01/2026 12:00 AM - 11/01/2026 11:59 PM','start':0,'draw':1,'length':25})
    request=SimpleNamespace(user=user,POST=form)
    store_manager=SimpleNamespace(filter=lambda **_:SimpleNamespace(values_list=lambda *_,**__:item.get('assignedStores',[])))
    scope={'datetime':datetime,'SimpleNamespace':SimpleNamespace,'UserStore':SimpleNamespace(objects=store_manager),'connections':{'reader':SimpleNamespace(cursor=lambda:cursor)},'READ_DB_ALIAS':'reader','Paginator':Paginator,'EmptyPage':EmptyPage,'PageNotAnInteger':PageNotAnInteger,'Helpers':SimpleNamespace(get_mask_data=lambda value,**_:value)}
    exec(compile(ast.fix_missing_locations(ast.Module(body=[method],type_ignores=[])),'<pinned-nps-datatable>','exec'),scope)
    scope['datatables'](SimpleNamespace(request=request),request)
    queries.append(cursor.statement)
json.dump({'source':revision,'queries':queries},sys.stdout)
