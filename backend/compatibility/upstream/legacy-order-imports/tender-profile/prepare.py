"""Generate only owned source vectors with --write; verification is read-only."""
import argparse
import hashlib
import json
from pathlib import Path
from source_tender import VECTORS,PINS,describe,csv_calls,checked

HERE=Path(__file__).resolve().parent


def output():
    for name in PINS:checked(name)
    original={'id':'original-unit-order','lines':[('0.10',5),('0.20',5),('0.10',5)],'gst':0,'productIds':[10,11,10]}
    normalized={'id':'grouped-unit-order','lines':[('0.10',10),('0.20',5)],'gst':0,'productIds':[10,11]}
    values={'evidence':'literal-source-conditional-synthetic-config',
        'webCommit':'78d5b63d6a149a6bf2c748fa1d191799c59ecb8a','apiCommit':'2960acbea10c4eaf16b6d99e15ff6e03ef7724c5',
        'pins':PINS,'vectors':[describe(vector,payment) for vector in VECTORS for payment in ('cash','Card')],
        'aggregationCounterexample':{'originalRaw':csv_calls(original)['rawTender'],'groupedRaw':csv_calls(normalized)['rawTender'],
            'sameDeclaredCurrency':'2.00','sameGroupedLines':[['10',10,'0.10'],['11',5,'0.20']]}}
    return json.dumps(values,indent=2,ensure_ascii=False,allow_nan=False)+'\n'


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--write',action='store_true');args=parser.parse_args()
    result=output();path=HERE/'source-vectors.json'
    if args.write:path.write_text(result)
    elif not path.exists() or path.read_text()!=result:raise RuntimeError('Pinned tender vectors differ.')
    print('source-vectors.json '+hashlib.sha256(result.encode()).hexdigest())
