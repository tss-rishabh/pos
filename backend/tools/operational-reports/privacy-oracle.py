"""Execute only the original masking helpers, with no Django/network imports."""
import ast
from pathlib import Path
import json
import sys

source=Path(__file__).resolve().parents[4]/'backend-pos-web/helpers/helpers.py'
tree=ast.parse(source.read_text())
cls=next(node for node in tree.body if isinstance(node,ast.ClassDef) and node.name=='Helpers')
cls.body=[node for node in cls.body if isinstance(node,ast.FunctionDef) and node.name in ['mask_name','mask_email','mask_phone']]
scope={}
exec(compile(ast.fix_missing_locations(ast.Module(body=[cls],type_ignores=[])),str(source),'exec'),scope)
helpers=scope['Helpers']
json.dump([{'name':helpers.mask_name(row['name']),'email':helpers.mask_email(row['email']),'phone':helpers.mask_phone(row['phone'])} for row in json.load(sys.stdin)['cases']],sys.stdout)
