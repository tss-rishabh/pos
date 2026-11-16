"""Execute pinned source QR verification with PyOTP2.9.0 and an isolated Redis double."""
import ast
import copy
import datetime
import json
import os
import sys
import time
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'resources/auth/pyotp-2.9.0'))
import pyotp

SOURCE=ROOT.parent.parent/'backend-pos-web/users/views.py'
tree=ast.parse(SOURCE.read_text())
selected=copy.deepcopy(next(node for node in tree.body if isinstance(node,ast.ClassDef) and node.name=='MPosLogin'))
selected.bases=[]
selected.keywords=[]
selected.decorator_list=[]
selected.body=[node for node in selected.body if isinstance(node,ast.FunctionDef) and node.name in ('mpos_check_otp','create_secret')]
os.environ['TZ']='UTC'
if hasattr(time,'tzset'): time.tzset()
OriginalDatetime=datetime.datetime

class FakeRedis:
    def __init__(self,secret): self.values={'auth_qr_101':secret};self.ttl=None
    def exists(self,key): return key in self.values
    def get(self,key): return self.values[key].encode()
    def delete(self,key): self.values.pop(key,None)
    def set(self,key,value,ex): self.values[key]=value;self.ttl=ex

output=[]
for case in json.load(sys.stdin):
    timestamp=case['timestamp']/1000
    class Clock(OriginalDatetime):
        @classmethod
        def now(cls,tz=None): return cls.fromtimestamp(timestamp,tz)
    pyotp.totp.datetime.datetime=Clock
    pyotp.random_base32=lambda:'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'
    cache=FakeRedis(case['secret'])
    namespace={'pyotp':pyotp,'redis_instance':cache,'POS_AUTH_QR_EXP_SEC':case['period'],'POS_AUTH_USER_SECRET_EXP':1800}
    exec(compile(ast.fix_missing_locations(ast.Module(body=[selected],type_ignores=[])),str(SOURCE),'exec'),namespace)
    generated=pyotp.TOTP(case['secret'],interval=case['period']).now()
    accepted=namespace['MPosLogin']().mpos_check_otp(101,case.get('code',generated))
    output.append({'code':generated,'accepted':bool(accepted),'rotated':cache.values['auth_qr_101']!=case['secret'],'ttl':cache.ttl})
json.dump(output,sys.stdout)
