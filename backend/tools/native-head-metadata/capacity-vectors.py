"""Generated-only capacity vectors; no database, source rows or credentials."""
import json
from pathlib import Path
import sys

root=Path(__file__).resolve().parents[2]
sys.path[:0]=[str(root/'compatibility/upstream/screening-origins'),str(root/'compatibility/upstream/legacy-order-imports'),str(root/'compatibility/upstream/public-screening-writer')]
from native_head_limits import LIMITS
from origin_history_privileges import caller_grant_values,metadata_document

value=json.loads(sys.stdin.buffer.read(4000001))
if set(value)!={'grants'} or not isinstance(value['grants'],list):raise RuntimeError('Synthetic capacity vectors required')
verdicts=[caller_grant_values(case) is not None for case in value['grants']]
maximum=LIMITS['metadataBytes']
documents=['"'+'a'*(maximum-2)+'"','"'+'a'*(maximum-1)+'"',
    '"'+'é'*((maximum-2)//2)+'"','"'+'é'*(maximum//2)+'"','{','NaN',b'"\xff"']
metadata=[]
for document in documents:
    try:metadata_document(document);metadata.append(True)
    except BaseException:metadata.append(False)
sys.stdout.write(json.dumps({'limits':LIMITS,'grants':verdicts,'metadata':metadata},separators=(',',':')))
