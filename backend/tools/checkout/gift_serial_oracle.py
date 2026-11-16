"""Generate fixed hash vectors by executing the pinned source helper with a fixture salt.

Run with uv run --with hashids==1.3.1 python tools/checkout/gift_serial_oracle.py.
No production salt, database, network API or issued gift-card values are used.
"""
import argparse
import json
from pathlib import Path
import subprocess

from hashids import Hashids
from legacy_oracle import ROOT, selected_class

def vectors():
    pin = '78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'
    if subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip() != pin:
        raise RuntimeError('Gift serial oracle requires the reviewed source revision')
    salt = 'fixture-gift-card-salt'
    scope = {'Hashids': Hashids, 'GC_SALTKEY': salt}
    exec(selected_class('helpers/helpers.py', 'Helpers', ['get_gift_card']), scope)
    serials = ['990111', '990112', '9950123456789', '9007199254740993', '9223372036854775807']
    return {'sourceCommit': pin, 'pythonHashids': '1.3.1', 'salt': salt, 'cases': [{'serial': serial, 'code': scope['Helpers'].get_gift_card(serial)} for serial in serials]}


if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--write',action='store_true',help='Explicitly regenerate the committed fixture; ordinary verification is read-only.')
    parser.add_argument('--check',action='store_true',help='Compare source output against the saved fixture without rewriting it.')
    arguments=parser.parse_args()
    if arguments.write and arguments.check:
        parser.error('--write and --check are mutually exclusive')
    target = Path(__file__).resolve().parents[2]/'tests/checkout/gift-serial-vectors.json'
    result=vectors()
    if arguments.write:
        target.write_text(json.dumps(result, indent=2)+'\n')
    elif arguments.check:
        if json.loads(target.read_text())!=result:
            raise RuntimeError('Gift serial fixture differs from the pinned source helper')
    else:
        print(json.dumps(result,indent=2))
