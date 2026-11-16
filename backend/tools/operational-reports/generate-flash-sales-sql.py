"""Extract SQL/CSV contracts with AST only: no Django import, database or network."""
import ast
import hashlib
import json
from pathlib import Path
import re
root=Path(__file__).resolve().parents[2]
source=root.parent.parent/'backend-pos-web/report/datatables/sales_data.py'
cls=next(node for node in ast.parse(source.read_text()).body if isinstance(node,ast.ClassDef) and node.name=='AjaxSalesDataView')
queries={}
for method_name,kind in [('datatables','interactive'),('get_full_queryset','export')]:
    method=next(node for node in cls.body if isinstance(node,ast.FunctionDef) and node.name==method_name)
    for name,target in [('query',kind),('return_query','refunds')]:
        assignment=next(node for node in ast.walk(method) if isinstance(node,ast.Assign) and any(isinstance(item,ast.Name) and item.id==name for item in node.targets))
        parts=[]
        for part in assignment.value.values:
            if isinstance(part,ast.Constant):parts.append(part.value)
            else:
                value=ast.unparse(part.value)
                if value=='selected_store_id_list':parts.append('{{stores}}')
                elif value.startswith(('start_order_date_range_obj.','start_date.')):parts.append('{{start}}')
                elif value.startswith(('end_order_date_range_obj.','end_date.')):parts.append('{{end}}')
                else:raise ValueError('Unexpected source query interpolation.')
        query=re.sub(r'--[^\n]*','', ''.join(parts)).strip().rstrip(';')
        for key in ['start','end']:query=query.replace("'{{"+key+"}}'",'{{'+key+'}}')
        if target in queries and re.sub(r'\s+',' ',queries[target])!=re.sub(r'\s+',' ',query):raise ValueError('Source refund branches diverged.')
        queries[target]=query
method=next(node for node in cls.body if isinstance(node,ast.FunctionDef) and node.name=='do_sales_export')
assignment=next(node for node in method.body if isinstance(node,ast.Assign) and any(isinstance(item,ast.Name) and item.id=='header_mapping' for item in node.targets))
columns=list(ast.literal_eval(assignment.value).items())
(root/'src/modules/operational-reports/flash-sales-sql.ts').write_text('// Generated from inspected source AST; request values are separate bound parameters.\n// Source SHA-256: '+hashlib.sha256(source.read_bytes()).hexdigest()+'\nexport const flashSalesSourceSql='+json.dumps(queries,indent=2)+' as const;\nexport const flashSalesSourceColumns='+json.dumps(columns,indent=2)+' as const;\n')
