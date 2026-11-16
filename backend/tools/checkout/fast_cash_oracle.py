"""Read-only source oracle for the original fast-cash finalization helper.

Only --write updates the portable synthetic vectors. No Django startup, DB,
message transport or HTTP client is loaded.
"""
import argparse
import ast
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import subprocess
from types import SimpleNamespace

ROOT=Path(__file__).resolve().parents[2]
SOURCE=ROOT.parent.parent/'backend-pos-web'
REVISION='78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'
VECTORS=ROOT.parent/'frontend/tests/fast-cash-source-vectors.json'


def execute():
    source=subprocess.check_output(['git','show',REVISION+':order/views.py'],cwd=SOURCE,text=True)
    selected=next(node for node in ast.parse(source).body if isinstance(node,ast.ClassDef) and node.name=='AjaxFastCheckoutView')
    method=next(node for node in selected.body if isinstance(node,ast.FunctionDef) and node.name=='complete_transaction')
    cases=[]
    for payable in ['0.01','1.00','99.95','10000.00','99999.99']:
        for received in ['0.00',payable,str(Decimal(payable)+Decimal('0.50'))]:
            cases.append((payable,received,True))
    cases.extend([('0.00','0.00',True),('99.95','100.00',False)])
    output=[]
    for payable,received,success in cases:
        calls=[]
        order=SimpleNamespace(pay_amt=float(payable),order_store=SimpleNamespace(first=lambda:SimpleNamespace(store_id=1)))
        def complete_order(*arguments,**options):
            calls.append({'orderId':str(arguments[0]),'transactionId':arguments[1],'message':arguments[2],'cash':arguments[3],'cashReceived':arguments[4],'online':arguments[5],'storeId':str(arguments[6]),'operatorId':str(arguments[7]),'isTerminal':options['is_terminal']})
            return success
        scope={'Order':SimpleNamespace(objects=SimpleNamespace(filter=lambda **filters:SimpleNamespace(first=lambda:order))),'Helpers':SimpleNamespace(complete_order=complete_order)}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[method],type_ignores=[])),'<pinned-fast-cash-helper>','exec'),scope)
        result=scope['complete_transaction'](SimpleNamespace(request=SimpleNamespace(user=SimpleNamespace(id=44))),9007199254740993,0,float(received),'FAST-ORACLE','Complete')
        output.append({'payable':payable,'received':received,'helperSuccess':success,'result':result,'calls':calls})
    return {'sourceCommit':REVISION,'sourceFileSha256':hashlib.sha256(source.encode()).hexdigest(),'method':'AjaxFastCheckoutView.complete_transaction','cases':output}


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--write',action='store_true');arguments=parser.parse_args()
    vectors=execute();encoded=json.dumps(vectors,indent=2)+'\n'
    if arguments.write:
        VECTORS.write_text(encoded)
    elif not VECTORS.exists() or VECTORS.read_text()!=encoded:
        raise RuntimeError('Saved fast-cash source vectors differ from their pinned original')
    print(json.dumps({'sourceCommit':REVISION,'sourceFileSha256':vectors['sourceFileSha256'],'cases':len(vectors['cases'])}))
