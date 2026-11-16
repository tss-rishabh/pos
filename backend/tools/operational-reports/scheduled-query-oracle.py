"""Extract original source report SQL for guarded local fixture comparison."""
import ast
from pathlib import Path
import re
import sys
kind,start,end=sys.argv[1:]
if kind not in ['timing','delays','cancellations','tickets','availability'] or not all(re.fullmatch(r'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}',value) for value in [start,end]):raise ValueError('Use validated fixture inputs.')
source=Path(__file__).resolve().parents[4]/'backend-pos-web/report/views.py'
tree=ast.parse(source.read_text());name={'timing':'StoreHyperlocalRecord','delays':'HyperlocalDeliveryReport','cancellations':'HyperlocalCancellationReport','tickets':'CrmTicketStatus','availability':'HyperlocalAvailabilityReport'}[kind]
cls=next(node for node in tree.body if isinstance(node,ast.ClassDef) and node.name==name)
method=next(node for node in cls.body if isinstance(node,ast.FunctionDef) and node.name==('crm_ticket_details' if kind=='tickets' else 'get_count' if kind=='availability' else 'get_data'))
assignment=next(node for node in ast.walk(method) if isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id=='query' for target in node.targets))
parts=[]
for part in assignment.value.values:
    if isinstance(part,ast.Constant):parts.append(part.value)
    else:
        value=ast.unparse(part.value)
        if value=='start_day':parts.append(start)
        elif value=='end_day':parts.append(end)
        else:raise ValueError('Unknown source interpolation.')
query=''.join(parts).replace('tss.hyperlocal_fd_logs','hyperlocal_fd_logs')
sys.stdout.write(query)
