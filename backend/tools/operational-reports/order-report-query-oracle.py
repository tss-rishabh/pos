"""Build exact source combined queries using validated isolated fixture parameters."""
from pathlib import Path
import json
import re
import runpy
import sys
source,date_type,start,end,store=sys.argv[1:]
if source not in ['store','online'] or date_type not in ['order_date','return_date'] or not re.fullmatch(r'\d+',store) or not all(re.fullmatch(r'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}',value) for value in [start,end]):raise ValueError('Use validated fixture inputs.')
values=runpy.run_path(str(Path(__file__).resolve().parents[4]/'backend-pos-web/report/report_queries.py'))
sale,returned,alias,sale_date=values['get_order_report_queries']('store_orders' if source=='store' else 'online_orders')
store_column='s.id' if source=='store' else 'poo.store_id'
return_date=sale_date if date_type=='order_date' else 'COALESCE(ro.created_at,rr.created_at)' if source=='store' else 'COALESCE(ro.created_at,rr.created_at,cm.created_at,hp.updated_at)'
suffix=lambda date:f" AND {date} BETWEEN '{start}' AND '{end}' AND {store_column} IN ({store}) GROUP BY arl.order_id,arl.prod_id,hp.id ORDER BY o.created_at DESC"
print(f'({sale+suffix(sale_date)}) UNION ALL ({returned+suffix(return_date)}) ORDER BY transaction_date DESC,id DESC')
