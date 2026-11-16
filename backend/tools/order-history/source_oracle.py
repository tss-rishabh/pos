"""Pinned source datatable filtering only, with an instrumented synthetic ORM.

This does not certify the whole source datatable's additional filters/columns.
No source settings/database/imports, customer rows or logging are loaded.
"""
import ast
import datetime
import json
import pathlib
import subprocess
import types

PIN = '78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'
ROOT = pathlib.Path(__file__).resolve().parents[4] / 'backend-pos-web'


def main():
    text = subprocess.check_output(['git','-C',str(ROOT),'show',PIN+':order/datatables/orders_datatable.py'],text=True)
    owner = next(node for node in ast.parse(text).body if isinstance(node,ast.ClassDef) and node.name=='AjaxOrderListView')
    method = next(node for node in owner.body if isinstance(node,ast.FunctionDef) and node.name=='datatables')
    module = ast.fix_missing_locations(ast.Module(body=[ast.ClassDef(name='AjaxOrderListView',bases=[],keywords=[],body=[method],decorator_list=[])],type_ignores=[]))
    calls=[]

    class Query:
        def filter(self,**fields):
            calls.append(['filter',fields]);return self
        def exclude(self,**fields):
            calls.append(['exclude',fields]);return self
        def exists(self):return True
        def order_by(self,value):calls.append(['sort',value]);return self
        def count(self):return 0

    class Post(dict):
        def getlist(self,name):return ['1'] if name=='selected_stores[]' else []

    class Paginator:
        def __init__(self,query,length):pass
        def page(self,index):return types.SimpleNamespace(object_list=[])

    scope={'Order':types.SimpleNamespace(objects=Query()),'Helpers':types.SimpleNamespace(get_checkin_data=lambda user:(1,1)),
        'datetime':datetime,'Paginator':Paginator,'PageNotAnInteger':RuntimeError,'EmptyPage':RuntimeError}
    exec(compile(module,'pinned/orders_datatable.py','exec'),scope)
    view=scope['AjaxOrderListView']()
    request=types.SimpleNamespace(user=types.SimpleNamespace(id=1,role=2,user_type=1),POST=Post({
        'order_type':'ST','start':'0','length':'30','draw':'1','order[0][column]':'0','columns[0][data]':'id','order[0][dir]':'desc',
        'order_date_range':'11/16/2026 12:00 AM - 11/16/2026 11:59 PM'}))
    view.request=request
    result=view.datatables(request)
    print(json.dumps({'pin':PIN,'calls':calls,'result':result},default=lambda value:value.strftime('%Y-%m-%d %H:%M:%S')))


if __name__=='__main__':main()
