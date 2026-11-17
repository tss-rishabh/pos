"""Server-side genuine CSK caller with a private metadata-only journal.

No key/customer/cart/request payload is persisted here. The actual caller keeps
its original business request in its existing private outbox and supplies it on
exact replay. This is not a browser login or an operator capability issuer.
"""
import hashlib
import json
import os
import re
import tempfile
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4
import requests

UUID=re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}')
STATES=('READY','SUBMITTED','KNOWN','SUCCESSOR_SENT','SUCCESSOR_MISSING')


def refused():raise RuntimeError('Check the retained original CSK command and request.') from None
def encoded(value):return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False)


class CSKScreeningClient:
    def __init__(self,endpoint,credential,journal,session=None):
        parsed=urlsplit(endpoint)
        if parsed.scheme!='https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or not parsed.path.endswith('/external/screening-orders'):refused()
        if not callable(credential):refused()
        self.endpoint,self.credential,self.path,self.http=endpoint,credential,Path(journal).resolve(),session or requests.Session()
        self.namespace=hashlib.sha256(endpoint.encode()).hexdigest()
        if self.path.is_symlink() or not self.path.parent.is_dir():refused()
        if self.path.exists() and self.path.stat().st_mode&0o077:refused()
    def read(self):
        if not self.path.exists():return None
        try:
            if self.path.stat().st_size>16000:refused()
            value=json.loads(self.path.read_text())
            if (not isinstance(value,dict) or set(value)!={'v','namespace','requestHash','state','commandId','referenceVersion','successor'}
                    or value['v']!=1 or value['namespace']!=self.namespace or not re.fullmatch(r'[a-f0-9]{64}',value['requestHash']) or value['state'] not in STATES
                    or value['commandId'] is not None and not UUID.fullmatch(value['commandId'])
                    or value['referenceVersion'] is not None and (type(value['referenceVersion']) is not int or value['referenceVersion']<1)):refused()
            successor=value['successor']
            if successor is not None and (not isinstance(successor,dict) or set(successor)!={'id','parentId','version','reason'}
                    or not UUID.fullmatch(successor['id']) or not UUID.fullmatch(successor['parentId']) or type(successor['version']) is not int
                    or successor['version']<1 or successor['reason'] not in ('customer-contact-changed','service-rotation','source-reconciliation')):refused()
            return value
        except Exception:refused()
    def save(self,value):
        raw=encoded(value);fd,name=tempfile.mkstemp(prefix='.screening-origin-',dir=self.path.parent)
        try:
            os.fchmod(fd,0o600)
            with os.fdopen(fd,'w') as output:output.write(raw);output.flush();os.fsync(output.fileno())
            os.replace(name,self.path)
            if self.read()!=value:refused()
        finally:
            if os.path.exists(name):os.unlink(name)
    def request(self,method,path='',body=None):
        credential=self.credential()
        if not isinstance(credential,str) or not credential:refused()
        response=self.http.request(method,self.endpoint+path,headers={'X-CSK-API-Key':credential,'Content-Type':'application/json'},
            json=body,timeout=(5,30),allow_redirects=False,verify=True,stream=True)
        try:
            content=bytearray()
            for chunk in response.iter_content(65536):
                content.extend(chunk)
                if len(content)>1000000:refused()
            value=json.loads(content)
            if not isinstance(value,dict):refused()
            return response.status_code,value
        except Exception:refused()
        finally:response.close()
    def submit(self,payload):
        request_hash=hashlib.sha256(encoded(payload).encode()).hexdigest();value=self.read()
        if value is not None and (value['requestHash']!=request_hash or value['successor'] is not None):refused()
        value=value or {'v':1,'namespace':self.namespace,'requestHash':request_hash,'state':'READY','commandId':None,'referenceVersion':None,'successor':None}
        self.save({**value,'state':'SUBMITTED'})
        # Exact original reference/body is idempotent even if its initial reply
        # was lost before this caller learned the deterministic command ID.
        status,body=self.request('POST',body=payload)
        if status not in (200,202) or not UUID.fullmatch(body.get('commandId','')) or type(body.get('referenceVersion')) is not int:refused()
        self.save({**value,'state':'KNOWN','commandId':body['commandId'],'referenceVersion':body['referenceVersion']});return body
    def status(self):
        value=self.read()
        if value is None or value['commandId'] is None:refused()
        status,body=self.request('GET','/'+value['commandId'])
        if status!=200 or body.get('commandId')!=value['commandId']:refused()
        if value['successor'] is None and type(body.get('referenceVersion')) is int:self.save({**value,'referenceVersion':body['referenceVersion']})
        return body
    def transfer(self,reason,retry_missing=False):
        value=self.read()
        if value is None or value['commandId'] is None or value['referenceVersion'] is None:refused()
        intent=value['successor']
        if intent is None:
            if reason not in ('customer-contact-changed','service-rotation','source-reconciliation'):refused()
            intent={'id':str(uuid4()),'parentId':value['commandId'],'version':value['referenceVersion'],'reason':reason}
            value={**value,'successor':intent,'state':'SUCCESSOR_SENT'};self.save(value)
            dispatch=True
        else:
            if intent['reason']!=reason:refused()
            status,body=self.request('GET','/'+intent['parentId']+'/successors/'+intent['id'])
            if status==200:return self.accept(value,intent,body)
            if status!=404:refused()
            self.save({**value,'state':'SUCCESSOR_MISSING'})
            if not retry_missing:return {'phase':'missing','successorId':intent['id'],'retryRequiresSameCommand':True}
            dispatch=True
        if dispatch:
            status,body=self.request('POST','/'+intent['parentId']+'/successors',{'successorId':intent['id'],'expectedHeadVersion':intent['version'],'reason':intent['reason']})
            if status!=200:refused()
            return self.accept(value,intent,body)
    def accept(self,value,intent,body):
        if body.get('commandId')!=intent['id'] or body.get('parentCommandId')!=intent['parentId'] or body.get('referenceVersion')!=intent['version']+1:refused()
        self.save({**value,'commandId':intent['id'],'referenceVersion':body['referenceVersion'],'successor':None,'state':'KNOWN'});return body
