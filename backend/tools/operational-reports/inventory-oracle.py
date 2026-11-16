"""Extract only the source inventory-repair SELECT, with integer fixture IDs."""
import ast
from pathlib import Path
import json
import sys
source=Path(__file__).resolve().parents[4]/'backend-pos-web/report/views.py'
tree=ast.parse(source.read_text())
cls=next(node for node in tree.body if isinstance(node,ast.ClassDef) and node.name=='AjaxTroubleshootInventoryView')
query=next(node.value for node in ast.walk(cls) if isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id=='query' for target in node.targets))
expression=compile(ast.Expression(body=query),str(source),'eval')
json.dump([eval(expression,{'store_id':int(store_id)}) for store_id in json.load(sys.stdin)['stores']],sys.stdout)
