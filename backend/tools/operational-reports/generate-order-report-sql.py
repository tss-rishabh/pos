"""Extract inspected pure source report constants; never connect to a database."""
from pathlib import Path
import ast
import hashlib
import json
import runpy

root=Path(__file__).resolve().parents[2]
source=root.parent.parent/'backend-pos-web/report/report_queries.py'
values=runpy.run_path(str(source))
queries={}
for key,kind in [('store','store_orders'),('online','online_orders')]:
 sale,returned,store_alias,sale_date=values['get_order_report_queries'](kind)
 queries[key]={'sales':sale,'returns':returned,'storeAlias':store_alias,'saleDate':sale_date}
target=root/'src/modules/operational-reports/order-report-sql.ts'
target.write_text('// Generated from inspected pure source query constants; preserve business predicates.\n// Source SHA-256: '+hashlib.sha256(source.read_bytes()).hexdigest()+'\nexport const orderReportSql='+json.dumps(queries,ensure_ascii=False,indent=2)+' as const;\nexport const orderReportCategoryJoin='+json.dumps(values['ORDERS_CATEGORY_JOIN'])+';\n')
formatter=root.parent.parent/'backend-pos-web/report/datatables/return_orders_datatable.py'
cls=next(node for node in ast.parse(formatter.read_text()).body if isinstance(node,ast.ClassDef) and node.name=='AjaxOrdersDataListView')
method=next(node for node in cls.body if isinstance(node,ast.FunctionDef) and node.name=='do_order_export')
mapping=next(node for node in method.body if isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id=='header_mapping' for target in node.targets))
columns=list(ast.literal_eval(mapping.value).items())
target=root.parent/'frontend/src/pages/operational-reports/order-report-columns.ts'
target.write_text('// Generated from the source complete CSV column manifest.\n// Source SHA-256: '+hashlib.sha256(formatter.read_bytes()).hexdigest()+'\nexport const orderReportColumns='+json.dumps(columns,ensure_ascii=False,indent=2)+' as const;\n')
