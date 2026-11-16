"""Execute pinned read-only SQL builders with an inert cursor; no real transport/DB."""
import ast
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

root=Path(__file__).resolve().parents[4]/'backend-pos-web'
revision='78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'
text=subprocess.check_output(['git','-C',str(root),'show',revision+':users/views.py'],text=True)
tree=ast.parse(text)
cls=next(node for node in tree.body if isinstance(node,ast.ClassDef) and node.name=='AjaxUserbehaviourView')
methods=['get_lifetime_exclusive_savings','get_last_orders','get_total_orders','get_nps_score']
class Cursor:
    def execute(self,statement):self.statement=statement
    def fetchone(self):return None
result={}
for name in methods:
    cursor=Cursor()
    method=next(node for node in cls.body if isinstance(node,ast.FunctionDef) and node.name==name)
    method.decorator_list=[]
    scope={'connections':{'mysql_db':SimpleNamespace(cursor=lambda:cursor)}}
    exec(compile(ast.fix_missing_locations(ast.Module(body=[method],type_ignores=[])),'<pinned-customer-history-sql>','exec'),scope)
    args=[None,7]+([30] if name=='get_last_orders' else [])
    scope[name](*args)
    # Only schema qualification changes for the separately guarded isolated local fixture.
    result[name]=cursor.statement.replace('tss.nps_feedback','nps_feedback')
json.dump({'source':revision,'queries':result},sys.stdout)
